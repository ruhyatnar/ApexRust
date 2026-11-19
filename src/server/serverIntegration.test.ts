import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrderHistoryDatabase } from '../engine/orderDatabase';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      assert.ok(addr && typeof addr !== 'string');
      const p = addr.port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(
  url: string,
  headers: Record<string, string>,
  child: ChildProcess,
  getStderr: () => string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server.ts exited early with code ${child.exitCode}; stderr=${getStderr()}`);
    }
    try {
      const resp = await fetch(url, { headers });
      if (resp.ok) return;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}; stderr=${getStderr()}`);
}

test('server.ts Express integration: Binance v3->v2 fallback, Spot reduceOnly exit, preflight order, EXPIRED_IN_MATCH, and partial-fill cancel SQLite persistence', async () => {
  const recordedCalls: Array<{ method: string; pathname: string; query: URLSearchParams }> = [];
  let futuresPreflightShouldFail = false;
  let futuresOrderMode: 'filled' | 'expired_in_match' | 'resting' = 'filled';
  let cancelMode: 'partial_200' | 'race_2011_expired_partial' = 'partial_200';

  const mockBinance = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const mergedParams = new URLSearchParams(u.search);
      if (bodyStr && !bodyStr.startsWith('{')) {
        for (const [k, v] of new URLSearchParams(bodyStr).entries()) {
          mergedParams.set(k, v);
        }
      }
      recordedCalls.push({ method: req.method ?? 'GET', pathname: u.pathname, query: mergedParams });

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-mbx-used-weight-1m': '10' });
        res.end(JSON.stringify(payload));
      };

      // Time endpoints
      if (u.pathname === '/api/v3/time' || u.pathname === '/fapi/v1/time') {
        return sendJson(200, { serverTime: Date.now() });
      }

      // Exchange info
      if (u.pathname === '/api/v3/exchangeInfo' || u.pathname === '/fapi/v1/exchangeInfo') {
        return sendJson(200, {
          symbols: [
            {
              symbol: 'BTCUSDT',
              status: 'TRADING',
              baseAsset: 'BTC',
              quoteAsset: 'USDT',
              quotePrecision: 2,
              filters: [
                { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
                { filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
                { filterType: 'MARKET_LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
                { filterType: 'MIN_NOTIONAL', minNotional: '5' },
              ],
            },
          ],
        });
      }

      // Book ticker / price
      if (u.pathname === '/api/v3/ticker/bookTicker' || u.pathname === '/fapi/v1/ticker/bookTicker') {
        return sendJson(200, { symbol: 'BTCUSDT', bidPrice: '50000.00', askPrice: '50001.00' });
      }

      // Futures verify: v3 returns 404 to prove automatic fallback to v2!
      if (u.pathname === '/fapi/v3/account') {
        return sendJson(404, { code: -1000, msg: 'v3 account not enabled on mock testnet' });
      }
      if (u.pathname === '/fapi/v2/account') {
        return sendJson(200, {
          canTrade: true,
          assets: [{ asset: 'USDT', availableBalance: '5000.00', walletBalance: '5000.00', initialMargin: '0' }],
        });
      }
      if (u.pathname === '/fapi/v1/positionSide/dual') {
        return sendJson(200, { dualSidePosition: false });
      }
      if (u.pathname === '/api/v3/account') {
        return sendJson(200, {
          canTrade: true,
          permissions: ['SPOT'],
          balances: [
            { asset: 'USDT', free: '5000.00', locked: '0' },
            { asset: 'BTC', free: '0.1', locked: '0' },
          ],
        });
      }

      // Futures preflight test order
      if (u.pathname === '/fapi/v1/order/test') {
        if (futuresPreflightShouldFail) {
          return sendJson(400, { code: -2019, msg: 'Margin is insufficient.' });
        }
        return sendJson(200, {});
      }
      if (u.pathname === '/api/v3/order/test') {
        return sendJson(200, {});
      }
      if (u.pathname === '/fapi/v1/marginType' || u.pathname === '/fapi/v1/leverage') {
        return sendJson(200, { code: 200, msg: 'success' });
      }

      // Spot order
      if (u.pathname === '/api/v3/order' && req.method === 'POST') {
        const side = mergedParams.get('side');
        if (side === 'BUY') {
          return sendJson(200, {
            symbol: 'BTCUSDT',
            orderId: 70001,
            clientOrderId: 'spot-buy-1',
            status: 'FILLED',
            type: 'MARKET',
            side: 'BUY',
            origQty: '0.0020',
            executedQty: '0.0020',
            cummulativeQuoteQty: '100.00',
            fills: [
              { price: '50000.00', qty: '0.0010', commission: '0.000001', commissionAsset: 'BTC' },
              { price: '50000.00', qty: '0.0010', commission: '0.0005', commissionAsset: 'BNB' },
            ],
          });
        }
        return sendJson(200, {
          symbol: 'BTCUSDT',
          orderId: 70002,
          clientOrderId: 'spot-sell-exit-1',
          status: 'FILLED',
          type: 'MARKET',
          side: 'SELL',
          origQty: '0.0020',
          executedQty: '0.0020',
          cummulativeQuoteQty: '101.00',
          fills: [{ price: '50500.00', qty: '0.0020', commission: '0.10', commissionAsset: 'USDT' }],
        });
      }

      // Futures order
      if (u.pathname === '/fapi/v1/order' && req.method === 'POST') {
        if (futuresOrderMode === 'expired_in_match') {
          return sendJson(200, {
            symbol: 'BTCUSDT',
            orderId: 80001,
            clientOrderId: 'fut-stp-1',
            status: 'EXPIRED_IN_MATCH',
            type: 'LIMIT',
            side: 'BUY',
            price: '50000.00',
            avgPrice: '0',
            origQty: '0.0020',
            executedQty: '0',
            cumQuote: '0',
          });
        }
        if (futuresOrderMode === 'resting') {
          const oid = cancelMode === 'partial_200' ? 80002 : 80003;
          return sendJson(200, {
            symbol: 'BTCUSDT',
            orderId: oid,
            clientOrderId: `fut-rest-${oid}`,
            status: 'NEW',
            type: 'LIMIT',
            side: 'BUY',
            price: '48000.00',
            avgPrice: '0',
            origQty: '0.0020',
            executedQty: '0',
            cumQuote: '0',
          });
        }
        return sendJson(200, {
          symbol: 'BTCUSDT',
          orderId: 80000,
          clientOrderId: 'fut-fill-1',
          status: 'FILLED',
          type: 'MARKET',
          side: 'BUY',
          avgPrice: '50000.00',
          origQty: '0.0020',
          executedQty: '0.0020',
          cumQuote: '100.00',
        });
      }

      // Futures DELETE /fapi/v1/order & GET /fapi/v1/order
      if (u.pathname === '/fapi/v1/order' && req.method === 'DELETE') {
        if (cancelMode === 'partial_200') {
          return sendJson(200, {
            symbol: 'BTCUSDT',
            orderId: Number(mergedParams.get('orderId')),
            status: 'CANCELED',
            executedQty: '0.0010',
            avgPrice: '48000.00',
            cumQuote: '48.00',
          });
        }
        return sendJson(400, { code: -2011, msg: 'Unknown order sent.' });
      }
      if (u.pathname === '/fapi/v1/order' && req.method === 'GET') {
        return sendJson(200, {
          symbol: 'BTCUSDT',
          orderId: Number(mergedParams.get('orderId')),
          status: 'EXPIRED',
          executedQty: '0.0005',
          avgPrice: '48010.00',
          cumQuote: '24.005',
        });
      }

      // Futures cancel open brackets: -2011 benign race
      if (u.pathname === '/fapi/v1/algoOrder' && req.method === 'DELETE') {
        return sendJson(400, { code: -2011, msg: 'Unknown algo order' });
      }
      if (u.pathname === '/fapi/v1/openAlgoOrders' && req.method === 'GET') {
        return sendJson(200, []);
      }

      return sendJson(404, { error: `Unhandled mock path: ${req.method} ${u.pathname}` });
    });
  });

  await new Promise<void>((resolve) => mockBinance.listen(0, '127.0.0.1', () => resolve()));
  const mockAddr = mockBinance.address();
  assert.ok(mockAddr && typeof mockAddr !== 'string');
  const mockBase = `http://127.0.0.1:${mockAddr.port}`;

  const serverPort = await getFreePort();
  const serverBase = `http://127.0.0.1:${serverPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexrust-server-int-'));
  const dbPath = path.join(tmpDir, 'orders.sqlite');
  const token = 'test-proxy-secret-integration-token-1234567890';
  const authHeaders = {
    'content-type': 'application/json',
    'x-apexrust-token': token,
    'x-apexrust-client-id': 'int-test-client',
  };

  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      APEXRUST_PROXY_TOKEN: token,
      APEXRUST_ENGINE_AUTHORITY: 'browser',
      APEXRUST_ORDER_DB_PATH: dbPath,
      BINANCE_SPOT_TESTNET_REST: mockBase,
      BINANCE_FUTURES_TESTNET_REST: mockBase,
      BINANCE_ENVIRONMENT: 'Testnet',
      BINANCE_VENUE: 'Futures',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout?.on('data', (c: Buffer) => {
    stdoutBuf += c.toString('utf8');
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderrBuf += c.toString('utf8');
  });

  const api = async (method: string, route: string, body?: unknown) => {
    const resp = await fetch(`${serverBase}${route}`, {
      method,
      headers: authHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await resp.json()) as Record<string, unknown>;
    return { status: resp.status, json };
  };

  try {
    await waitForServer(`${serverBase}/api/live/config`, authHeaders, child, () => `${stderrBuf}\nSTDOUT:\n${stdoutBuf}`);

    // 1. Configure + Verify Futures (tests /fapi/v3/account 404 -> /fapi/v2/account fallback!)
    const cfgRes = await api('POST', '/api/live/config', {
      environment: 'Testnet',
      venue: 'Futures',
      apiKey: 'mock-key-123456',
      apiSecret: 'mock-secret-abcdef',
      requirePreflightTestOrder: true,
      maxOrderNotionalUsdt: 500,
    });
    assert.equal(cfgRes.status, 200);

    const verifyRes = await api('POST', '/api/live/verify', {});
    assert.equal(verifyRes.status, 200, `verify failed: ${JSON.stringify(verifyRes.json)}`);
    assert.equal(verifyRes.json.ok, true);
    assert.equal(recordedCalls.some((c) => c.pathname === '/fapi/v3/account'), true);
    assert.equal(recordedCalls.some((c) => c.pathname === '/fapi/v2/account'), true);

    // Acquire lease and arm
    const leaseRes = await api('POST', '/api/live/lease', { clientId: 'int-test-client' });
    assert.equal(leaseRes.status, 200);
    const armRes = await api('POST', '/api/live/arm', { armed: true });
    assert.equal(armRes.status, 200);

    // 2. Futures preflight failure must NEVER mutate /fapi/v1/marginType or /fapi/v1/leverage
    recordedCalls.length = 0;
    futuresPreflightShouldFail = true;
    const preflightFailRes = await api('POST', '/api/live/order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: 100,
    });
    assert.equal(preflightFailRes.status, 400);
    assert.equal(recordedCalls.some((c) => c.pathname === '/fapi/v1/order/test'), true);
    assert.equal(recordedCalls.some((c) => c.pathname === '/fapi/v1/marginType'), false);
    assert.equal(recordedCalls.some((c) => c.pathname === '/fapi/v1/leverage'), false);
    futuresPreflightShouldFail = false;

    // 3. Futures EXPIRED_IN_MATCH must NOT normalize to FILLED
    futuresOrderMode = 'expired_in_match';
    const stpRes = await api('POST', '/api/live/order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: 50000,
      quantity: 0.002,
      timeInForce: 'GTC',
    });
    assert.equal(stpRes.status, 200);
    assert.equal(stpRes.json.orderStatus, 'EXPIRED_IN_MATCH');
    assert.equal(stpRes.json.executedQty, 0);

    // 4. Resting order + HTTP 200 cancel with executedQty > 0 -> preserves PARTIALLY_FILLED in response AND SQLite!
    futuresOrderMode = 'resting';
    cancelMode = 'partial_200';
    const rest1 = await api('POST', '/api/live/order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: 48000,
      quantity: 0.002,
      timeInForce: 'GTC',
    });
    assert.equal(rest1.status, 200);
    assert.equal(rest1.json.orderStatus, 'NEW');

    const cancelPartial200 = await api('POST', '/api/live/cancel-order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      orderId: '80002',
    });
    assert.equal(cancelPartial200.status, 200);
    assert.equal(cancelPartial200.json.alreadyFilled, true);
    assert.equal(cancelPartial200.json.partiallyFilled, true);
    assert.equal(cancelPartial200.json.status, 'PARTIALLY_FILLED');
    assert.equal(cancelPartial200.json.executedQty, 0.001);

    // 5. Resting order + -2011 cancel race with GET /fapi/v1/order returning EXPIRED & executedQty > 0 -> preserves PARTIALLY_FILLED!
    cancelMode = 'race_2011_expired_partial';
    const rest2 = await api('POST', '/api/live/order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: 48000,
      quantity: 0.002,
      timeInForce: 'GTC',
    });
    assert.equal(rest2.status, 200);

    const cancelRace = await api('POST', '/api/live/cancel-order', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      orderId: '80003',
    });
    assert.equal(cancelRace.status, 200);
    assert.equal(cancelRace.json.alreadyFilled, true);
    assert.equal(cancelRace.json.partiallyFilled, true);
    assert.equal(cancelRace.json.executedQty, 0.0005);

    // 6. Cancel open brackets with benign -2011 returns 200 ok
    const cancelBracketRes = await api('POST', '/api/live/cancel-open-brackets', {
      venue: 'Futures',
      symbol: 'BTCUSDT',
      algoOrderIds: ['99999'],
    });
    assert.equal(cancelBracketRes.status, 200);
    assert.equal(cancelBracketRes.json.ok, true);

    // 7. Spot: SELL without reduceOnly rejected 400; SELL with reduceOnly accepted without sending reduceOnly to Binance; BUY returns exact baseCommission
    recordedCalls.length = 0;
    const spotShortBlocked = await api('POST', '/api/live/order', {
      venue: 'Spot',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.002,
    });
    assert.equal(spotShortBlocked.status, 400);

    const spotBuy = await api('POST', '/api/live/order', {
      venue: 'Spot',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: 100,
    });
    assert.equal(spotBuy.status, 200);
    assert.equal(spotBuy.json.baseCommission, 0.000001); // BTC only, NOT summed with BNB 0.0005!

    recordedCalls.length = 0;
    const spotSellExit = await api('POST', '/api/live/order', {
      venue: 'Spot',
      symbol: 'BTCUSDT',
      side: 'SELL',
      reduceOnly: true,
      type: 'MARKET',
      quantity: 0.002,
    });
    assert.equal(spotSellExit.status, 200);
    const spotSellCall = recordedCalls.find((c) => c.pathname === '/api/v3/order' && c.method === 'POST');
    assert.ok(spotSellCall, 'expected POST /api/v3/order call');
    assert.equal(spotSellCall.query.has('reduceOnly'), false, 'Spot REST order must NEVER receive reduceOnly');

    // Graceful SIGTERM shutdown must close HTTP + SQLite cleanly with exit code 0
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`server.ts did not exit cleanly on SIGTERM; stderr=${stderrBuf}`));
      }, 6000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.kill('SIGTERM');
    });
    assert.equal(exitCode, 0, `expected clean SIGTERM exit 0, got ${exitCode}; stderr=${stderrBuf}`);

    // Inspect SQLite database directly from disk to verify all persisted rows!
    const db = new OrderHistoryDatabase({ dbPath, legacyJsonPath: path.join(tmpDir, 'none.json') });
    const logs = db.getAllLogs();
    const row80002 = logs.find((l) => l.orderId === '80002');
    const row80003 = logs.find((l) => l.orderId === '80003');
    const rowSpotExit = logs.find((l) => l.orderId === '70002');
    assert.equal(row80002?.status, 'PARTIALLY_FILLED');
    assert.equal(row80002?.executedQty, 0.001);
    assert.equal(row80003?.status, 'PARTIALLY_FILLED');
    assert.equal(row80003?.executedQty, 0.0005);
    assert.equal(rowSpotExit?.lifecycle, 'EXIT');
    assert.equal(rowSpotExit?.side, 'Long');
    db.close();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    mockBinance.closeAllConnections();
    await new Promise<void>((resolve) => mockBinance.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
