import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from './risk';
import { DEFAULT_BOT_CONFIG, SimulationRuntime } from './simulator';
import { buildExitPlan, evaluateEntrySignal, managePositionTick } from './strategy';
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


