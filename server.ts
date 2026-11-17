import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';

dotenv.config();

type BinanceEnv = 'Testnet' | 'Production';
type AuthMethod = 'HMAC-SHA256' | 'Ed25519';

interface ServerVaultState {
  environment: BinanceEnv;
  authMethod: AuthMethod;
  apiKey: string;
  apiSecret: string;
  recvWindowMs: number;
  maxOrderNotionalUsdt: number;
  requirePreflightTestOrder: boolean;
  armedForLiveOrders: boolean;
  verificationStatus: 'unverified' | 'verified' | 'error';
  verificationMessage: string | null;
  lastVerifiedAt: string | null;
  canTrade: boolean;
  permissions: string[];
  latencyMs: number | null;
  syncedBalances: Array<{ asset: string; free: number; locked: number }>;
}

const TRACKED_ASSETS = new Set(['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'AVAX']);

const initialEnv: BinanceEnv =
  process.env.BINANCE_ENVIRONMENT === 'Production' ? 'Production' : 'Testnet';
const initialAuth: AuthMethod =
  process.env.BINANCE_AUTH_METHOD === 'Ed25519' ? 'Ed25519' : 'HMAC-SHA256';
const initialKey = (process.env.BINANCE_API_KEY ?? '').trim();
const initialSecret =
  (initialAuth === 'Ed25519'
    ? process.env.BINANCE_ED25519_PRIVATE_KEY
    : process.env.BINANCE_API_SECRET) ?? '';

const vault: ServerVaultState = {
  environment: initialEnv,
  authMethod: initialAuth,
  apiKey: initialKey,
  apiSecret: initialSecret.trim(),
  recvWindowMs: 5000,
  maxOrderNotionalUsdt: 250,
  requirePreflightTestOrder: true,
  armedForLiveOrders: false,
  verificationStatus: 'unverified',
  verificationMessage: null,
  lastVerifiedAt: null,
  canTrade: false,
  permissions: [],
  latencyMs: null,
  syncedBalances: [],
};

function maskApiKey(key: string): string | null {
  const clean = key.trim();
  if (!clean) return null;
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  return `${clean.slice(0, 4)}••••••${clean.slice(-4)}`;
}

function getSafeStatus() {
  return {
    configured: vault.apiKey.length > 0 && vault.apiSecret.length > 0,
    environment: vault.environment,
    authMethod: vault.authMethod,
    apiKeyMasked: maskApiKey(vault.apiKey),
    recvWindowMs: vault.recvWindowMs,
    maxOrderNotionalUsdt: vault.maxOrderNotionalUsdt,
    requirePreflightTestOrder: vault.requirePreflightTestOrder,
    armedForLiveOrders: vault.armedForLiveOrders,
    verificationStatus: vault.verificationStatus,
    verificationMessage: vault.verificationMessage,
    lastVerifiedAt: vault.lastVerifiedAt,
    canTrade: vault.canTrade,
    permissions: vault.permissions,
    latencyMs: vault.latencyMs,
    syncedBalances: vault.syncedBalances,
  };
}

function getRestBaseUrl(env: BinanceEnv): string {
  return env === 'Production'
    ? 'https://api.binance.com'
    : 'https://testnet.binance.vision';
}

function signPayload(queryString: string, authMethod: AuthMethod, secret: string): string {
  if (authMethod === 'Ed25519') {
    const keyObj = crypto.createPrivateKey(secret);
    return crypto.sign(null, Buffer.from(queryString, 'utf8'), keyObj).toString('base64');
  }
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

interface SymbolFilters {
  tickSize: number;
  tickDecimals: number;
  stepSize: number;
  stepDecimals: number;
  fetchedAtMs: number;
}

const symbolFilterCache = new Map<string, SymbolFilters>();

function countStepDecimals(stepStr: string): number {
  if (!stepStr || !stepStr.includes('.')) return 0;
  const trimmed = stepStr.replace(/0+$/, '');
  const parts = trimmed.split('.');
  return parts[1] ? parts[1].length : 0;
}

function floorToStep(value: number, stepSize: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (stepSize > 0) {
    const steps = Math.floor((value + stepSize * 1e-9) / stepSize);
    const floored = steps * stepSize;
    return floored.toFixed(decimals);
  }
  return value.toFixed(decimals);
}

async function getSymbolFilters(symbol: string, fallbackPrice: number): Promise<SymbolFilters> {
  const key = `${vault.environment}:${symbol}`;
  const cached = symbolFilterCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < 600_000) {
    return cached;
  }

  try {
    const baseUrl = getRestBaseUrl(vault.environment);
    const resp = await fetch(`${baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        symbols?: Array<{
          filters?: Array<{
            filterType?: string;
            tickSize?: string;
            stepSize?: string;
          }>;
        }>;
      };
      const filters = payload.symbols?.[0]?.filters ?? [];
      const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
      const tickSize = Number(priceFilter?.tickSize ?? '0') || (fallbackPrice >= 100 ? 0.01 : 0.0001);
      const stepSize = Number(lotFilter?.stepSize ?? '0') || 0.00001;
      const resolved: SymbolFilters = {
        tickSize,
        tickDecimals: countStepDecimals(priceFilter?.tickSize ?? (fallbackPrice >= 100 ? '0.01' : '0.0001')),
        stepSize,
        stepDecimals: countStepDecimals(lotFilter?.stepSize ?? '0.00001'),
        fetchedAtMs: Date.now(),
      };
      symbolFilterCache.set(key, resolved);
      return resolved;
    }
  } catch {
    // Fallback to safe heuristic precision below if exchangeInfo cannot be reached
  }

  const tickDecimals = fallbackPrice >= 100 ? 2 : 4;
  return {
    tickSize: Math.pow(10, -tickDecimals),
    tickDecimals,
    stepSize: 0.00001,
    stepDecimals: 5,
    fetchedAtMs: Date.now(),
  };
}

async function signedBinanceRequest(
  method: 'GET' | 'POST' | 'DELETE',
  endpointPath: string,
  params: Record<string, string | number>
) {
  const baseUrl = getRestBaseUrl(vault.environment);
  const allParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    allParams.set(k, String(v));
  }
  allParams.set('recvWindow', String(vault.recvWindowMs));
  allParams.set('timestamp', String(Date.now()));

  const query = allParams.toString();
  const signature = signPayload(query, vault.authMethod, vault.apiSecret);
  const signedQuery = `${query}&signature=${encodeURIComponent(signature)}`;

  const url =
    method === 'GET' || method === 'DELETE'
      ? `${baseUrl}${endpointPath}?${signedQuery}`
      : `${baseUrl}${endpointPath}`;

  const startedAt = Date.now();
  const resp = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': vault.apiKey,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { body: signedQuery } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const latencyMs = Date.now() - startedAt;
  const rawText = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    data = { rawText };
  }
  return { ok: resp.ok, status: resp.status, latencyMs, data };
}

async function bootstrapServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'apexrust-control-proxy', environment: vault.environment });
  });

  app.get('/api/live/config', (_req, res) => {
    res.json(getSafeStatus());
  });

  app.post('/api/live/config', (req, res) => {
    const body = (req.body ?? {}) as {
      environment?: BinanceEnv;
      authMethod?: AuthMethod;
      apiKey?: string;
      apiSecret?: string;
      recvWindowMs?: number;
      maxOrderNotionalUsdt?: number;
      requirePreflightTestOrder?: boolean;
    };

    const nextEnv: BinanceEnv = body.environment === 'Production' ? 'Production' : 'Testnet';
    const nextAuth: AuthMethod = body.authMethod === 'Ed25519' ? 'Ed25519' : 'HMAC-SHA256';
    const nextKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const nextSecret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';

    const keyChanged = nextKey.length > 0 && nextKey !== vault.apiKey;
    const secretChanged = nextSecret.length > 0 && nextSecret !== vault.apiSecret;
    const envChanged = nextEnv !== vault.environment || nextAuth !== vault.authMethod;

    vault.environment = nextEnv;
    vault.authMethod = nextAuth;
    if (nextKey.length > 0) vault.apiKey = nextKey;
    if (nextSecret.length > 0) vault.apiSecret = nextSecret;

    if (typeof body.recvWindowMs === 'number' && Number.isFinite(body.recvWindowMs)) {
      vault.recvWindowMs = Math.min(60_000, Math.max(1000, Math.round(body.recvWindowMs)));
    }
    if (typeof body.maxOrderNotionalUsdt === 'number' && Number.isFinite(body.maxOrderNotionalUsdt)) {
      vault.maxOrderNotionalUsdt = Math.max(10, Number(body.maxOrderNotionalUsdt.toFixed(2)));
    }
    if (typeof body.requirePreflightTestOrder === 'boolean') {
      vault.requirePreflightTestOrder = body.requirePreflightTestOrder;
    }

    if (keyChanged || secretChanged || envChanged) {
      vault.armedForLiveOrders = false;
      vault.verificationStatus = 'unverified';
      vault.verificationMessage = 'Credentials saved in server vault — run Verify Connection before arming.';
      vault.lastVerifiedAt = null;
      vault.canTrade = false;
      vault.permissions = [];
      vault.syncedBalances = [];
    }

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        error: 'Both API Key and Secret / Private Key are required to configure live credentials.',
        status: getSafeStatus(),
      });
      return;
    }

    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/verify', async (_req, res) => {
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        error: 'Live credentials are not configured yet.',
        status: getSafeStatus(),
      });
      return;
    }

    try {
      const result = await signedBinanceRequest('GET', '/api/v3/account', {});
      vault.latencyMs = result.latencyMs;

      if (!result.ok) {
        const errMsg =
          typeof result.data.msg === 'string'
            ? `Binance ${result.data.code ?? result.status}: ${result.data.msg}`
            : `HTTP ${result.status} from ${getRestBaseUrl(vault.environment)}`;
        vault.verificationStatus = 'error';
        vault.verificationMessage = errMsg;
        vault.canTrade = false;
        vault.armedForLiveOrders = false;
        res.status(200).json({ ok: false, status: getSafeStatus() });
        return;
      }

      const rawBalances = Array.isArray(result.data.balances)
        ? (result.data.balances as Array<{ asset: string; free: string; locked: string }>)
        : [];
      vault.syncedBalances = rawBalances
        .filter((b) => TRACKED_ASSETS.has(b.asset) || Number(b.free) > 0 || Number(b.locked) > 0)
        .slice(0, 12)
        .map((b) => ({
          asset: b.asset,
          free: Number(b.free) || 0,
          locked: Number(b.locked) || 0,
        }));

      vault.canTrade = Boolean(result.data.canTrade);
      vault.permissions = Array.isArray(result.data.permissions)
        ? (result.data.permissions as string[])
        : ['SPOT'];
      vault.verificationStatus = 'verified';
      vault.lastVerifiedAt = new Date().toISOString();
      vault.verificationMessage = `Signed ${vault.authMethod} check succeeded on ${vault.environment} (${result.latencyMs}ms)`;

      res.json({ ok: true, status: getSafeStatus() });
    } catch (err) {
      vault.verificationStatus = 'error';
      vault.canTrade = false;
      vault.armedForLiveOrders = false;
      vault.verificationMessage =
        err instanceof Error
          ? `Unable to reach ${getRestBaseUrl(vault.environment)}: ${err.message}`
          : 'Network error contacting Binance API';
      res.status(200).json({ ok: false, status: getSafeStatus() });
    }
  });

  app.post('/api/live/arm', (req, res) => {
    const body = (req.body ?? {}) as { armed?: boolean; confirmProduction?: boolean };
    const wantArm = Boolean(body.armed);

    if (!wantArm) {
      vault.armedForLiveOrders = false;
      res.json({ ok: true, status: getSafeStatus() });
      return;
    }

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        error: 'Configure live credentials before arming live execution.',
        status: getSafeStatus(),
      });
      return;
    }

    if (vault.environment === 'Production' && !body.confirmProduction) {
      res.status(400).json({
        error: 'Production live arming requires explicit real-funds confirmation.',
        status: getSafeStatus(),
      });
      return;
    }

    vault.armedForLiveOrders = true;
    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/order', async (req, res) => {
    const body = (req.body ?? {}) as {
      symbol?: string;
      side?: 'BUY' | 'SELL';
      type?: 'MARKET' | 'LIMIT' | 'LIMIT_MAKER';
      quoteOrderQty?: number;
      quantity?: number;
      price?: number;
      timeInForce?: 'GTC' | 'IOC' | 'FOK';
      preflightOnly?: boolean;
    };

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ error: 'Live API credentials are not configured.' });
      return;
    }

    const preflightOnly = Boolean(body.preflightOnly);
    if (!preflightOnly && !vault.armedForLiveOrders) {
      res.status(403).json({
        error: 'Live execution is disarmed. Arm Live Execution or run a signed preflight test order.',
      });
      return;
    }

    const symbol = (body.symbol ?? 'BTCUSDT').toUpperCase();
    const side = body.side === 'SELL' ? 'SELL' : 'BUY';
    const orderType =
      body.type === 'LIMIT_MAKER' ? 'LIMIT_MAKER' : body.type === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const tif = body.timeInForce === 'IOC' ? 'IOC' : body.timeInForce === 'FOK' ? 'FOK' : 'GTC';

    const requestedQty = Number(body.quantity ?? 0);
    const requestedPrice = Number(body.price ?? 0);
    const requestedNotional = Number(body.quoteOrderQty ?? 0);

    const orderParams: Record<string, string | number> = {
      symbol,
      side,
      type: orderType,
    };

    if (orderType === 'MARKET') {
      if (Number.isFinite(requestedQty) && requestedQty > 0) {
        const filters = await getSymbolFilters(symbol, requestedPrice > 0 ? requestedPrice : 100);
        const formattedQty = floorToStep(requestedQty, filters.stepSize, filters.stepDecimals);
        if (Number(formattedQty) <= 0) {
          res.status(400).json({ error: 'Formatted MARKET quantity rounds to 0 under Binance LOT_SIZE.' });
          return;
        }
        orderParams.quantity = formattedQty;
      } else {
        if (!Number.isFinite(requestedNotional) || requestedNotional <= 0) {
          res.status(400).json({ error: 'quoteOrderQty or quantity must be greater than 0.' });
          return;
        }
        if (requestedNotional > vault.maxOrderNotionalUsdt) {
          res.status(400).json({
            error: `Order notional $${requestedNotional.toFixed(2)} exceeds server safety cap ($${vault.maxOrderNotionalUsdt.toFixed(2)}).`,
          });
          return;
        }
        orderParams.quoteOrderQty = requestedNotional.toFixed(2);
      }
    } else {
      if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
        res.status(400).json({ error: `${orderType} order requires a valid positive price.` });
        return;
      }
      const effectiveNotional =
        Number.isFinite(requestedQty) && requestedQty > 0
          ? requestedQty * requestedPrice
          : requestedNotional;
      if (!Number.isFinite(effectiveNotional) || effectiveNotional <= 0) {
        res.status(400).json({ error: `${orderType} order requires positive notional or quantity.` });
        return;
      }
      if (effectiveNotional > vault.maxOrderNotionalUsdt) {
        res.status(400).json({
          error: `Order notional $${effectiveNotional.toFixed(2)} exceeds server safety cap ($${vault.maxOrderNotionalUsdt.toFixed(2)}).`,
        });
        return;
      }
      const filters = await getSymbolFilters(symbol, requestedPrice);
      const formattedPrice = floorToStep(requestedPrice, filters.tickSize, filters.tickDecimals);
      const rawQty =
        Number.isFinite(requestedQty) && requestedQty > 0
          ? requestedQty
          : effectiveNotional / Number(formattedPrice || requestedPrice);
      const formattedQty = floorToStep(rawQty, filters.stepSize, filters.stepDecimals);
      if (Number(formattedPrice) <= 0 || Number(formattedQty) <= 0) {
        res.status(400).json({
          error: `Formatted ${orderType} price/quantity invalid under Binance filters.`,
        });
        return;
      }
      orderParams.price = formattedPrice;
      orderParams.quantity = formattedQty;
      // Binance Spot API forbids timeInForce on LIMIT_MAKER (Post-Only)
      if (orderType === 'LIMIT') {
        orderParams.timeInForce = tif;
      }
    }

    try {
      if (preflightOnly || vault.requirePreflightTestOrder) {
        const testRes = await signedBinanceRequest('POST', '/api/v3/order/test', orderParams);
        if (!testRes.ok) {
          const msg =
            typeof testRes.data.msg === 'string'
              ? `Binance Preflight ${testRes.data.code ?? testRes.status}: ${testRes.data.msg}`
              : `Preflight failed with HTTP ${testRes.status}`;
          res.status(400).json({ error: msg });
          return;
        }
        if (preflightOnly) {
          res.json({
            ok: true,
            preflight: true,
            environment: vault.environment,
            latencyMs: testRes.latencyMs,
            message: `Signed /api/v3/order/test passed for ${symbol} ${side} ${orderType}`,
          });
          return;
        }
      }

      const liveRes = await signedBinanceRequest('POST', '/api/v3/order', orderParams);
      if (!liveRes.ok) {
        const msg =
          typeof liveRes.data.msg === 'string'
            ? `Binance Order ${liveRes.data.code ?? liveRes.status}: ${liveRes.data.msg}`
            : `Order failed with HTTP ${liveRes.status}`;
        res.status(400).json({ error: msg });
        return;
      }

      const executedQty = Number(liveRes.data.executedQty ?? 0) || 0;
      const cumQuote = Number(liveRes.data.cummulativeQuoteQty ?? 0) || 0;
      const avgPrice =
        executedQty > 0 && cumQuote > 0
          ? cumQuote / executedQty
          : Number(liveRes.data.price ?? requestedPrice ?? 0) || 0;

      res.json({
        ok: true,
        preflight: false,
        environment: vault.environment,
        latencyMs: liveRes.latencyMs,
        orderId: liveRes.data.orderId != null ? String(liveRes.data.orderId) : undefined,
        orderStatus: typeof liveRes.data.status === 'string' ? liveRes.data.status : 'FILLED',
        executedQty,
        avgPrice,
        order: liveRes.data,
      });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? `Binance request failed: ${err.message}`
            : 'Failed to reach Binance REST API',
      });
    }
  });

  app.delete('/api/live/order', async (req, res) => {
    const body = (req.body ?? {}) as { symbol?: string; orderId?: string };
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ error: 'Live API credentials are not configured.' });
      return;
    }
    if (!vault.armedForLiveOrders) {
      res.status(403).json({ error: 'Live execution is disarmed.' });
      return;
    }
    const symbol = (body.symbol ?? '').toUpperCase();
    const orderId = (body.orderId ?? '').trim();
    if (!symbol || !orderId) {
      res.status(400).json({ error: 'symbol and orderId are required to cancel a live order.' });
      return;
    }
    try {
      const cancelRes = await signedBinanceRequest('DELETE', '/api/v3/order', {
        symbol,
        orderId,
      });
      if (!cancelRes.ok) {
        const msg =
          typeof cancelRes.data.msg === 'string'
            ? `Binance Cancel ${cancelRes.data.code ?? cancelRes.status}: ${cancelRes.data.msg}`
            : `Cancel failed with HTTP ${cancelRes.status}`;
        res.status(400).json({ error: msg });
        return;
      }
      res.json({ ok: true, latencyMs: cancelRes.latencyMs, data: cancelRes.data });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach Binance cancel endpoint',
      });
    }
  });

  app.delete('/api/live/config', (_req, res) => {
    vault.apiKey = '';
    vault.apiSecret = '';
    vault.armedForLiveOrders = false;
    vault.verificationStatus = 'unverified';
    vault.verificationMessage = null;
    vault.lastVerifiedAt = null;
    vault.canTrade = false;
    vault.permissions = [];
    vault.latencyMs = null;
    vault.syncedBalances = [];
    res.json({ ok: true, status: getSafeStatus() });
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`ApexRust server listening on http://0.0.0.0:${port}`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start ApexRust server:', err);
  process.exit(1);
});
