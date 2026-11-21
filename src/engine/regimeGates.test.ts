import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBotConfigWithDefaults } from './configStorage';
import { RiskManager } from './risk';
import { DEFAULT_BOT_CONFIG } from './simulator';
import { evaluateEntrySignal } from './strategy';
import type { Candle, IndicatorSnapshot, MarketTicker24h } from './types';
import { computeCtsScore, rankScreenerTickers } from './watchlist';

const NOW = Date.now();

function triggerCandle(): Candle {
  return {
    openTimeMs: NOW,
    open: 103.5,
    high: 106,
    low: 101.8,
    close: 105,
    volume: 6_000,
    isClosed: true,
  };
}

function healthyIndicators(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    emaFast: 102.5,
    emaMid: 101.8,
    prevEmaMid: 101.4,
    emaSlow: 100.5,
    emaMacro: 96,
    rsi: 55,
    prevRsi: 50,
    adx: 31,
    prevAdx: 29,
    plusDi: 28,
    minusDi: 14,
    atr: 2,
    vwap: 100.5,
    volumeRatio: 1.5,
    atrSma50: 1.6,
    htfClose: 110,
    htfEmaMacro: 100,
    obi: 0.5,
    warmupBarsCount: 220,
    hasBarGap: false,
    ...overrides,
  };
}

function breakoutCandles(oldHigh: number, recentHigh: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 25; i += 1) {
    const high = i < 19 ? oldHigh : recentHigh;
    candles.push({
      openTimeMs: NOW - (25 - i) * 300_000,
      open: 100,
      high,
      low: 99,
      close: 100,
      volume: 4_000,
      isClosed: true,
    });
  }
  return candles;
}

test('Donchian lookback is configurable and gates breakouts against the configured window', () => {
  const candles = breakoutCandles(120, 104);
  const trigger = triggerCandle();
  const fullHistory = [...candles, trigger];
  const base = DEFAULT_BOT_CONFIG.indicators;

  const blocked = evaluateEntrySignal(
    'SOLUSDT',
    trigger,
    healthyIndicators({ emaMacro: 96 }),
    { ...DEFAULT_BOT_CONFIG.trading, mode: 'intraday' },
    { ...base, donchianLookback: 20 },
    NOW,
    { strategyProfile: 'ema_breakout', directionPolicy: 'long_only', recentCandles: fullHistory }
  );
  assert.equal(blocked, null, '20-bar window still contains the old 120 high');

  const allowed = evaluateEntrySignal(
    'SOLUSDT',
    trigger,
    healthyIndicators({ emaMacro: 96 }),
    { ...DEFAULT_BOT_CONFIG.trading, mode: 'intraday' },
    { ...base, donchianLookback: 5 },
    NOW,
    { strategyProfile: 'ema_breakout', directionPolicy: 'long_only', recentCandles: fullHistory }
  );
  assert.equal(allowed?.side, 'Long');
});

test('ATR expansion filter blocks a contracting volatility regime', () => {
  const trigger = triggerCandle();
  const indicators = healthyIndicators({
    atr: 1.0,
    atrSma50: 2.0,
    emaFast: 105.5,
    emaMid: 104.8,
    prevEmaMid: 104.6,
    emaSlow: 103.5,
    vwap: 104.0,
  });
  const cfg = DEFAULT_BOT_CONFIG.indicators;

  const filtered = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    indicators,
    DEFAULT_BOT_CONFIG.trading,
    { ...cfg, atrExpansionFilterEnabled: true, atrExpansionMinRatio: 1.15 },
    NOW,
    { strategyProfile: 'trend_pullback', directionPolicy: 'long_only', recentCandles: [trigger] }
  );
  assert.equal(filtered, null);

  const unfiltered = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    indicators,
    DEFAULT_BOT_CONFIG.trading,
    { ...cfg, atrExpansionFilterEnabled: false },
    NOW,
    { strategyProfile: 'trend_pullback', directionPolicy: 'long_only', recentCandles: [trigger] }
  );
  assert.equal(unfiltered?.side, 'Long');
});

test('HTF 1h EMA gate and OBI gate block counter-trend and opposing-book entries', () => {
  const trigger = triggerCandle();
  const options = {
    strategyProfile: 'trend_pullback' as const,
    directionPolicy: 'long_only' as const,
    recentCandles: [trigger],
  };

  const htfBlocked = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    healthyIndicators({ htfClose: 90, htfEmaMacro: 100 }),
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    NOW,
    { ...options, features: { htfTrendFilter: true } }
  );
  assert.equal(htfBlocked, null);

  const htfAligned = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    healthyIndicators({ htfClose: 110, htfEmaMacro: 100 }),
    DEFAULT_BOT_CONFIG.trading,
    DEFAULT_BOT_CONFIG.indicators,
    NOW,
    { ...options, features: { htfTrendFilter: true } }
  );
  assert.equal(htfAligned?.side, 'Long');

  const obiBlocked = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    healthyIndicators({ obi: -0.6 }),
    DEFAULT_BOT_CONFIG.trading,
    { ...DEFAULT_BOT_CONFIG.indicators, obiMinImbalance: 0.35 },
    NOW,
    { ...options, features: { obiEntryFilter: true } }
  );
  assert.equal(obiBlocked, null);

  const obiAligned = evaluateEntrySignal(
    'ETHUSDT',
    trigger,
    healthyIndicators({ obi: 0.6 }),
    DEFAULT_BOT_CONFIG.trading,
    { ...DEFAULT_BOT_CONFIG.indicators, obiMinImbalance: 0.35 },
    NOW,
    { ...options, features: { obiEntryFilter: true } }
  );
  assert.equal(obiAligned?.side, 'Long');
});

test('BTC crash guard blocks new entries, ignores stale feeds, and never runs on disabled config', () => {
  const riskCfg = {
    ...DEFAULT_BOT_CONFIG.risk,
    btcCrashGuardEnabled: true,
    btcCrashThresholdPct: 1.5,
    btcCrashWindowMinutes: 15,
    btcCrashMaxStalenessSec: 120,
  };
  const rm = new RiskManager(riskCfg, DEFAULT_BOT_CONFIG.trading, NOW);
  rm.observeBtcPrice(100_000, NOW);
  rm.observeBtcPrice(98_000, NOW + 10 * 60_000);

  const blocked = rm.authorizeEntry('ETHUSDT', 3_000, 2_950, 0, NOW + 10 * 60_000);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.reason : '', /BTC crash guard/);
  assert.equal(rm.status().btcGuardBlocking, true);

  // 3 minutes later the last sample is older than the 120s staleness cap -> fail open.
  const stale = rm.authorizeEntry('ETHUSDT', 3_000, 2_950, 0, NOW + 13 * 60_000);
  assert.equal(stale.ok, true);

  const disabled = new RiskManager(
    { ...riskCfg, btcCrashGuardEnabled: false },
    DEFAULT_BOT_CONFIG.trading,
    NOW
  );
  disabled.observeBtcPrice(100_000, NOW);
  disabled.observeBtcPrice(90_000, NOW + 60_000);
  assert.equal(disabled.authorizeEntry('ETHUSDT', 3_000, 2_950, 0, NOW + 60_000).ok, true);
});

test('maxLeverage clamps persisted leverage on every config load', () => {
  const clamped = mergeBotConfigWithDefaults({ trading: { leverage: 15, maxLeverage: 3 } });
  assert.equal(clamped.trading.maxLeverage, 3);
  assert.equal(clamped.trading.leverage, 3);

  const allowed = mergeBotConfigWithDefaults({ trading: { leverage: 7, maxLeverage: 10 } });
  assert.equal(allowed.trading.leverage, 7);
});

function ticker(symbol: string, quoteVolume: number): MarketTicker24h {
  return {
    symbol,
    venue: 'Futures',
    lastPrice: 1,
    openPrice24h: 1,
    highPrice24h: 1,
    lowPrice24h: 1,
    priceChangePercent: 1,
    baseVolume: quoteVolume,
    quoteVolume,
    rangePct24h: 2,
    tradableOnActiveEnv: true,
    updatedAtMs: NOW,
  };
}

test('CTS scoring normalizes volume and cts_momentum ranks by blended score', () => {
  const btcLike = computeCtsScore({
    rvol1h: 2,
    momentum1hPct: 1,
    quoteVolume: 50_000_000_000,
    medianQuoteVolume: 20_000_000,
  });
  const altLike = computeCtsScore({
    rvol1h: 3,
    momentum1hPct: 4,
    quoteVolume: 200_000_000,
    medianQuoteVolume: 20_000_000,
  });
  assert.ok(btcLike !== null && altLike !== null);
  assert.ok(btcLike! >= 0 && btcLike! <= 1);
  assert.ok(altLike! > btcLike!, 'momentum must outrank raw mega-volume');
  assert.equal(
    computeCtsScore({ rvol1h: 0, momentum1hPct: 5, quoteVolume: 1, medianQuoteVolume: 1 }),
    null
  );

  const btc = {
    ...ticker('BTCUSDT', 50_000_000_000),
    rvol1h: 2,
    momentum1hPct: 1,
    ctsScore: btcLike!,
  };
  const alt = {
    ...ticker('WIFUSDT', 200_000_000),
    rvol1h: 3,
    momentum1hPct: 4,
    ctsScore: altLike!,
  };
  const unscored = ticker('DOGEUSDT', 300_000_000);

  const ranked = rankScreenerTickers([btc, unscored, alt], {
    category: 'cts_momentum',
    quoteAsset: 'USDT',
    onlyTradable: true,
    limit: 10,
    ctsMinRvol: 1.2,
  });
  assert.deepEqual(
    ranked.map((t) => t.symbol),
    ['WIFUSDT', 'BTCUSDT']
  );

  const minRvolFiltered = rankScreenerTickers([btc, alt], {
    category: 'cts_momentum',
    quoteAsset: 'USDT',
    onlyTradable: true,
    limit: 10,
    ctsMinRvol: 2.5,
  });
  assert.deepEqual(
    minRvolFiltered.map((t) => t.symbol),
    ['WIFUSDT']
  );
});
