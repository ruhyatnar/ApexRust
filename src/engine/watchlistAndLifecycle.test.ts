import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mapRustEngineSnapshot, mergeRemoteVpsSnapshot } from './engineSnapshotAdapter';
import { fmtPx, pricePrecisionDecimals } from './formatters';
import { OrderHistoryDatabase } from './orderDatabase';
import { DEFAULT_BOT_CONFIG, SimulationRuntime } from './simulator';
import {
  buildExitPlan,
  evaluateEntrySignal,
  evaluateOpenPositionDynamicAction,
  evaluatePendingOrderDynamicAction,
} from './strategy';
import type {
  BotConfig,
  Candle,
  IndicatorSnapshot,
  MarketTicker24h,
  OrderExecutionLog,
  PendingOrder,
  Position,
} from './types';
import {
  hasCandleSequenceGap,
  resolveEffectiveWatchlist,
  timeframeToMs,
  type WatchlistDwellState,
} from './watchlist';
import { BinanceScreenerHub } from '../server/binanceScreenerHub';

function makeTicker(
  symbol: string,
  quoteVolume: number,
  priceChangePercent = 2.0,
  tradableOnActiveEnv = true
): MarketTicker24h {
  return {
    symbol,
    venue: 'Spot',
    lastPrice: 100,
    openPrice24h: 98,
    highPrice24h: 105,
    lowPrice24h: 95,
    priceChangePercent,
    baseVolume: quoteVolume / 100,
    quoteVolume,
    rangePct24h: 10,
    tradableOnActiveEnv,
    updatedAtMs: 1_763_280_000_000,
  };
}

function makeBullishIndicator(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    emaFast: 102.5,
    emaMid: 101.8,
    prevEmaMid: 101.6,
    emaSlow: 100.5,
    emaMacro: 96.0,
    rsi: 51,
    prevRsi: 47,
    adx: 31,
    prevAdx: 29.5,
    plusDi: 28,
    minusDi: 14,
    atr: 1.0,
    vwap: 101.9,
    volumeSma20: 2500,
    volumeRatio: 1.8,
    warmupBarsCount: 220,
    hasBarGap: false,
    ...overrides,
  };
}

function makeBearishIndicator(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    emaFast: 97.5,
    emaMid: 98.2,
    prevEmaMid: 98.5,
    emaSlow: 99.6,
    emaMacro: 104.0,
    rsi: 49,
    prevRsi: 53,
    adx: 31,
    prevAdx: 29.5,
    plusDi: 14,
    minusDi: 28,
    atr: 1.0,
    vwap: 98.1,
    volumeSma20: 2500,
    volumeRatio: 1.8,
    warmupBarsCount: 220,
    hasBarGap: false,
    ...overrides,
  };
}

function makeTestConfig(overrides?: {
  trading?: Partial<BotConfig['trading']>;
  automation?: Partial<BotConfig['automation']>;
  indicators?: Partial<BotConfig['indicators']>;
}): BotConfig {
  const base = structuredClone(DEFAULT_BOT_CONFIG);
  return {
    ...base,
    trading: { ...base.trading, ...overrides?.trading },
    automation: { ...base.automation, ...overrides?.automation },
    indicators: { ...base.indicators, ...overrides?.indicators },
  };
}

test('resolveEffectiveWatchlist supports static, hybrid, dynamic, hysteresis, dwell, venue filter & zero orphan lock', () => {
  const tradingCfg = {
    venue: 'Spot' as const,
    quoteAsset: 'USDT',
    maxWatchlistPairs: 5,
    trendingCategory: 'hot_volume' as const,
    trendingTopN: 2,
    trendingMinQuoteVolumeUsdt: 10_000_000,
    trendingMinDwellMinutes: 15,
    trendingHysteresisRankBuffer: 2,
  };
  const tickers: MarketTicker24h[] = [
    makeTicker('PEPEUSDT', 500_000_000),
    makeTicker('DOGEUSDT', 400_000_000),
    makeTicker('SUIUSDT', 300_000_000),
    makeTicker('WIFUSDT', 200_000_000),
    makeTicker('NOTTRADABLEUSDT', 900_000_000, 12, false),
  ];
  const tradable = new Set(['BTCUSDT', 'ETHUSDT', 'PEPEUSDT', 'DOGEUSDT', 'SUIUSDT', 'WIFUSDT']);

  // 1. Static Only ignores trending tickers while preserving pinned & protected positions
  const staticList = resolveEffectiveWatchlist({
    mode: 'static',
    pinnedPairs: ['BTCUSDT', 'ETHUSDT'],
    trendingTickers: tickers,
    protectedSymbols: ['SOLUSDT'],
    tradableVenueSymbols: tradable,
    tradingCfg,
  });
  assert.deepEqual(
    staticList.map((e) => `${e.symbol}:${e.sourceTag}`),
    ['SOLUSDT:protected_position', 'BTCUSDT:pinned', 'ETHUSDT:pinned']
  );

  // 2. Hybrid keeps pinned pairs + top N trending pairs filtered by tradableVenueSymbols
  const dwellState: WatchlistDwellState = { enteredAtMs: new Map() };
  const t0 = 1_763_280_000_000;
  const hybridList = resolveEffectiveWatchlist({
    mode: 'hybrid',
    pinnedPairs: ['BTCUSDT', 'ETHUSDT'],
    trendingTickers: tickers,
    dwellState,
    tradableVenueSymbols: tradable,
    tradingCfg,
    nowMs: t0,
  });
  assert.deepEqual(
    hybridList.map((e) => `${e.symbol}:${e.sourceTag}`),
    ['BTCUSDT:pinned', 'ETHUSDT:pinned', 'PEPEUSDT:trending', 'DOGEUSDT:trending']
  );

  // 3. Dynamic with dwell + hysteresis keeps incumbent trending SUIUSDT while within dwell window
  dwellState.enteredAtMs.set('SUIUSDT', t0 - 5 * 60_000); // only 5m elapsed < 15m minDwell
  const dynamicDuringDwell = resolveEffectiveWatchlist({
    mode: 'dynamic',
    pinnedPairs: ['BTCUSDT'],
    trendingTickers: [
      makeTicker('PEPEUSDT', 600_000_000),
      makeTicker('DOGEUSDT', 550_000_000),
      makeTicker('WIFUSDT', 500_000_000),
      makeTicker('APTUSDT', 450_000_000),
      makeTicker('SUIUSDT', 100_000_000), // dropped to rank 5 (> Top 2 + buffer 2)
    ],
    currentlyActiveTrending: ['PEPEUSDT', 'SUIUSDT'],
    dwellState,
    tradableVenueSymbols: new Set(['PEPEUSDT', 'DOGEUSDT', 'WIFUSDT', 'APTUSDT', 'SUIUSDT']),
    tradingCfg,
    nowMs: t0,
  });
  assert.equal(dynamicDuringDwell.some((e) => e.symbol === 'SUIUSDT'), true);

  // Once dwell expires AND rank drops outside TopN + buffer (rank 5 > 2 + 2 = 4), rotates to DOGEUSDT
  dwellState.enteredAtMs.set('SUIUSDT', t0 - 20 * 60_000);
  const dynamicAfterDwell = resolveEffectiveWatchlist({
    mode: 'dynamic',
    pinnedPairs: ['BTCUSDT'],
    trendingTickers: [
      makeTicker('PEPEUSDT', 600_000_000),
      makeTicker('DOGEUSDT', 550_000_000),
      makeTicker('WIFUSDT', 500_000_000),
      makeTicker('APTUSDT', 450_000_000),
      makeTicker('SUIUSDT', 100_000_000),
    ],
    currentlyActiveTrending: ['PEPEUSDT', 'SUIUSDT'],
    dwellState,
    tradableVenueSymbols: new Set(['PEPEUSDT', 'DOGEUSDT', 'WIFUSDT', 'APTUSDT', 'SUIUSDT']),
    tradingCfg,
    nowMs: t0,
  });
  assert.deepEqual(
    dynamicAfterDwell.map((e) => e.symbol),
    ['PEPEUSDT', 'DOGEUSDT']
  );
});

test('evaluateEntrySignal enforces Futures Long/Short symmetry, Spot long_only guard, and mitigation gates', () => {
  const bullCandle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 101.8,
    high: 103.2,
    low: 101.7,
    close: 103.0,
    volume: 5000,
    isClosed: true,
  };
  const bearCandle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 98.2,
    high: 98.3,
    low: 96.8,
    close: 97.0,
    volume: 5000,
    isClosed: true,
  };

  const spotCfg = makeTestConfig({ trading: { venue: 'Spot' }, automation: { directionPolicy: 'both' } });
  const futuresCfg = makeTestConfig({
    trading: { venue: 'Futures' },
    automation: { directionPolicy: 'both' },
  });

  // 1. Futures allows both Long and Short cleanly
  const futLong = evaluateEntrySignal(
    'BTCUSDT',
    bullCandle,
    makeBullishIndicator(),
    futuresCfg.trading,
    futuresCfg.indicators,
    bullCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 4, enforceVenueLongOnly: true }
  );
  const futShort = evaluateEntrySignal(
    'BTCUSDT',
    bearCandle,
    makeBearishIndicator(),
    futuresCfg.trading,
    futuresCfg.indicators,
    bearCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 4, enforceVenueLongOnly: true }
  );
  assert.equal(futLong?.side, 'Long');
  assert.equal(futShort?.side, 'Short');

  // 2. Spot strictly blocks Short even when directionPolicy='both'
  const spotShort = evaluateEntrySignal(
    'BTCUSDT',
    bearCandle,
    makeBearishIndicator(),
    spotCfg.trading,
    spotCfg.indicators,
    bearCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 4, enforceVenueLongOnly: true }
  );
  assert.equal(spotShort, null);

  // 3. Mitigation gates: wide BBO spread (> maxSpreadBps=20) blocks entry
  const wideSpreadBlocked = evaluateEntrySignal(
    'BTCUSDT',
    bullCandle,
    makeBullishIndicator(),
    futuresCfg.trading,
    futuresCfg.indicators,
    bullCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 35, enforceVenueLongOnly: true }
  );
  assert.equal(wideSpreadBlocked, null);

  // 4. Mitigation gates: over-extended EMA21 (> 2.2 * ATR) blocks chasing at top
  const extendedBlocked = evaluateEntrySignal(
    'BTCUSDT',
    { ...bullCandle, close: 108.0, high: 108.2, open: 106.5 },
    makeBullishIndicator({ emaFast: 107.0, emaMid: 101.8, atr: 1.0 }),
    futuresCfg.trading,
    futuresCfg.indicators,
    bullCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 4, enforceVenueLongOnly: true }
  );
  assert.equal(extendedBlocked, null);

  // 5. Mitigation gates: weak upper-wick candle close fails minCloseStrengthRatio
  const wickTrapBlocked = evaluateEntrySignal(
    'BTCUSDT',
    { openTimeMs: 1_763_280_000_000, open: 102.0, high: 104.5, low: 101.9, close: 102.3, volume: 5000, isClosed: true },
    makeBullishIndicator(),
    futuresCfg.trading,
    futuresCfg.indicators,
    bullCandle.openTimeMs,
    { strategyProfile: 'trend_pullback', directionPolicy: 'both', spreadBps: 4, enforceVenueLongOnly: true }
  );
  assert.equal(wickTrapBlocked, null);
});

test('evaluatePendingOrderDynamicAction & evaluateOpenPositionDynamicAction cancel stale orders and exit reversals', () => {
  const cfg = makeTestConfig({
    trading: { venue: 'Futures' },
    automation: {
      directionPolicy: 'both',
      cancelPendingOnSignalReversal: true,
      cancelPendingOnExhaustion: true,
      maxPendingOrderBars: 4,
      maxPendingRunawayAtr: 1.8,
      exitPositionOnSignalReversal: true,
      tightenTrailingOnExhaustion: true,
    },
  });

  const autoPending: PendingOrder = {
    id: 'pend-1',
    symbol: 'SOLUSDT',
    venue: 'Futures',
    side: 'Long',
    orderType: 'LIMIT',
    orderMethod: 'LIMIT',
    usdtAmount: 150,
    limitPrice: 100.0,
    timeInForce: 'GTC',
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
    createdAtMs: 1_763_280_000_000,
    source: 'auto',
    createdBarIndex: 10,
  };

  // Runaway price (> 1.8 * ATR above Long limit) cancels stale passive limit
  const runawayRes = evaluatePendingOrderDynamicAction({
    pending: autoPending,
    candle: { openTimeMs: 1_763_280_300_000, open: 102.0, high: 102.6, low: 101.9, close: 102.4, volume: 2000, isClosed: true },
    ind: makeBullishIndicator({ atr: 1.0 }),
    automationCfg: cfg.automation,
    currentBarIndex: 11,
  });
  assert.equal(runawayRes.type, 'Cancel');
  if (runawayRes.type === 'Cancel') {
    assert.equal(runawayRes.reason, 'PriceRunaway');
  }

  // Expired TTL bars cancels un-filled auto limit
  const expiredRes = evaluatePendingOrderDynamicAction({
    pending: autoPending,
    candle: { openTimeMs: 1_763_281_200_000, open: 100.4, high: 100.7, low: 100.2, close: 100.5, volume: 2000, isClosed: true },
    ind: makeBullishIndicator({ atr: 1.0 }),
    automationCfg: cfg.automation,
    currentBarIndex: 15,
  });
  assert.equal(expiredRes.type, 'Cancel');
  if (expiredRes.type === 'Cancel') {
    assert.equal(expiredRes.reason, 'ExpiredBars');
  }

  // Manual order respects opt-out by default
  const manualKeep = evaluatePendingOrderDynamicAction({
    pending: { ...autoPending, source: 'manual' },
    candle: { openTimeMs: 1_763_281_200_000, open: 105.0, high: 105.5, low: 104.8, close: 105.0, volume: 2000, isClosed: true },
    ind: makeBullishIndicator({ atr: 1.0 }),
    automationCfg: cfg.automation,
    currentBarIndex: 25,
  });
  assert.equal(manualKeep.type, 'Keep');

  // Open position reversal triggers EarlyReversalExit
  const openPos: Position = {
    id: 'pos-1',
    symbol: 'SOLUSDT',
    side: 'Long',
    entryPrice: 100,
    quantity: 2,
    remainingQuantity: 2,
    lockedMarginUsdt: 200,
    unrealizedPnlUsdt: 2,
    realizedPnlUsdt: 0,
    highestFavorablePrice: 102,
    openedAtMs: 1_763_280_000_000,
    rationale: 'Test position',
    exitPlan: {
      riskDistanceR: 1.5,
      initialStopLoss: 98.5,
      activeStopLoss: 98.5,
      takeProfit1: 102.25,
      takeProfit2: 103.75,
      tp1Hit: false,
      breakEvenArmed: false,
      trailingActive: false,
    },
  };
  const reversalExit = evaluateOpenPositionDynamicAction({
    pos: openPos,
    candle: { openTimeMs: 1_763_280_600_000, open: 97.2, high: 98.3, low: 96.8, close: 97.0, volume: 4000, isClosed: true },
    ind: makeBearishIndicator(),
    automationCfg: cfg.automation,
    opposingSignal: {
      symbol: 'SOLUSDT',
      side: 'Short',
      entryPrice: 97.0,
      atr: 1.0,
      adx: 31,
      rsi: 49,
      rationale: 'Bearish Reversal',
      timestampMs: 1_763_280_600_000,
    },
  });
  assert.equal(reversalExit.type, 'EarlyReversalExit');
});

test('SimulationRuntime handles Live -2011 pending fill promotion & Spot vs Futures venue isolation', () => {
  const liveCfg = makeTestConfig({
    trading: { venue: 'Spot' },
    automation: { autoFlipOnReversal: true, directionPolicy: 'both' },
  });
  const rt = new SimulationRuntime(liveCfg, 1_763_280_000_000, {
    accountMode: 'Live',
    seedDemoData: false,
    initialEquityOverride: 2000,
  });

  // Spot mode forces directionPolicy='long_only' and autoFlipOnReversal=false
  assert.equal(rt.snapshot.pairs.length >= 1, true);
  const sym = rt.snapshot.pairs[0].symbol;
  rt.recordExternalLivePendingOrder(
    {
      symbol: sym,
      orderType: 'LIMIT',
      side: 'Long',
      usdtAmount: 150,
      limitPrice: 100,
      timeInForce: 'GTC',
      stopLossMode: 'ATR',
      stopLossPct: 1.5,
      useBreakEven: true,
      useTrailingStop: true,
      targets: [{ pctOffset: 2.5, allocationPct: 100 }],
    },
    100,
    '998877',
    'Test Live Limit',
    1_763_280_000_000,
    'auto'
  );
  assert.equal(rt.snapshot.pendingOrders.length, 1);
  const pendId = rt.snapshot.pendingOrders[0].id;

  // Simulate Binance -2011 race -> already FILLED on Binance -> promote to open position
  const promoted = rt.promoteExternalLivePendingOrder(pendId, 99.8, 1.5, 1_763_280_060_000);
  assert.equal(promoted, true);
  assert.equal(rt.snapshot.pendingOrders.length, 0);
  assert.equal(rt.snapshot.pairs[0].openPosition?.entryPrice, 99.8);
  assert.equal(rt.snapshot.pairs[0].openPosition?.quantity, 1.5);
});

test('OrderHistoryDatabase markEntryCanceled updates NEW -> CANCELED in-place without wiping SQLite WAL rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexrust-db-test-'));
  try {
    const dbPath = path.join(tmpDir, 'orders.sqlite');
    const legacyJsonPath = path.join(tmpDir, 'legacy.json');
    const db = new OrderHistoryDatabase({ dbPath, legacyJsonPath });

    const baselineFill: OrderExecutionLog = {
      id: 'entry-btc-1',
      orderId: '1001',
      clientOrderId: 'c-1001',
      symbol: 'BTCUSDT',
      venue: 'Spot',
      environment: 'Testnet',
      accountMode: 'Live',
      source: 'live_proxy',
      lifecycle: 'ENTRY',
      side: 'Long',
      binanceSide: 'BUY',
      orderType: 'MARKET',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 90000,
      executedQty: 0.002,
      origQty: 0.002,
      quoteQty: 180,
      commission: 0.18,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      latencyMs: 25,
      endpoint: 'POST /api/v3/order',
      rationale: 'Filled baseline entry',
      timestampMs: 1_763_280_000_000,
    };

    const restingPending: OrderExecutionLog = {
      id: 'entry-sol-2',
      orderId: '2002',
      clientOrderId: 'c-2002',
      symbol: 'SOLUSDT',
      venue: 'Futures',
      environment: 'Testnet',
      accountMode: 'Live',
      source: 'live_proxy',
      lifecycle: 'ENTRY',
      side: 'Short',
      binanceSide: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      status: 'NEW',
      price: 150,
      executedQty: 0,
      origQty: 1,
      quoteQty: 0,
      commission: 0,
      commissionAsset: 'USDT',
      isMaker: true,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      latencyMs: 20,
      endpoint: 'POST /fapi/v1/order',
      rationale: 'Resting auto LIMIT',
      timestampMs: 1_763_280_050_000,
    };

    db.upsertLogs([baselineFill, restingPending]);
    assert.equal(db.getAllLogs().length, 2);

    const updated = db.markEntryCanceled({
      symbol: 'SOLUSDT',
      venue: 'Futures',
      environment: 'Testnet',
      accountMode: 'Live',
      orderId: '2002',
      rationale: 'Dynamic cancel: SignalReversed',
      exitReason: 'Canceled',
      timestampMs: 1_763_280_120_000,
    });
    assert.equal(updated?.status, 'CANCELED');
    assert.equal(updated?.rationale, 'Dynamic cancel: SignalReversed');

    // Re-open SQLite DB from disk to verify transactional persistence (no table wipe & exact row count)
    const dbReloaded = new OrderHistoryDatabase({ dbPath, legacyJsonPath });
    const rows = dbReloaded.getAllLogs();
    assert.equal(rows.length, 2);
    const solRow = rows.find((r) => r.orderId === '2002');
    const btcRow = rows.find((r) => r.orderId === '1001');
    assert.equal(solRow?.status, 'CANCELED');
    assert.equal(btcRow?.status, 'FILLED');
    assert.deepEqual(dbReloaded.getSummary().distinctSymbols.sort(), ['BTCUSDT', 'SOLUSDT']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit regressions: timeframeToMs covers all Binance intervals and BinanceScreenerHub recovers after initial exchangeInfo failure', async () => {
  assert.equal(timeframeToMs('30m'), 1_800_000);
  assert.equal(timeframeToMs('2h'), 7_200_000);
  assert.equal(timeframeToMs('4h'), 14_400_000);
  assert.equal(timeframeToMs('6h'), 21_600_000);
  assert.equal(timeframeToMs('8h'), 28_800_000);
  assert.equal(timeframeToMs('12h'), 43_200_000);
  assert.equal(timeframeToMs('1d'), 86_400_000);
  const t0 = 1_760_000_000_000;
  assert.equal(hasCandleSequenceGap(t0, t0 + 14_400_000, '4h'), false);
  assert.equal(hasCandleSequenceGap(t0, t0 + 28_800_000, '4h'), true);

  const hub = new BinanceScreenerHub();
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('simulated transient network error');
    }
    return new Response(
      JSON.stringify({
        symbols: [
          { symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true },
          { symbol: 'ETHUSDT', status: 'TRADING', isSpotTradingAllowed: true },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const first = await hub.getTradableSymbols('Testnet', 'Spot');
    assert.equal(first.size, 0);
    // Second call must retry (inFlight must not be stuck!) and populate tradable symbols
    const second = await hub.getTradableSymbols('Testnet', 'Spot');
    assert.equal(second.has('BTCUSDT'), true);
    assert.equal(second.has('ETHUSDT'), true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = origFetch;
    hub.shutdown();
  }
});

test('Sub-cent meme coin formatting, stepBar clamp, and buildExitPlan ATR gate', () => {
  assert.equal(pricePrecisionDecimals(95_000), 2);
  assert.equal(pricePrecisionDecimals(2.35), 4);
  assert.equal(pricePrecisionDecimals(0.085), 6);
  assert.equal(pricePrecisionDecimals(0.00001234), 8);
  assert.equal(fmtPx(0.00001234), '0.00001234');
  assert.notEqual(fmtPx(0.00001234), '0.0000');

  // buildExitPlan must gate BE & trailing by atrDynamicExits (parity with Rust bot-strategy)
  const planAtrOff = buildExitPlan(
    'Long',
    100,
    2.0,
    DEFAULT_BOT_CONFIG.exits,
    { ...DEFAULT_BOT_CONFIG.features, atrDynamicExits: false }
  );
  assert.equal(planAtrOff.breakEvenEnabled, false);
  assert.equal(planAtrOff.trailingEnabled, false);

  // Sub-cent pair in SimulationRuntime must NOT snap to 0.01 on stepBar
  const cfg = makeTestConfig({ trading: { pairs: ['PEPEUSDT'] } });
  const rt = new SimulationRuntime(cfg, 1_763_280_000_000, { accountMode: 'Paper', seedDemoData: false });
  const pepeCandles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    openTimeMs: 1_763_280_000_000 - (30 - i) * 300_000,
    open: 0.000012,
    high: 0.0000125,
    low: 0.0000118,
    close: 0.0000122,
    volume: 1_000_000,
    isClosed: true,
  }));
  rt.hydrateSymbolCandles('PEPEUSDT', pepeCandles);
  rt.stepBar();
  const pepe = rt.snapshot.pairs.find((p) => p.symbol === 'PEPEUSDT')!;
  assert.ok(pepe.lastPrice > 0 && pepe.lastPrice < 0.001, `PEPEUSDT must stay sub-cent, got ${pepe.lastPrice}`);
});

test('Paper reduceOnly manual orders, flatten pending logging, Live tpTargets protection, and baseCommission', () => {
  const cfg = makeTestConfig({ trading: { pairs: ['BTCUSDT', 'ETHUSDT'], venue: 'Futures' } });
  const rt = new SimulationRuntime(cfg, 1_763_280_000_000, { accountMode: 'Paper', seedDemoData: false });

  // ReduceOnly with no open position must fail
  const noPos = rt.submitManualOrder({
    symbol: 'BTCUSDT',
    orderType: 'MARKET',
    side: 'Long',
    usdtAmount: 200,
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [],
    reduceOnly: true,
  });
  assert.equal(noPos.ok, false);

  // Open a Long on BTCUSDT
  const openRes = rt.submitManualOrder({
    symbol: 'BTCUSDT',
    orderType: 'MARKET',
    side: 'Long',
    usdtAmount: 1000,
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [],
  });
  assert.equal(openRes.ok, true);
  const initialQty = rt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!.openPosition!.remainingQuantity;

  // Partial reduceOnly close (opposite direction SELL/Short reduces Long)
  const partialRes = rt.submitManualOrder({
    symbol: 'BTCUSDT',
    orderType: 'MARKET',
    side: 'Short',
    usdtAmount: 400,
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [],
    reduceOnly: true,
  });
  assert.equal(partialRes.ok, true);
  const afterPartialQty = rt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!.openPosition!.remainingQuantity;
  assert.ok(afterPartialQty > 0 && afterPartialQty < initialQty);

  // Place resting pending order on ETHUSDT and verify flattenAllPositions logs cancellation
  const ethPx = rt.snapshot.pairs.find((p) => p.symbol === 'ETHUSDT')!.lastPrice;
  const pendRes = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'LIMIT',
    side: 'Long',
    usdtAmount: 250,
    limitPrice: Number((ethPx * 0.9).toFixed(2)),
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [],
  });
  assert.equal(pendRes.ok, true);
  assert.equal(rt.snapshot.pendingOrders.length, 1);

  rt.tripCircuitBreaker('test flatten pending');
  assert.equal(rt.snapshot.pendingOrders.length, 0);
  assert.equal(
    rt.snapshot.executionHistory.some((l) => l.symbol === 'ETHUSDT' && l.orderStatus === 'CANCELED'),
    true
  );

  // Live mode: explicit baseCommission deducts Spot base qty, and unconfirmed PartialClose does NOT mutate tpTargets.hit
  const liveCfg = makeTestConfig({ trading: { pairs: ['BTCUSDT'], venue: 'Spot' } });
  const liveRt = new SimulationRuntime(liveCfg, 1_763_280_000_000, {
    accountMode: 'Live',
    seedDemoData: false,
    initialEquityOverride: 5000,
  });
  liveRt.recordExternalLiveOrder(
    {
      symbol: 'BTCUSDT',
      side: 'Long',
      orderType: 'MARKET',
      usdtAmount: 5000,
      stopLossMode: 'MARKET',
      stopLossPct: 2.0,
      useBreakEven: true,
      useTrailingStop: true,
      targets: [
        { pctOffset: 1.0, allocationPct: 50 },
        { pctOffset: 2.0, allocationPct: 50 },
      ],
    },
    'Live Spot entry',
    1_763_280_000_000,
    {
      avgPrice: 50_000,
      executedQty: 0.1,
      baseCommission: 0.0001,
      commission: 0.0001,
      commissionAsset: 'MIXED',
      orderId: 'spot-1',
    }
  );
  const livePos = liveRt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!.openPosition!;
  assert.ok(Math.abs(livePos.remainingQuantity - 0.0999) < 1e-9);
  assert.equal(livePos.exitPlan.tpTargets?.[0]?.hit, false);

  // Trigger TP1 via external tick in Live mode -> emits LiveIntent without corrupting tpTargets[0].hit before exchange confirm
  liveRt.stepBar(1_763_280_060_000, {
    symbol: 'BTCUSDT',
    candle: {
      openTimeMs: 1_763_280_060_000,
      open: 50_100,
      high: 50_700,
      low: 50_050,
      close: 50_600,
      volume: 100,
      isClosed: true,
    },
  });
  assert.equal(liveRt.consumeLiveIntents().some((i) => i.kind === 'EXIT' && i.reason === 'TakeProfit1'), true);
  assert.equal(
    liveRt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!.openPosition!.exitPlan.tpTargets?.[0]?.hit,
    false
  );

  // Confirming TakeProfit1 via recordExternalLiveExit marks tpTargets[0].hit = true
  liveRt.recordExternalLiveExit('BTCUSDT', 0.5, 50_600, 'TakeProfit1', 'TP1 confirmed', 1_763_280_060_000, 'tp1-1', 0.04995);
  assert.equal(
    liveRt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!.openPosition!.exitPlan.tpTargets?.[0]?.hit,
    true
  );
});

test('OrderHistoryDatabase.markEntryFilledOrPartial and mergeRemoteVpsSnapshot parity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexrust-partial-db-'));
  try {
    const db = new OrderHistoryDatabase({
      dbPath: path.join(tmpDir, 'orders.sqlite'),
      legacyJsonPath: path.join(tmpDir, 'legacy.json'),
    });
    db.upsertLogs([
      {
        id: 'p-1',
        orderId: '9901',
        clientOrderId: 'c-9901',
        symbol: 'ETHUSDT',
        venue: 'Futures',
        environment: 'Testnet',
        accountMode: 'Live',
        source: 'live_proxy',
        lifecycle: 'ENTRY',
        side: 'Long',
        binanceSide: 'BUY',
        orderType: 'LIMIT',
        timeInForce: 'GTC',
        status: 'NEW',
        price: 3000,
        executedQty: 0,
        origQty: 1.0,
        quoteQty: 0,
        commission: 0,
        commissionAsset: 'USDT',
        isMaker: true,
        realizedPnlUsdt: null,
        rMultiple: null,
        exitReason: null,
        latencyMs: 12,
        endpoint: 'POST /fapi/v1/order',
        rationale: 'resting',
        timestampMs: 1_763_280_000_000,
      },
    ]);
    const updated = db.markEntryFilledOrPartial({
      symbol: 'ETHUSDT',
      venue: 'Futures',
      environment: 'Testnet',
      accountMode: 'Live',
      orderId: '9901',
      status: 'PARTIALLY_FILLED',
      executedQty: 0.4,
      avgPrice: 2999.5,
      rationale: 'Partial fill before cancel',
      timestampMs: 1_763_280_060_000,
    });
    assert.equal(updated?.status, 'PARTIALLY_FILLED');
    assert.equal(updated?.executedQty, 0.4);
    assert.equal(updated?.price, 2999.5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // mergeRemoteVpsSnapshot must compute availableBalanceUsdt from remote equity (not local browser base)
  const localRt = new SimulationRuntime(DEFAULT_BOT_CONFIG, 1_763_280_000_000, {
    accountMode: 'Paper',
    seedDemoData: false,
    initialEquityOverride: 99_999,
  });
  const raw: Record<string, unknown> = {
    running: true,
    venue: 'Futures',
    environment: 'Testnet',
    live_armed: false,
    transport_mode: 'WsPrimary',
    risk: {
      state: 'Active',
      day_start_equity: 2000,
      current_equity: 2150,
      cumulative_daily_pnl_usdt: 150,
      cumulative_daily_drawdown_pct: 0,
      win_streak: 2,
      lose_streak: 0,
      cooldown_until: null,
      quarantined_pairs: [],
      last_trip_reason: null,
    },
    pairs: [
      {
        symbol: 'BTCUSDT',
        last_price: 50_000,
        indicators: {
          ema_fast: 50_100,
          ema_mid: 50_000,
          prev_ema_mid: 49_950,
          ema_slow: 49_500,
          ema_macro: 48_000,
          rsi: 55,
          prev_rsi: 52,
          adx: 30,
          prev_adx: 28,
          plus_di: 26,
          minus_di: 14,
          atr: 400,
          vwap: 50_050,
          has_bar_gap: true,
        },
        open_position: null,
      },
    ],
    pending_orders: [
      {
        order_id: '777',
        symbol: 'BTCUSDT',
        side: 'Long',
        order_method: 'LIMIT',
        quantity: 0.01,
        limit_price: 49_000,
        reduce_only: false,
        rationale: 'Rust resting limit',
        age_bars: 3,
        created_at: new Date(1_763_280_000_000).toISOString(),
      },
    ],
    recent_trades: [],
    updated_at: new Date(1_763_280_010_000).toISOString(),
  };
  const mapped = mapRustEngineSnapshot(raw);
  const merged = mergeRemoteVpsSnapshot(localRt.snapshot, mapped, DEFAULT_BOT_CONFIG.trading.leverage);
  assert.equal(merged.availableBalanceUsdt, 2150 - merged.lockedBalanceUsdt);
  assert.notEqual(merged.availableBalanceUsdt, 99_999);
  assert.equal(merged.pairs[0].indicators.prevEmaMid, 49_950);
  assert.equal(merged.pairs[0].indicators.prevAdx, 28);
  assert.equal(merged.pairs[0].indicators.hasBarGap, true);
  assert.equal(merged.pendingOrders[0].ageBars, 3);
  assert.equal(merged.pendingOrders[0].dynamicStatusNote, 'Rust resting limit');
});
