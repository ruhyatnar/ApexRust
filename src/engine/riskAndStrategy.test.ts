import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from './risk';
import { DEFAULT_BOT_CONFIG, SimulationRuntime } from './simulator';
import { buildExitPlan, evaluateEntrySignal, managePositionTick } from './strategy';
import {
  calculateQuantitativePositionSizeUsdt,
  computeExpectancyStats,
  computeKellySizingAnalytics,
  computePortfolioCorrelationMatrix,
  evaluatePreTradeValidation,
} from './quantAnalytics';
import type { Candle, IndicatorSnapshot, Position } from './types';

test('evaluateEntrySignal generates Long signal only when EMA, ADX, RSI curl, and VWAP align', () => {
  const candle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 102,
    high: 103.2,
    low: 101.8,
    close: 103,
    volume: 5000,
    isClosed: true,
  };
  const bullishInd: IndicatorSnapshot = {
    emaFast: 102.5,
    emaMid: 101.8,
    emaSlow: 100.5,
    emaMacro: 98.0,
    rsi: 51.2,
    prevRsi: 47.9,
    adx: 31.4,
    plusDi: 28.0,
    minusDi: 14.0,
    atr: 1.5,
    vwap: 102.1,
  };

  const sig = evaluateEntrySignal(
    'SOLUSDT',
    candle,
    bullishInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    candle.openTimeMs
  );
  assert.ok(sig !== null);
  assert.equal(sig.side, 'Long');

  // Choppy market (ADX < 25) must reject entry
  const choppyInd: IndicatorSnapshot = { ...bullishInd, adx: 18.2 };
  const blocked = evaluateEntrySignal(
    'SOLUSDT',
    candle,
    choppyInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    candle.openTimeMs
  );
  assert.equal(blocked, null);
});

test('ATR ExitPlan arms Break-Even at 1R and ratchets Trailing Stop monotonically', () => {
  const plan = buildExitPlan('Long', 100, 2.0, DEFAULT_BOT_CONFIG.exits);
  assert.equal(plan.initialStopLoss, 97); // 100 - 1.5 * 2.0
  assert.equal(plan.riskDistanceR, 3);

  const pos: Position = {
    id: 'pos-1',
    symbol: 'ETHUSDT',
    side: 'Long',
    entryPrice: 100,
    quantity: 10,
    remainingQuantity: 10,
    lockedMarginUsdt: 250,
    unrealizedPnlUsdt: 0,
    realizedPnlUsdt: 0,
    highestFavorablePrice: 100,
    exitPlan: plan,
    openedAtMs: 1_763_280_000_000,
    rationale: 'test',
  };

  // Price moves +1.05R (103.15) -> Break-Even armed above entry
  const act1 = managePositionTick(pos, 103.15, 2.0, DEFAULT_BOT_CONFIG.exits);
  assert.equal(act1.type, 'Hold');
  assert.equal(pos.exitPlan.breakEvenArmed, true);
  assert.ok(pos.exitPlan.activeStopLoss > 100);

  // Price moves +1.4R (104.2) -> Trailing stop active
  managePositionTick(pos, 104.2, 2.0, DEFAULT_BOT_CONFIG.exits);
  assert.equal(pos.exitPlan.trailingActive, true);
  const trailSl = pos.exitPlan.activeStopLoss;
  assert.ok(Math.abs(trailSl - (104.2 - 2.0 * 1.4)) < 1e-6);

  // Price dips slightly (103.5) -> Stop loss MUST NOT move backward
  managePositionTick(pos, 103.5, 2.0, DEFAULT_BOT_CONFIG.exits);
  assert.equal(pos.exitPlan.activeStopLoss, trailSl);
});

test('RiskManager enforces per-pair quarantine, lose streak cooldown, and cumulative drawdown circuit breaker', () => {
  const now = 1_763_280_000_000;
  const rm = new RiskManager(DEFAULT_BOT_CONFIG.risk, DEFAULT_BOT_CONFIG.trading, now);

  // Per-pair drawdown limit is 1.25% of 10,000 = $125
  rm.recordRealizedPnl('AVAXUSDT', -130, now);
  assert.ok(rm.status().quarantinedPairs.includes('AVAXUSDT'));
  const avaxAuth = rm.authorizeEntry('AVAXUSDT', 40, 39, 0, now + 1000);
  assert.equal(avaxAuth.ok, false);

  // Consecutive losses -> loseStreak 3 triggers Cooldown
  rm.recordRealizedPnl('BTCUSDT', -50, now + 2000);
  rm.recordRealizedPnl('ETHUSDT', -50, now + 3000);
  assert.equal(rm.status().loseStreak, 3);
  assert.equal(rm.status().state, 'Cooldown');

  // Cumulative drawdown >= 3.0% ($300) trips Halted circuit breaker
  rm.recordRealizedPnl('SOLUSDT', -100, now + 4000);
  assert.equal(rm.status().state, 'Halted');
  const btcAuth = rm.authorizeEntry('BTCUSDT', 90000, 89000, 0, now + 5000);
  assert.equal(btcAuth.ok, false);

  // Reset restores Active state
  rm.resetCircuitBreaker();
  assert.equal(rm.status().state, 'Active');
});

test('SimulationRuntime handles WebSocket -> REST fallback failover and circuit breaker flatten', () => {
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  assert.equal(rt.snapshot.transport.mode, 'WsPrimary');
  rt.setTransportMode('RestFallback', 'Simulated WS timeout');
  assert.equal(rt.snapshot.transport.mode, 'RestFallback');
  assert.equal(rt.snapshot.transport.failoverCount, 1);

  rt.tripCircuitBreaker('Manual panic drill');
  assert.equal(rt.snapshot.risk.state, 'Halted');
  assert.equal(rt.snapshot.pairs.every((p) => p.openPosition === null), true);
});

test('SimulationRuntime submits manual OCO multi-target order and locks balance cleanly', () => {
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  const availBefore = rt.snapshot.availableBalanceUsdt;
  const res = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'OCO SELL',
    side: 'Long',
    usdtAmount: 500,
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [
      { pctOffset: 2.5, allocationPct: 50 },
      { pctOffset: 3.6, allocationPct: 50 },
    ],
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.ok(res.position !== undefined);
    assert.equal(res.position.exitPlan.tpTargets?.length, 2);
    assert.ok(rt.snapshot.lockedBalanceUsdt >= 500);
    assert.ok(rt.snapshot.availableBalanceUsdt < availBefore);
  }
});

test('Paper and Live SimulationRuntime instances maintain strict account isolation', () => {
  const paper = new SimulationRuntime(DEFAULT_BOT_CONFIG, Date.now(), {
    accountMode: 'Paper',
    seedDemoData: true,
  });
  const live = new SimulationRuntime(DEFAULT_BOT_CONFIG, Date.now(), {
    accountMode: 'Live',
    seedDemoData: false,
    initialEquityOverride: 0,
  });

  assert.equal(paper.snapshot.accountMode, 'Paper');
  assert.equal(live.snapshot.accountMode, 'Live');
  assert.ok(paper.snapshot.risk.currentEquity > 9000);
  assert.equal(live.snapshot.risk.currentEquity, 0);
  assert.equal(live.snapshot.recentTrades.length, 0);
  assert.equal(live.snapshot.pairs.filter((p) => p.openPosition !== null).length, 0);

  // Mutating Paper equity or tripping Paper CB does not leak to Live
  paper.simulateLossStress('BTCUSDT', 500);
  assert.equal(paper.snapshot.risk.state, 'Halted');
  assert.equal(live.snapshot.risk.state, 'Active');

  // Syncing live balance only updates Live runtime
  live.syncLiveAccountBalance(1450.25, 120.0);
  assert.equal(live.snapshot.availableBalanceUsdt, 1450.25);
  assert.equal(live.snapshot.lockedBalanceUsdt, 120.0);
  assert.equal(live.snapshot.risk.currentEquity, 1570.25);
});

test('Strategy profiles evaluate ema_breakout and vwap_reversion and honor long_only policy', () => {
  const baseCandles: Candle[] = Array.from({ length: 12 }, (_, idx) => ({
    openTimeMs: 1_763_280_000_000 + idx * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    isClosed: true,
  }));
  const breakoutCandle: Candle = {
    openTimeMs: 1_763_280_000_000 + 12 * 60_000,
    open: 100.8,
    high: 102.5,
    low: 100.6,
    close: 102.2,
    volume: 1600,
    isClosed: true,
  };
  const breakoutInd: IndicatorSnapshot = {
    emaFast: 101.4,
    emaMid: 100.7,
    emaSlow: 99.8,
    emaMacro: 97.5,
    rsi: 61.5,
    prevRsi: 57.0,
    adx: 29.0,
    plusDi: 27.0,
    minusDi: 13.0,
    atr: 1.2,
    vwap: 100.9,
  };

  const breakoutSig = evaluateEntrySignal(
    'BTCUSDT',
    breakoutCandle,
    breakoutInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    breakoutCandle.openTimeMs,
    {
      strategyProfile: 'ema_breakout',
      directionPolicy: 'long_only',
      recentCandles: [...baseCandles, breakoutCandle],
    }
  );
  assert.ok(breakoutSig !== null);
  assert.equal(breakoutSig.side, 'Long');
  assert.match(breakoutSig.rationale, /Momentum Breakout Long/);

  // VWAP Reversion short should be suppressed under long_only, allowed under both
  const stretchCandle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 103.5,
    high: 103.8,
    low: 102.6,
    close: 102.8,
    volume: 1200,
    isClosed: true,
  };
  const stretchInd: IndicatorSnapshot = {
    emaFast: 102.0,
    emaMid: 101.0,
    emaSlow: 100.0,
    emaMacro: 99.0,
    rsi: 65.0,
    prevRsi: 68.5,
    adx: 22.0,
    plusDi: 20.0,
    minusDi: 18.0,
    atr: 1.0,
    vwap: 100.0,
  };
  const blockedShort = evaluateEntrySignal(
    'ETHUSDT',
    stretchCandle,
    stretchInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    stretchCandle.openTimeMs,
    { strategyProfile: 'vwap_reversion', directionPolicy: 'long_only' }
  );
  assert.equal(blockedShort, null);

  const allowedShort = evaluateEntrySignal(
    'ETHUSDT',
    stretchCandle,
    stretchInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    stretchCandle.openTimeMs,
    { strategyProfile: 'vwap_reversion', directionPolicy: 'both' }
  );
  assert.ok(allowedShort !== null);
  assert.equal(allowedShort.side, 'Short');
});

test('Resting LIMIT and LIMIT MAKER enforce Post-Only, lock funds, fill on bar touch, and cancel cleanly', () => {
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  const eth = rt.snapshot.pairs.find((p) => p.symbol === 'ETHUSDT')!;
  const lastPx = eth.lastPrice;

  // Crossing LIMIT MAKER must be rejected
  const crossRes = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'LIMIT MAKER',
    side: 'Long',
    usdtAmount: 200,
    limitPrice: lastPx * 1.01,
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(crossRes.ok, false);

  // Passive LIMIT MAKER below market rests in pendingOrders and locks balance
  const availBefore = rt.snapshot.availableBalanceUsdt;
  const passivePx = Number((lastPx * 0.985).toFixed(2));
  const restRes = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'LIMIT MAKER',
    side: 'Long',
    usdtAmount: 200,
    limitPrice: passivePx,
    timeInForce: 'GTC',
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(restRes.ok, true);
  assert.equal(rt.snapshot.pendingOrders.length, 1);
  assert.ok(rt.snapshot.availableBalanceUsdt <= availBefore - 199);

  // Cancel frees locked margin cleanly
  const orderId = rt.snapshot.pendingOrders[0].id;
  assert.equal(rt.cancelPendingOrder(orderId), true);
  assert.equal(rt.snapshot.pendingOrders.length, 0);
  assert.ok(Math.abs(rt.snapshot.availableBalanceUsdt - availBefore) < 0.01);

  // Re-submit passive LIMIT and trigger fill via candle low <= limitPrice
  const limitRes = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'LIMIT',
    side: 'Long',
    usdtAmount: 200,
    limitPrice: passivePx,
    timeInForce: 'GTC',
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(limitRes.ok, true);
  assert.equal(rt.snapshot.pendingOrders.length, 1);

  rt.stepBar(Date.now(), {
    symbol: 'ETHUSDT',
    candle: {
      openTimeMs: eth.candles[eth.candles.length - 1].openTimeMs + 300_000,
      open: lastPx,
      high: lastPx * 1.001,
      low: passivePx * 0.999,
      close: passivePx * 1.002,
      volume: 5000,
      isClosed: true,
    },
  });
  assert.equal(rt.snapshot.pendingOrders.length, 0);
  const ethAfter = rt.snapshot.pairs.find((p) => p.symbol === 'ETHUSDT')!;
  assert.ok(ethAfter.openPosition !== null);
  assert.equal(ethAfter.openPosition?.entryPrice, passivePx);
});

test('runAutoScanNow increments scan stats and Live mode queues LiveAutoIntent instead of fake fills', () => {
  const live = new SimulationRuntime(DEFAULT_BOT_CONFIG, Date.now(), {
    accountMode: 'Live',
    seedDemoData: false,
    initialEquityOverride: 0,
  });
  live.syncLiveAccountBalance(1000, 0);

  // Feed a strong VWAP Reversion Long setup on SOLUSDT
  live.updateConfig({
    ...DEFAULT_BOT_CONFIG,
    automation: {
      ...DEFAULT_BOT_CONFIG.automation,
      enabled: true,
      strategyProfile: 'vwap_reversion',
      directionPolicy: 'long_only',
      orderMethod: 'LIMIT',
      limitOffsetBps: 10,
      autoOrderNotionalUsdt: 120,
    },
  });
  const sol = live.snapshot.pairs.find((p) => p.symbol === 'SOLUSDT')!;
  const vwap = sol.indicators.vwap ?? sol.lastPrice;
  const atr = sol.indicators.atr ?? 1.5;
  sol.indicators.rsi = 34;
  sol.indicators.prevRsi = 31;
  sol.indicators.adx = 24;
  sol.candles[sol.candles.length - 1] = {
    ...sol.candles[sol.candles.length - 1],
    close: vwap - atr * 1.5,
  };

  const scan = live.runAutoScanNow(Date.now());
  assert.equal(scan.scannedPairs, 5);
  assert.ok(live.snapshot.autoStats.scansRun >= 1);
  assert.ok(scan.signalsDetected >= 1);
  assert.ok(scan.dispatched >= 1);
  // Live runtime MUST NOT invent a local position fill before /api/live/order confirms
  assert.equal(sol.openPosition, null);

  const intents = live.consumeLiveIntents();
  assert.ok(intents.length >= 1);
  assert.equal(intents[0].kind, 'ENTRY');
  assert.equal(intents[0].orderMethod, 'LIMIT');
});

test('FeatureToggles independently gate signalGenerator, manualTrading, breakEvenStop, trailingStop, and circuitBreaker', () => {
  const candle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 102,
    high: 103.2,
    low: 101.8,
    close: 103,
    volume: 5000,
    isClosed: true,
  };
  const bullishInd: IndicatorSnapshot = {
    emaFast: 102.5,
    emaMid: 101.8,
    emaSlow: 100.5,
    emaMacro: 98.0,
    rsi: 51.2,
    prevRsi: 47.9,
    adx: 31.4,
    plusDi: 28.0,
    minusDi: 14.0,
    atr: 1.5,
    vwap: 102.1,
  };

  // Disabling signalGenerator blocks signals even on perfect alignment
  const noSig = evaluateEntrySignal(
    'SOLUSDT',
    candle,
    bullishInd,
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    candle.openTimeMs,
    {
      features: { signalGenerator: false },
    }
  );
  assert.equal(noSig, null);

  // Disabling breakEvenStop & trailingStop keeps activeStopLoss frozen at initial SL
  const plan = buildExitPlan('Long', 100, 2.0, DEFAULT_BOT_CONFIG.exits);
  const pos: Position = {
    id: 'pos-ft',
    symbol: 'ETHUSDT',
    side: 'Long',
    entryPrice: 100,
    quantity: 10,
    remainingQuantity: 10,
    lockedMarginUsdt: 250,
    unrealizedPnlUsdt: 0,
    realizedPnlUsdt: 0,
    highestFavorablePrice: 100,
    exitPlan: plan,
    openedAtMs: 1_763_280_000_000,
    rationale: 'test',
  };
  managePositionTick(pos, 104.5, 2.0, DEFAULT_BOT_CONFIG.exits, {
    breakEvenStop: false,
    trailingStop: false,
  });
  assert.equal(pos.exitPlan.breakEvenArmed, false);
  assert.equal(pos.exitPlan.trailingActive, false);
  assert.equal(pos.exitPlan.activeStopLoss, 97);

  // Disabling manualTrading blocks submitManualOrder
  const rt = new SimulationRuntime({
    ...DEFAULT_BOT_CONFIG,
    features: { ...DEFAULT_BOT_CONFIG.features, manualTrading: false },
  });
  const manualBlocked = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'MARKET',
    side: 'Long',
    usdtAmount: 100,
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(manualBlocked.ok, false);
});

test('setVenue switches Spot/Futures endpoints and Futures leverage scales locked margin', () => {
  const futuresCfg = {
    ...DEFAULT_BOT_CONFIG,
    trading: {
      ...DEFAULT_BOT_CONFIG.trading,
      venue: 'Futures' as const,
      leverage: 5,
      marginType: 'ISOLATED' as const,
    },
  };
  const rt = new SimulationRuntime(futuresCfg);
  assert.equal(rt.snapshot.transport.venue, 'Futures');
  assert.match(rt.snapshot.transport.wsEndpoint, /binancefuture\.com/);
  assert.match(rt.snapshot.transport.restEndpoint, /fapi\/v1/);

  const res = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'MARKET',
    side: 'Short',
    usdtAmount: 500,
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(res.ok, true);
  if (res.ok && res.position) {
    // At 5x leverage, $500 notional locks ~$100 margin instead of $500
    assert.ok(res.position.lockedMarginUsdt <= 105);
    assert.ok(res.position.lockedMarginUsdt >= 95);
  }

  rt.setVenue('Spot');
  assert.equal(rt.snapshot.transport.venue, 'Spot');
  assert.match(rt.snapshot.transport.wsEndpoint, /binance\.vision/);
});

test('executionHistory tracks filled ENTRY orders, partial TP1 exits, and full EXIT fills with Binance schema fields', () => {
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  const initialCount = rt.snapshot.executionHistory.length;
  assert.ok(initialCount >= 7);

  // Submit a manual OCO SELL entry on ETHUSDT
  const entryRes = rt.submitManualOrder(
    {
      symbol: 'ETHUSDT',
      orderType: 'OCO SELL',
      side: 'Long',
      usdtAmount: 300,
      stopLossMode: 'ATR',
      stopLossPct: 1.5,
      useBreakEven: true,
      useTrailingStop: true,
      targets: [
        { pctOffset: 1.5, allocationPct: 50 },
        { pctOffset: 3.0, allocationPct: 50 },
      ],
    },
    1_763_290_000_000
  );
  assert.equal(entryRes.ok, true);
  assert.equal(rt.snapshot.executionHistory.length, initialCount + 1);

  const entryRec = rt.snapshot.executionHistory[0];
  assert.equal(entryRec.symbol, 'ETHUSDT');
  assert.equal(entryRec.lifecycle, 'ENTRY');
  assert.equal(entryRec.binanceSide, 'BUY');
  assert.equal(entryRec.execType, 'TRADE');
  assert.equal(entryRec.orderStatus, 'FILLED');
  assert.ok(entryRec.orderListId > 0);
  assert.equal(entryRec.realizedPnlUsdt, null);
  assert.ok(entryRec.cummulativeQuoteQty > 299 && entryRec.cummulativeQuoteQty <= 301);
  assert.ok(entryRec.commission > 0);

  // Close ETHUSDT manually and verify EXIT record is logged
  rt.closePositionBySymbol('ETHUSDT', 1_763_290_060_000);
  assert.equal(rt.snapshot.executionHistory.length, initialCount + 2);
  const exitRec = rt.snapshot.executionHistory[0];
  assert.equal(exitRec.symbol, 'ETHUSDT');
  assert.equal(exitRec.lifecycle, 'EXIT');
  assert.equal(exitRec.binanceSide, 'SELL');
  assert.equal(exitRec.orderStatus, 'FILLED');
  assert.equal(exitRec.exitReason, 'ManualClose');
  assert.notEqual(exitRec.realizedPnlUsdt, null);
});

test('Executive Briefing §5: Fractional Kelly & Stop-Distance Notional Position Sizing matches worked example', () => {
  // Briefing §5 Worked Example: p = 0.58, q = 0.42, b = 1.5 -> f* = (1.5*0.58 - 0.42)/1.5 = 0.30 (30%)
  // Half-Kelly = 15%, Quarter-Kelly = 7.5%
  const expectancy = {
    sampleCount: 55,
    isStatisticallySignificant: true,
    winCount: 32,
    lossCount: 23,
    winRateP: 0.58,
    lossRateQ: 0.42,
    avgWinUsdt: 150,
    avgLossUsdt: 100,
    avgWinR: 1.5,
    avgLossR: 1.0,
    payoffRatioB: 1.5,
    expectancyR: 0.58 * 1.5 - 0.42 * 1.0, // +0.45R
    expectancyUsdt: 0.58 * 150 - 0.42 * 100, // $45
    grossProfitUsdt: 4800,
    grossLossUsdt: 2300,
    profitFactor: 4800 / 2300,
    profitFactorRegime: 'StrongEdge' as const,
    expectedMaxLossStreak500: 7,
    streak12DrawdownAtCurrentRiskPct: 8.6,
    streak12DrawdownAt5PctRisk: 46.0,
    streak12DrawdownAt1PctRisk: 11.4,
  };

  // Account Equity = $25,000, Entry = $50,000, Stop = $49,000 (2% stop distance = 0.02)
  const kelly = computeKellySizingAnalytics(expectancy, 25_000, 0.02, 1.5);
  assert.ok(Math.abs(kelly.rawFullKellyFraction - 0.30) < 1e-6);
  assert.ok(Math.abs(kelly.fullKellyPct - 30.0) < 1e-4);
  assert.ok(Math.abs(kelly.halfKellyPct - 15.0) < 1e-4);
  assert.ok(Math.abs(kelly.quarterKellyPct - 7.5) < 1e-4);
  assert.equal(kelly.negativeExpectancyWarning, false);

  // At Half-Kelly (15% of $25,000 = $3,750 dollar risk) and 2% stop distance,
  // theoretical stop-distance notional = $3,750 / 0.02 = $187,500
  const halfKellyTier = kelly.tiers.find((t) => t.id === 'half_kelly')!;
  assert.ok(Math.abs(halfKellyTier.capitalRiskPerTradeUsdt - 3_750) < 1e-4);
  assert.ok(Math.abs(halfKellyTier.notionalPositionUsdt - 187_500) < 1e-2);

  // Verify Negative Kelly filter blocks automated entries when EV <= 0 (e.g. p = 0.35, b = 1.2 -> f* < 0)
  const negativeExpectancy = {
    ...expectancy,
    winRateP: 0.35,
    lossRateQ: 0.65,
    payoffRatioB: 1.2,
    expectancyR: 0.35 * 1.2 - 0.65,
  };
  const negKelly = computeKellySizingAnalytics(negativeExpectancy, 25_000, 0.02, 1.5);
  assert.equal(negKelly.negativeExpectancyWarning, true);
  assert.equal(negKelly.rawFullKellyFraction < 0, true);

  const blockedSize = calculateQuantitativePositionSizeUsdt({
    mode: 'half_kelly',
    fixedUsdt: 250,
    equityUsdt: 25_000,
    availableBalanceUsdt: 25_000,
    baseRiskPerTradePct: 1.5,
    entryPrice: 50_000,
    stopLossPrice: 49_000,
    kelly: negKelly,
    venue: 'Futures',
    leverage: 5,
  });
  assert.equal(blockedSize.blockedByNegativeKelly, true);
  assert.equal(blockedSize.notionalUsdt, 0);
});

test('Executive Briefing §2, §3 & §6: Volume Expansion Confirmation, 9-Step Signal Validation & Portfolio Covariance Kelly Matrix', () => {
  const candle: Candle = {
    openTimeMs: 1_763_280_000_000,
    open: 102,
    high: 103.2,
    low: 101.8,
    close: 103,
    volume: 5000,
    isClosed: true,
  };
  const lowVolInd: IndicatorSnapshot = {
    emaFast: 102.5,
    emaMid: 101.8,
    emaSlow: 100.5,
    emaMacro: 98.0,
    rsi: 51.2,
    prevRsi: 47.9,
    adx: 31.4,
    plusDi: 28.0,
    minusDi: 14.0,
    atr: 1.5,
    vwap: 102.1,
    volumeSma20: 5000,
    volumeRatio: 1.0, // 1.0x < 1.5x required surge
  };

  // When volumeConfirmationFilter is enabled, 1.0x volume ratio is rejected
  const rejectedLowVol = evaluateEntrySignal(
    'SOLUSDT',
    candle,
    lowVolInd,
    DEFAULT_BOT_CONFIG.trading,
    { ...DEFAULT_BOT_CONFIG.indicators, minVolumeExpansionMult: 1.5 },
    candle.openTimeMs,
    { features: { ...DEFAULT_BOT_CONFIG.features, volumeConfirmationFilter: true } }
  );
  assert.equal(rejectedLowVol, null);

  // When volumeRatio is 1.85x (>= 1.5x), entry signal passes
  const highVolInd: IndicatorSnapshot = { ...lowVolInd, volumeRatio: 1.85 };
  const acceptedHighVol = evaluateEntrySignal(
    'SOLUSDT',
    candle,
    highVolInd,
    DEFAULT_BOT_CONFIG.trading,
    { ...DEFAULT_BOT_CONFIG.indicators, minVolumeExpansionMult: 1.5 },
    candle.openTimeMs,
    { features: { ...DEFAULT_BOT_CONFIG.features, volumeConfirmationFilter: true } }
  );
  assert.ok(acceptedHighVol !== null);
  assert.equal(acceptedHighVol.side, 'Long');

  // Verify Runtime Snapshot works with Expectancy, Kelly, Portfolio Correlation Matrix, and 9-Step Validation
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  const exp = computeExpectancyStats(rt.snapshot.recentTrades, DEFAULT_BOT_CONFIG.trading.baseRiskPerTradePct);
  assert.ok(exp.profitFactor > 1.0);
  const kelly = computeKellySizingAnalytics(exp, rt.snapshot.risk.currentEquity, 0.015, DEFAULT_BOT_CONFIG.trading.baseRiskPerTradePct);
  assert.ok(kelly.growthCurve.length > 10);
  const corr = computePortfolioCorrelationMatrix(rt.snapshot.pairs, kelly.halfKellyPct);
  assert.equal(corr.symbols.length, DEFAULT_BOT_CONFIG.trading.pairs.length);
  assert.equal(corr.matrix.length, DEFAULT_BOT_CONFIG.trading.pairs.length);

  const solPair = rt.snapshot.pairs.find((p) => p.symbol === 'SOLUSDT')!;
  const validation = evaluatePreTradeValidation({
    pair: solPair,
    side: 'Long',
    entryPrice: solPair.lastPrice,
    stopLossPrice: solPair.lastPrice * 0.985,
    takeProfit1Price: solPair.lastPrice * 1.015,
    takeProfit2Price: solPair.lastPrice * 1.03,
    notionalUsdt: 250,
    equityUsdt: rt.snapshot.risk.currentEquity,
    config: DEFAULT_BOT_CONFIG,
  });
  assert.equal(validation.steps.length, 9);
  assert.equal(validation.mtfAlignment.length, 4);
  assert.ok(validation.invalidationPrice > 0);
});

test('ATR Volatility Spike Alerts monitor ATR expansion, queue browser notifications, and respect enable toggle', () => {
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  assert.equal((rt.snapshot.volatilityAlerts ?? []).length, 0);

  // Trigger a simulated ATR spike on ETHUSDT
  const spike = rt.simulateVolatilitySpike('ETHUSDT', 1_763_300_000_000);
  assert.ok(spike !== null);
  assert.equal(spike.symbol, 'ETHUSDT');
  assert.ok(spike.atr > 0);
  assert.ok(spike.atrExpansionRatio >= 1.2);
  assert.equal((rt.snapshot.volatilityAlerts ?? []).length, 1);

  const pending = rt.consumePendingVolatilityAlerts();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].symbol, 'ETHUSDT');
  assert.equal(rt.consumePendingVolatilityAlerts().length, 0);

  // Disabling volatilityAlertsEnabled prevents new spike alerts
  rt.updateConfig({
    ...DEFAULT_BOT_CONFIG,
    indicators: {
      ...DEFAULT_BOT_CONFIG.indicators,
      volatilityAlertsEnabled: false,
    },
  });
  const blockedSpike = rt.simulateVolatilitySpike('SOLUSDT', 1_763_300_120_000);
  assert.equal(blockedSpike, null);
  assert.equal(rt.consumePendingVolatilityAlerts().length, 0);
});

test('Audit fixes: unclosed WS bars do not mutate indicators, breakEvenArmed starts false, IOC/FOK non-crossing limits expire, zero-PnL keeps streaks neutral, and profitFactor returns Infinity', () => {
  // 1. breakEvenArmed initializes to false and initial SL stop-out reports StopLoss (not BreakEvenStop)
  const rt = new SimulationRuntime(DEFAULT_BOT_CONFIG);
  const eth = rt.snapshot.pairs.find((p) => p.symbol === 'ETHUSDT')!;
  const openRes = rt.submitManualOrder({
    symbol: 'ETHUSDT',
    orderType: 'MARKET',
    side: 'Long',
    usdtAmount: 200,
    stopLossMode: 'MARKET',
    stopLossPct: 2.0,
    useBreakEven: true,
    useTrailingStop: false,
    targets: [{ pctOffset: 4.0, allocationPct: 100 }],
  });
  assert.equal(openRes.ok, true);
  if (openRes.ok && openRes.position) {
    assert.equal(openRes.position.exitPlan.breakEvenArmed, false);
    assert.equal(openRes.position.exitPlan.breakEvenEnabled, true);
    const slPrice = openRes.position.exitPlan.initialStopLoss;
    const stopTick = managePositionTick(openRes.position, slPrice - 0.1, 10, DEFAULT_BOT_CONFIG.exits);
    assert.equal(stopTick.type, 'FullClose');
    if (stopTick.type === 'FullClose') {
      assert.equal(stopTick.reason, 'StopLoss');
    }
  }

  // 2. Non-crossing IOC / FOK LIMIT orders expire immediately instead of resting
  const sol = rt.snapshot.pairs.find((p) => p.symbol === 'SOLUSDT')!;
  const iocRes = rt.submitManualOrder({
    symbol: 'SOLUSDT',
    orderType: 'LIMIT',
    side: 'Long',
    usdtAmount: 150,
    limitPrice: Number((sol.lastPrice * 0.95).toFixed(2)),
    timeInForce: 'IOC',
    stopLossMode: 'ATR',
    stopLossPct: 1.5,
    useBreakEven: true,
    useTrailingStop: true,
    targets: [{ pctOffset: 2.5, allocationPct: 100 }],
  });
  assert.equal(iocRes.ok, false);
  assert.equal(rt.snapshot.pendingOrders.length, 0);

  // 3. Unclosed WS bar updates do not advance EMA/RSI/scan count
  const prevRsi = eth.indicators.rsi;
  const prevScans = rt.snapshot.autoStats.scansRun;
  const openT = eth.candles[eth.candles.length - 1].openTimeMs + 300_000;
  rt.stepBar(Date.now(), {
    symbol: 'ETHUSDT',
    candle: {
      openTimeMs: openT,
      open: eth.lastPrice,
      high: eth.lastPrice * 1.03,
      low: eth.lastPrice * 0.99,
      close: eth.lastPrice * 1.025,
      volume: 100,
      isClosed: false,
    },
  });
  assert.equal(eth.indicators.rsi, prevRsi);
  assert.equal(rt.snapshot.autoStats.scansRun, prevScans);

  // 4. RiskManager zero-PnL close does not increment winStreak or loseStreak
  const rm = new RiskManager(DEFAULT_BOT_CONFIG.risk, DEFAULT_BOT_CONFIG.trading, 1_763_280_000_000);
  rm.recordRealizedPnl('BTCUSDT', 0, 1_763_280_001_000);
  assert.equal(rm.status().winStreak, 0);
  assert.equal(rm.status().loseStreak, 0);

  // 5. profitFactor returns Infinity when grossProfit > 0 and grossLoss == 0
  const expInf = computeExpectancyStats(
    [
      {
        id: 't-win',
        symbol: 'BTCUSDT',
        side: 'Long',
        entryPrice: 100,
        exitPrice: 105,
        quantity: 2,
        pnlUsdt: 10,
        rMultiple: 1.5,
        reason: 'TakeProfit2',
        closedAtMs: 1_763_280_000_000,
      },
    ],
    0.75
  );
  assert.equal(expInf.profitFactor, Infinity);
});






