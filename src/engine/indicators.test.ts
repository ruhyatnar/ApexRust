import test from 'node:test';
import assert from 'node:assert/strict';
import { Adx, Atr, Ema, IndicatorPipeline, SessionVwap, WilderRsi } from './indicators';
import { DEFAULT_BOT_CONFIG } from './simulator';
import type { Candle } from './types';

function makeCandle(i: number, open: number, high: number, low: number, close: number, volume = 1000): Candle {
  return {
    openTimeMs: 1_763_280_000_000 + i * 300_000,
    open,
    high,
    low,
    close,
    volume,
    isClosed: true,
  };
}

test('EMA converges to constant price after warmup period', () => {
  const ema = new Ema(9);
  for (let i = 0; i < 20; i += 1) {
    ema.next(250);
  }
  const val = ema.current();
  assert.ok(val !== null);
  assert.ok(Math.abs(val - 250) < 1e-9);
});

test('Wilder RSI rises above 70 in sustained uptrend and drops below 30 in downtrend', () => {
  const rsiUp = new WilderRsi(14);
  let lastUp: number | null = null;
  for (let i = 0; i < 30; i += 1) {
    lastUp = rsiUp.next(100 + i * 2);
  }
  assert.ok(lastUp !== null && lastUp > 80);

  const rsiDn = new WilderRsi(14);
  let lastDn: number | null = null;
  for (let i = 0; i < 30; i += 1) {
    lastDn = rsiDn.next(200 - i * 2);
  }
  assert.ok(lastDn !== null && lastDn < 20);
});

test('ATR accurately tracks average candle range', () => {
  const atr = new Atr(5);
  let val: number | null = null;
  for (let i = 0; i < 10; i += 1) {
    val = atr.next(makeCandle(i, 100, 103, 99, 101));
  }
  assert.ok(val !== null);
  assert.ok(Math.abs(val - 4) < 0.01);
});

test('ADX rises above 25 during directional trend with +DI > -DI', () => {
  const adx = new Adx(14);
  let res = { adx: null as number | null, plusDi: null as number | null, minusDi: null as number | null };
  for (let i = 0; i < 40; i += 1) {
    const c = 100 + i * 1.8;
    res = adx.next(makeCandle(i, c - 1, c + 1.2, c - 1.2, c));
  }
  assert.ok(res.adx !== null && res.adx > 25);
  assert.ok(res.plusDi !== null && res.minusDi !== null && res.plusDi > res.minusDi);
});

test('Session VWAP resets on UTC midnight boundary and weights by volume', () => {
  const vwap = new SessionVwap();
  const day1 = 86_400_000 * 20_000;
  const v1 = vwap.next({ openTimeMs: day1 + 1000, open: 100, high: 100, low: 100, close: 100, volume: 10, isClosed: true });
  assert.equal(v1, 100);
  const v2 = vwap.next({ openTimeMs: day1 + 61000, open: 110, high: 110, low: 110, close: 110, volume: 30, isClosed: true });
  assert.equal(v2, 107.5);
  // Next UTC day resets cumulative sum
  const v3 = vwap.next({ openTimeMs: day1 + 86_400_000, open: 200, high: 200, low: 200, close: 200, volume: 5, isClosed: true });
  assert.equal(v3, 200);
});

test('IndicatorPipeline populates full snapshot after warmup bars', () => {
  const pipe = new IndicatorPipeline(DEFAULT_BOT_CONFIG.indicators);
  let snap = pipe.snapshot();
  for (let i = 0; i < 210; i += 1) {
    const p = 100 + i * 0.4 + Math.sin(i / 4);
    snap = pipe.update(makeCandle(i, p - 0.3, p + 0.8, p - 0.8, p));
  }
  assert.ok(snap.emaFast !== null);
  assert.ok(snap.emaMacro !== null);
  assert.ok(snap.adx !== null);
  assert.ok(snap.atr !== null);
  assert.ok(snap.rsi !== null);
  assert.ok(snap.vwap !== null);
});
