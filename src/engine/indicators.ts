import type { Candle, IndicatorConfig, IndicatorSnapshot } from './types';

export class Ema {
  private readonly period: number;
  private readonly multiplier: number;
  private count = 0;
  private smaSum = 0;
  private value: number | null = null;

  constructor(period: number) {
    this.period = Math.max(1, Math.floor(period));
    this.multiplier = 2 / (this.period + 1);
  }

  next(price: number): number | null {
    this.count += 1;
    if (this.value !== null) {
      this.value = (price - this.value) * this.multiplier + this.value;
      return this.value;
    }
    this.smaSum += price;
    if (this.count === this.period) {
      this.value = this.smaSum / this.period;
    }
    return this.value;
  }

  current(): number | null {
    return this.value;
  }
}

export class WilderRsi {
  private readonly period: number;
  private prevClose: number | null = null;
  private warmupCount = 0;
  private gainSum = 0;
  private lossSum = 0;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  public current: number | null = null;
  public previous: number | null = null;

  constructor(period: number) {
    this.period = Math.max(2, Math.floor(period));
  }

  next(close: number): number | null {
    if (this.prevClose === null) {
      this.prevClose = close;
      return null;
    }
    const delta = close - this.prevClose;
    this.prevClose = close;

    const gain = Math.max(0, delta);
    const loss = Math.max(0, -delta);
    this.previous = this.current;

    if (this.avgGain !== null && this.avgLoss !== null) {
      const p = this.period;
      this.avgGain = (this.avgGain * (p - 1) + gain) / p;
      this.avgLoss = (this.avgLoss * (p - 1) + loss) / p;
      this.current = WilderRsi.computeRsi(this.avgGain, this.avgLoss);
    } else {
      this.warmupCount += 1;
      this.gainSum += gain;
      this.lossSum += loss;
      if (this.warmupCount === this.period) {
        this.avgGain = this.gainSum / this.period;
        this.avgLoss = this.lossSum / this.period;
        this.current = WilderRsi.computeRsi(this.avgGain, this.avgLoss);
      }
    }
    return this.current;
  }

  private static computeRsi(avgGain: number, avgLoss: number): number {
    if (avgLoss <= 1e-12) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

export class Atr {
  private readonly period: number;
  private prevClose: number | null = null;
  private warmupCount = 0;
  private trSum = 0;
  private value: number | null = null;

  constructor(period: number) {
    this.period = Math.max(1, Math.floor(period));
  }

  next(candle: Candle): number | null {
    const tr =
      this.prevClose === null
        ? candle.high - candle.low
        : Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - this.prevClose),
            Math.abs(candle.low - this.prevClose)
          );
    this.prevClose = candle.close;

    if (this.value !== null) {
      this.value = (this.value * (this.period - 1) + tr) / this.period;
      return this.value;
    }

    this.warmupCount += 1;
    this.trSum += tr;
    if (this.warmupCount === this.period) {
      this.value = this.trSum / this.period;
    }
    return this.value;
  }

  current(): number | null {
    return this.value;
  }
}

export class Adx {
  private readonly period: number;
  private prevCandle: Candle | null = null;
  private dmCount = 0;
  private trAcc = 0;
  private plusDmAcc = 0;
  private minusDmAcc = 0;
  private smoothedTr: number | null = null;
  private smoothedPlusDm: number | null = null;
  private smoothedMinusDm: number | null = null;
  private dxCount = 0;
  private dxAcc = 0;
  private adx: number | null = null;
  private plusDi: number | null = null;
  private minusDi: number | null = null;

  constructor(period: number) {
    this.period = Math.max(2, Math.floor(period));
  }

  next(candle: Candle): { adx: number | null; plusDi: number | null; minusDi: number | null } {
    if (!this.prevCandle) {
      this.prevCandle = candle;
      return { adx: null, plusDi: null, minusDi: null };
    }
    const prev = this.prevCandle;
    this.prevCandle = candle;

    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prev.close),
      Math.abs(candle.low - prev.close)
    );
    const upMove = candle.high - prev.high;
    const downMove = prev.low - candle.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

    const p = this.period;
    if (this.smoothedTr !== null && this.smoothedPlusDm !== null && this.smoothedMinusDm !== null) {
      this.smoothedTr = this.smoothedTr - this.smoothedTr / p + tr;
      this.smoothedPlusDm = this.smoothedPlusDm - this.smoothedPlusDm / p + plusDm;
      this.smoothedMinusDm = this.smoothedMinusDm - this.smoothedMinusDm / p + minusDm;
    } else {
      this.dmCount += 1;
      this.trAcc += tr;
      this.plusDmAcc += plusDm;
      this.minusDmAcc += minusDm;
      if (this.dmCount < p) {
        return { adx: null, plusDi: null, minusDi: null };
      }
      this.smoothedTr = this.trAcc;
      this.smoothedPlusDm = this.plusDmAcc;
      this.smoothedMinusDm = this.minusDmAcc;
    }

    if (this.smoothedTr <= 1e-12) {
      return { adx: this.adx, plusDi: this.plusDi, minusDi: this.minusDi };
    }

    const pdi = 100 * (this.smoothedPlusDm / this.smoothedTr);
    const mdi = 100 * (this.smoothedMinusDm / this.smoothedTr);
    this.plusDi = pdi;
    this.minusDi = mdi;

    const diSum = pdi + mdi;
    const dx = diSum > 1e-12 ? 100 * (Math.abs(pdi - mdi) / diSum) : 0;

    if (this.adx !== null) {
      this.adx = (this.adx * (p - 1) + dx) / p;
    } else {
      this.dxCount += 1;
      this.dxAcc += dx;
      if (this.dxCount === p) {
        this.adx = this.dxAcc / p;
      }
    }

    return { adx: this.adx, plusDi: this.plusDi, minusDi: this.minusDi };
  }
}

export class SessionVwap {
  private currentDay: number | null = null;
  private cumPv = 0;
  private cumVol = 0;
  private value: number | null = null;

  next(candle: Candle): number | null {
    const utcDay = Math.floor(candle.openTimeMs / 86_400_000);
    if (this.currentDay !== utcDay) {
      this.currentDay = utcDay;
      this.cumPv = 0;
      this.cumVol = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    this.cumPv += typical * candle.volume;
    this.cumVol += candle.volume;
    if (this.cumVol > 1e-12) {
      this.value = this.cumPv / this.cumVol;
    }
    return this.value;
  }
}

export class IndicatorPipeline {
  private readonly emaFast: Ema;
  private readonly emaMid: Ema;
  private readonly emaSlow: Ema;
  private readonly emaMacro: Ema;
  private readonly rsi: WilderRsi;
  private readonly atr: Atr;
  private readonly adx: Adx;
  private readonly vwap: SessionVwap;
  private latest: IndicatorSnapshot = {
    emaFast: null,
    emaMid: null,
    emaSlow: null,
    emaMacro: null,
    rsi: null,
    prevRsi: null,
    adx: null,
    plusDi: null,
    minusDi: null,
    atr: null,
    vwap: null,
  };

  constructor(cfg: IndicatorConfig) {
    this.emaFast = new Ema(cfg.emaFast);
    this.emaMid = new Ema(cfg.emaMid);
    this.emaSlow = new Ema(cfg.emaSlow);
    this.emaMacro = new Ema(cfg.emaMacro);
    this.rsi = new WilderRsi(cfg.rsiPeriod);
    this.atr = new Atr(cfg.atrPeriod);
    this.adx = new Adx(cfg.adxPeriod);
    this.vwap = new SessionVwap();
  }

  update(candle: Candle): IndicatorSnapshot {
    const emaFast = this.emaFast.next(candle.close);
    const emaMid = this.emaMid.next(candle.close);
    const emaSlow = this.emaSlow.next(candle.close);
    const emaMacro = this.emaMacro.next(candle.close);
    const rsi = this.rsi.next(candle.close);
    const atr = this.atr.next(candle);
    const { adx, plusDi, minusDi } = this.adx.next(candle);
    const vwap = this.vwap.next(candle);

    this.latest = {
      emaFast,
      emaMid,
      emaSlow,
      emaMacro,
      rsi,
      prevRsi: this.rsi.previous,
      adx,
      plusDi,
      minusDi,
      atr,
      vwap,
    };
    return this.latest;
  }

  snapshot(): IndicatorSnapshot {
    return this.latest;
  }
}

export function computeIndicatorSeries(
  candles: Candle[],
  cfg: IndicatorConfig
): IndicatorSnapshot[] {
  const pipe = new IndicatorPipeline(cfg);
  return candles.map((c) => pipe.update(c));
}
