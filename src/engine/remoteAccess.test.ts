import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildApiUrl,
  buildAuthHeaders,
  getLocalAccessToken,
  loadConnectionProfile,
  saveConnectionProfile,
  setLocalAccessToken,
  validateRemoteBaseUrl,
} from './apiClient';
import {
  mapRustEngineSnapshot,
  mapRustFeatureToggles,
} from './engineSnapshotAdapter';
import { OrderHistoryDatabase } from './orderDatabase';
import {
  AuthFailureLimiter,
  LiveExecutionLeaseManager,
  evaluateBindSafety,
  evaluateEngineAuthorityGuard,
  isEnginePathAllowed,
  isLoopbackHost,
  isOriginAllowed,
  isPrivateOrZeroTrustHost,
  parseAllowedOrigins,
} from './remoteAccess';

test('isLoopbackHost and isPrivateOrZeroTrustHost recognize loopback, RFC1918, and Cloudflare One WARP 100.96.0.0/12 mesh IPs', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.1:3000'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('100.96.1.10'), false);

  // Cloudflare One (Zero Trust WARP 100.96.0.0/12 inside CGNAT 100.64.0.0/10)
  assert.equal(isPrivateOrZeroTrustHost('100.96.1.10'), true);
  assert.equal(isPrivateOrZeroTrustHost('100.64.0.5:3000'), true);
  assert.equal(isPrivateOrZeroTrustHost('10.0.0.15'), true);
  assert.equal(isPrivateOrZeroTrustHost('172.16.4.2'), true);
  assert.equal(isPrivateOrZeroTrustHost('192.168.1.50'), true);
  assert.equal(isPrivateOrZeroTrustHost('vps.internal'), true);
  assert.equal(isPrivateOrZeroTrustHost('bot.cfargotunnel.com'), true);

  // Wildcard and public internet IPs must NOT be treated as private
  assert.equal(isPrivateOrZeroTrustHost('0.0.0.0'), false);
  assert.equal(isPrivateOrZeroTrustHost('8.8.8.8'), false);
  assert.equal(isPrivateOrZeroTrustHost('100.128.0.1'), false);
});

test('evaluateBindSafety allows loopback and Cloudflare One mesh without token and blocks unguarded 0.0.0.0', () => {
  assert.deepEqual(evaluateBindSafety('127.0.0.1', ''), { ok: true });
  assert.deepEqual(evaluateBindSafety('100.96.10.25', ''), { ok: true });

  const blockedWildcard = evaluateBindSafety('0.0.0.0', '');
  assert.equal(blockedWildcard.ok, false);

  const shortToken = evaluateBindSafety('127.0.0.1', 'too-short');
  assert.equal(shortToken.ok, false);

  const validToken = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(evaluateBindSafety('0.0.0.0', validToken), { ok: true });
  assert.deepEqual(evaluateBindSafety('0.0.0.0', '', { isCloudRun: true }), { ok: true });
  assert.deepEqual(evaluateBindSafety('0.0.0.0', '', { trustZeroTrustMesh: true }), { ok: true });
});

test('parseAllowedOrigins, isOriginAllowed, and AuthFailureLimiter enforce CORS and rate limits', () => {
  const allowed = parseAllowedOrigins('https://bot.example.com');
  assert.equal(isOriginAllowed('http://localhost:3000', allowed), true);
  assert.equal(isOriginAllowed('http://100.96.1.10:3000', allowed), true);
  assert.equal(isOriginAllowed('https://bot.example.com', allowed), true);
  assert.equal(isOriginAllowed('https://evil.example.org', allowed), false);

  const limiter = new AuthFailureLimiter(3, 60_000);
  const ip = '203.0.113.9';
  assert.equal(limiter.isLocked(ip, 1000), false);
  limiter.recordFailure(ip, 1000);
  limiter.recordFailure(ip, 2000);
  const third = limiter.recordFailure(ip, 3000);
  assert.equal(third.locked, true);
  assert.equal(limiter.isLocked(ip, 4000), true);
  // Unlocked after window expires or on success
  assert.equal(limiter.isLocked(ip, 65_000), false);
  limiter.recordFailure(ip, 70_000);
  limiter.recordSuccess(ip);
  assert.equal(limiter.isLocked(ip, 70_001), false);
});

test('isEnginePathAllowed, evaluateEngineAuthorityGuard, and LiveExecutionLeaseManager prevent duplicate orders', () => {
  assert.equal(isEnginePathAllowed('GET', '/health'), true);
  assert.equal(isEnginePathAllowed('GET', '/snapshot'), true);
  assert.equal(isEnginePathAllowed('POST', '/control'), true);
  assert.equal(isEnginePathAllowed('DELETE', '/orders/history'), true);
  assert.equal(isEnginePathAllowed('POST', '/../../etc/passwd'), false);
  assert.equal(isEnginePathAllowed('GET', '/unknown'), false);

  // Daemon authority blocks direct browser new-entry live orders (409) but allows reduceOnly exits & preflight
  const blockedEntry = evaluateEngineAuthorityGuard('daemon', { reduceOnly: false });
  assert.equal(blockedEntry.allowed, false);
  if (!blockedEntry.allowed) {
    assert.equal(blockedEntry.status, 409);
    assert.equal(blockedEntry.code, 'ENGINE_AUTHORITY_DAEMON');
  }
  assert.deepEqual(evaluateEngineAuthorityGuard('daemon', { reduceOnly: true }), { allowed: true });
  assert.deepEqual(evaluateEngineAuthorityGuard('daemon', { preflightOnly: true }), { allowed: true });
  assert.deepEqual(evaluateEngineAuthorityGuard('browser', { reduceOnly: false }), { allowed: true });

  // Single-browser live execution lease
  const lease = new LiveExecutionLeaseManager(20_000);
  assert.equal(lease.acquireOrRenew('desktop-A', 1000).acquired, true);
  assert.equal(lease.verifyEntryLease('desktop-A', 2000).allowed, true);
  assert.equal(lease.verifyEntryLease('desktop-B', 2000).allowed, false);
  // After 20s TTL expiry, desktop-B can take over
  assert.equal(lease.verifyEntryLease('desktop-B', 25_000).allowed, true);
});

test('validateRemoteBaseUrl, buildApiUrl, buildAuthHeaders, and mapRustEngineSnapshot adapt Remote VPS payloads cleanly', () => {
  const valid = validateRemoteBaseUrl('http://100.96.1.10:3000/api/engine/');
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.normalizedUrl, 'http://100.96.1.10:3000');
  }
  assert.equal(validateRemoteBaseUrl('ftp://100.96.1.10:3000').ok, false);

  const localProf = { kind: 'local' as const };
  const remoteProf = {
    kind: 'remote' as const,
    name: 'Tokyo VPS',
    baseUrl: 'http://100.96.1.10:3000',
    token: '0123456789abcdef0123456789abcdef',
    rememberToken: false,
  };
  assert.equal(buildApiUrl(localProf, '/api/orders/history'), '/api/orders/history');
  assert.equal(
    buildApiUrl(remoteProf, '/api/orders/history'),
    'http://100.96.1.10:3000/api/orders/history'
  );
  const headers = buildAuthHeaders(remoteProf, 'client-123');
  assert.equal(headers.Authorization, 'Bearer 0123456789abcdef0123456789abcdef');
  assert.equal(headers['X-ApexRust-Client-Id'], 'client-123');
  assert.equal(buildApiUrl(remoteProf, '/api/orders/history').includes(remoteProf.token), false);

  // Verify sessionStorage default vs localStorage rememberToken persistence
  const createMemStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => {
        map.clear();
      },
    };
  };
  const g = globalThis as unknown as { window?: unknown };
  const prevWindow = g.window;
  try {
    const ls = createMemStorage();
    const ss = createMemStorage();
    g.window = { localStorage: ls, sessionStorage: ss };

    saveConnectionProfile({
      kind: 'remote',
      name: 'VPS-SessionOnly',
      baseUrl: 'http://100.96.1.10:3000',
      token: 'secret-token-session-only',
      rememberToken: false,
    });
    assert.equal(JSON.stringify(ls.getItem('apexrust_connection_profile_v1')).includes('secret-token-session-only'), false);
    const loadedSession = loadConnectionProfile();
    assert.equal(loadedSession.kind, 'remote');
    if (loadedSession.kind === 'remote') {
      assert.equal(loadedSession.token, 'secret-token-session-only');
    }

    // Clear sessionStorage to simulate browser window reopen: token should be empty when rememberToken=false
    ss.clear();
    const afterReopen = loadConnectionProfile();
    if (afterReopen.kind === 'remote') {
      assert.equal(afterReopen.token, '');
    }

    // Now persist with rememberToken=true -> localStorage retains token across browser reopen
    saveConnectionProfile({
      kind: 'remote',
      name: 'VPS-Remembered',
      baseUrl: 'http://100.96.1.10:3000',
      token: 'secret-token-remembered',
      rememberToken: true,
    });
    ss.clear();
    const loadedRemembered = loadConnectionProfile();
    if (loadedRemembered.kind === 'remote') {
      assert.equal(loadedRemembered.token, 'secret-token-remembered');
    }

    // Switching back to local clears session token
    saveConnectionProfile({ kind: 'local' });
    assert.equal(loadConnectionProfile().kind, 'local');
    assert.equal(ss.getItem('apexrust_connection_token_v1'), null);

    // Same-origin local server token stays in sessionStorage only
    setLocalAccessToken('same-origin-proxy-token-32-chars!!');
    assert.equal(getLocalAccessToken(), 'same-origin-proxy-token-32-chars!!');
    assert.equal(ls.getItem('apexrust_local_proxy_token_v1'), null);
    assert.equal(
      buildAuthHeaders(localProf, 'client-abc').Authorization,
      'Bearer same-origin-proxy-token-32-chars!!'
    );
    setLocalAccessToken('');
    assert.equal(getLocalAccessToken(), '');
  } finally {
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
  }

  const mapped = mapRustEngineSnapshot({
    running: true,
    venue: 'futures',
    transport_mode: 'WsPrimary',
    failover_count: 1,
    last_ws_age_ms: 120,
    risk: {
      state: 'Normal',
      trip_reason: null,
      starting_daily_equity: 10000,
      current_equity: 10250.5,
      daily_pnl_usdt: 250.5,
      daily_pnl_pct: 2.505,
      win_streak: 2,
      lose_streak: 0,
      quarantined_pairs: [],
    },
    pairs: [
      {
        symbol: 'BTCUSDT',
        last_price: 91500,
        daily_pnl_usdt: 250.5,
        daily_pnl_pct: 2.505,
        indicators: { ema_fast: 91400, ema_slow: 91100, rsi: 61.2, atr: 320, adx: 29.4, vwap: 91250 },
        open_position: {
          id: 'pos-1',
          symbol: 'BTCUSDT',
          side: 'Long',
          entry_price: 91000,
          quantity: 0.1,
          remaining_quantity: 0.1,
          unrealized_pnl_usdt: 50,
          realized_pnl_usdt: 0,
          highest_favorable_price: 91550,
          exit_plan: {
            initial_stop_loss: 90400,
            current_stop_loss: 91020,
            take_profit_1: 91900,
            take_profit_2: 92800,
            tp1_filled: false,
            break_even_armed: true,
            trailing_active: false,
          },
          opened_at: '2026-11-18T12:00:00Z',
        },
      },
    ],
    recent_trades: [],
    recent_volatility_alerts: [],
    updated_at: '2026-11-18T12:05:00Z',
  });
  assert.equal(mapped.venue, 'Futures');
  assert.equal(mapped.risk.currentEquity, 10250.5);
  assert.equal(mapped.pairs[0].openPosition?.breakEvenArmed, true);

  const ft = mapRustFeatureToggles({
    features: { manual_trading: false, circuit_breaker: true },
  });
  assert.equal(ft?.manualTrading, false);
  assert.equal(ft?.circuitBreaker, true);
});

test('Shared SQLite WAL OrderHistoryDatabase reloads external daemon writes and targeted deleteLogs preserves concurrent rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexrust-shared-db-'));
  const dbPath = path.join(tmpDir, 'shared.sqlite');

  try {
    const serverDb = new OrderHistoryDatabase({ dbPath });
    const daemonDb = new OrderHistoryDatabase({ dbPath });

    serverDb.upsertLogs([
      {
        id: 'srv-paper-1',
        orderId: '101',
        clientOrderId: 'c101',
        symbol: 'BTCUSDT',
        venue: 'Spot',
        environment: 'Testnet',
        accountMode: 'Paper',
        source: 'paper_engine',
        lifecycle: 'ENTRY',
        side: 'Long',
        binanceSide: 'BUY',
        orderType: 'MARKET',
        timeInForce: 'GTC',
        status: 'FILLED',
        price: 90000,
        origQty: 0.1,
        executedQty: 0.1,
        quoteQty: 9000,
        commission: 0.9,
        commissionAsset: 'USDT',
        isMaker: false,
        realizedPnlUsdt: null,
        rMultiple: null,
        exitReason: null,
        latencyMs: 5,
        endpoint: 'PAPER',
        rationale: 'server paper',
        timestampMs: 1_760_000_001_000,
      },
    ]);

    // Simulate the 24/7 Rust daemon writing a Live execution to the same SQLite WAL database file
    daemonDb.upsertLogs([
      {
        id: 'daemon-live-1',
        orderId: '202',
        clientOrderId: 'c202',
        symbol: 'ETHUSDT',
        venue: 'Futures',
        environment: 'Testnet',
        accountMode: 'Live',
        source: 'live_proxy',
        lifecycle: 'EXIT',
        side: 'Long',
        binanceSide: 'SELL',
        orderType: 'MARKET',
        timeInForce: 'GTC',
        status: 'FILLED',
        price: 3100,
        origQty: 1,
        executedQty: 1,
        quoteQty: 3100,
        commission: 1.2,
        commissionAsset: 'USDT',
        isMaker: false,
        realizedPnlUsdt: 42.5,
        rMultiple: 1.8,
        exitReason: 'TakeProfit2',
        latencyMs: 12,
        endpoint: 'POST /fapi/v1/order',
        rationale: 'daemon live exit',
        timestampMs: 1_760_000_002_000,
      },
    ]);

    // serverDb must detect PRAGMA data_version change and see daemonDb's row immediately!
    assert.equal(serverDb.getAllLogs().length, 2);

    // Deleting Paper logs on serverDb must NOT wipe daemonDb's Live row
    const delRes = serverDb.deleteLogs({ accountMode: 'Paper' });
    assert.equal(delRes.deleted, 1);
    assert.equal(serverDb.getSummary().liveCount, 1);
    assert.equal(daemonDb.getSummary().liveCount, 1);

    serverDb.close();
    daemonDb.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit regressions: IPv6 ULA vs public fc*/fd* hostnames, full IPv6 loopback, and Rust snapshot indicator/toggle mapping', () => {
  // Public domains starting with fc/fd must NOT be treated as private IPv6 ULA
  assert.equal(isPrivateOrZeroTrustHost('fc-public.example.com'), false);
  assert.equal(isPrivateOrZeroTrustHost('fd-api.binance.com'), false);
  assert.equal(isPrivateOrZeroTrustHost('fd-host.com:8080'), false);

  // Genuine IPv6 ULA, Link-Local, and full-form loopback MUST be recognized
  assert.equal(isPrivateOrZeroTrustHost('fc00::1'), true);
  assert.equal(isPrivateOrZeroTrustHost('fd12:3456:789a:1::1'), true);
  assert.equal(isPrivateOrZeroTrustHost('fe80::1%eth0'), true);
  assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(isPrivateOrZeroTrustHost('0:0:0:0:0:0:0:1'), true);

  // mapRustEngineSnapshot maps all indicators & mapRustFeatureToggles uses correct opt-in defaults
  const mapped = mapRustEngineSnapshot({
    running: true,
    venue: 'futures',
    pairs: [
      {
        symbol: 'ETHUSDT',
        last_price: 3200,
        daily_pnl_usdt: 0,
        daily_pnl_pct: 0,
        indicators: {
          ema_fast: 3195,
          ema_mid: 3180,
          ema_slow: 3150,
          ema_macro: 3050,
          rsi: 54.5,
          prev_rsi: 51.2,
          atr: 22,
          adx: 28,
          plus_di: 26,
          minus_di: 14,
          vwap: 3185,
          volume_ratio: 1.75,
        },
        open_position: null,
      },
    ],
  });
  assert.equal(mapped.pairs[0].emaMid, 3180);
  assert.equal(mapped.pairs[0].emaMacro, 3050);
  assert.equal(mapped.pairs[0].prevRsi, 51.2);
  assert.equal(mapped.pairs[0].plusDi, 26);
  assert.equal(mapped.pairs[0].minusDi, 14);
  assert.equal(mapped.pairs[0].volumeRatio, 1.75);

  const defaults = mapRustFeatureToggles({ features: {} });
  assert.equal(defaults?.volumeConfirmationFilter, false);
  assert.equal(defaults?.sessionWindowFilter, false);
  assert.equal(defaults?.gitAutoBackup, false);
});
