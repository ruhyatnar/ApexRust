//! Streaming, deterministic technical indicator pipeline for scalping and
//! intraday trend-following strategies.
//!
//! All indicators update in O(1) per closed bar without re-scanning historical
//! arrays, making them suitable for low-latency WebSocket event loops.

use bot_core::{Candle, IndicatorConfig, IndicatorSnapshot};

/// Exponential Moving Average (EMA).
#[derive(Debug, Clone)]
pub struct Ema {
    period: usize,
    multiplier: f64,
    count: usize,
    sma_sum: f64,
    value: Option<f64>,
}

impl Ema {
    pub fn new(period: usize) -> Self {
        let safe_period = period.max(1);
        Self {
            period: safe_period,
            multiplier: 2.0 / (safe_period as f64 + 1.0),
            count: 0,
            sma_sum: 0.0,
            value: None,
        }
    }

    pub fn next(&mut self, price: f64) -> Option<f64> {
        self.count += 1;
        if let Some(prev) = self.value {
            let next_val = (price - prev) * self.multiplier + prev;
            self.value = Some(next_val);
            return self.value;
        }
        self.sma_sum += price;
        if self.count == self.period {
            self.value = Some(self.sma_sum / self.period as f64);
        }
        self.value
    }

    #[cfg(test)]
    pub fn current(&self) -> Option<f64> {
        self.value
    }
}

/// Wilder's Smoothed Relative Strength Index (RSI).
#[derive(Debug, Clone)]
pub struct WilderRsi {
    period: usize,
    prev_close: Option<f64>,
    warmup_count: usize,
    gain_sum: f64,
    loss_sum: f64,
    avg_gain: Option<f64>,
    avg_loss: Option<f64>,
    current: Option<f64>,
    previous: Option<f64>,
}

impl WilderRsi {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(2),
            prev_close: None,
            warmup_count: 0,
            gain_sum: 0.0,
            loss_sum: 0.0,
            avg_gain: None,
            avg_loss: None,
            current: None,
            previous: None,
        }
    }

    pub fn next(&mut self, close: f64) -> Option<f64> {
        let Some(prev) = self.prev_close else {
            self.prev_close = Some(close);
            return None;
        };
        self.prev_close = Some(close);

        let delta = close - prev;
        let gain = delta.max(0.0);
        let loss = (-delta).max(0.0);

        self.previous = self.current;

        match (self.avg_gain, self.avg_loss) {
            (Some(ag), Some(al)) => {
                let p = self.period as f64;
                let next_ag = ((ag * (p - 1.0)) + gain) / p;
                let next_al = ((al * (p - 1.0)) + loss) / p;
                self.avg_gain = Some(next_ag);
                self.avg_loss = Some(next_al);
                self.current = Some(Self::compute_rsi(next_ag, next_al));
            }
            _ => {
                self.warmup_count += 1;
                self.gain_sum += gain;
                self.loss_sum += loss;
                if self.warmup_count == self.period {
                    let ag = self.gain_sum / self.period as f64;
                    let al = self.loss_sum / self.period as f64;
                    self.avg_gain = Some(ag);
                    self.avg_loss = Some(al);
                    self.current = Some(Self::compute_rsi(ag, al));
                }
            }
        }
        self.current
    }

    fn compute_rsi(avg_gain: f64, avg_loss: f64) -> f64 {
        if avg_loss <= f64::EPSILON {
            return 100.0;
        }
        let rs = avg_gain / avg_loss;
        100.0 - (100.0 / (1.0 + rs))
    }
}

/// Wilder's Average True Range (ATR) for volatility-adjusted SL/TP/Trailing.
#[derive(Debug, Clone)]
pub struct Atr {
    period: usize,
    prev_close: Option<f64>,
    warmup_count: usize,
    tr_sum: f64,
    value: Option<f64>,
}

impl Atr {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(1),
            prev_close: None,
            warmup_count: 0,
            tr_sum: 0.0,
            value: None,
        }
    }

    pub fn next(&mut self, candle: &Candle) -> Option<f64> {
        let tr = match self.prev_close {
            Some(pc) => {
                let hl = candle.high - candle.low;
                let hc = (candle.high - pc).abs();
                let lc = (candle.low - pc).abs();
                hl.max(hc).max(lc)
            }
            None => candle.high - candle.low,
        };
        self.prev_close = Some(candle.close);

        if let Some(prev_atr) = self.value {
            let p = self.period as f64;
            let next_atr = ((prev_atr * (p - 1.0)) + tr) / p;
            self.value = Some(next_atr);
            return self.value;
        }

        self.warmup_count += 1;
        self.tr_sum += tr;
        if self.warmup_count == self.period {
            self.value = Some(self.tr_sum / self.period as f64);
        }
        self.value
    }
}

/// Average Directional Index (ADX) with +DI and -DI trend strength filters.
#[derive(Debug, Clone)]
pub struct Adx {
    period: usize,
    prev_candle: Option<Candle>,
    dm_count: usize,
    tr_acc: f64,
    plus_dm_acc: f64,
    minus_dm_acc: f64,
    smoothed_tr: Option<f64>,
    smoothed_plus_dm: Option<f64>,
    smoothed_minus_dm: Option<f64>,
    dx_count: usize,
    dx_acc: f64,
    adx: Option<f64>,
    plus_di: Option<f64>,
    minus_di: Option<f64>,
}

impl Adx {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(2),
            prev_candle: None,
            dm_count: 0,
            tr_acc: 0.0,
            plus_dm_acc: 0.0,
            minus_dm_acc: 0.0,
            smoothed_tr: None,
            smoothed_plus_dm: None,
            smoothed_minus_dm: None,
            dx_count: 0,
            dx_acc: 0.0,
            adx: None,
            plus_di: None,
            minus_di: None,
        }
    }

    pub fn next(&mut self, candle: &Candle) -> (Option<f64>, Option<f64>, Option<f64>) {
        let Some(prev) = self.prev_candle else {
            self.prev_candle = Some(*candle);
            return (None, None, None);
        };
        self.prev_candle = Some(*candle);

        let tr = (candle.high - candle.low)
            .max((candle.high - prev.close).abs())
            .max((candle.low - prev.close).abs());

        let up_move = candle.high - prev.high;
        let down_move = prev.low - candle.low;
        let plus_dm = if up_move > down_move && up_move > 0.0 { up_move } else { 0.0 };
        let minus_dm = if down_move > up_move && down_move > 0.0 { down_move } else { 0.0 };

        let p = self.period as f64;
        let (str_v, sp_v, sm_v) = match (self.smoothed_tr, self.smoothed_plus_dm, self.smoothed_minus_dm) {
            (Some(st), Some(sp), Some(sm)) => {
                let nst = st - (st / p) + tr;
                let nsp = sp - (sp / p) + plus_dm;
                let nsm = sm - (sm / p) + minus_dm;
                self.smoothed_tr = Some(nst);
                self.smoothed_plus_dm = Some(nsp);
                self.smoothed_minus_dm = Some(nsm);
                (nst, nsp, nsm)
            }
            _ => {
                self.dm_count += 1;
                self.tr_acc += tr;
                self.plus_dm_acc += plus_dm;
                self.minus_dm_acc += minus_dm;
                if self.dm_count < self.period {
                    return (None, None, None);
                }
                self.smoothed_tr = Some(self.tr_acc);
                self.smoothed_plus_dm = Some(self.plus_dm_acc);
                self.smoothed_minus_dm = Some(self.minus_dm_acc);
                (self.tr_acc, self.plus_dm_acc, self.minus_dm_acc)
            }
        };

        if str_v <= f64::EPSILON {
            return (self.adx, self.plus_di, self.minus_di);
        }

        let pdi = 100.0 * (sp_v / str_v);
        let mdi = 100.0 * (sm_v / str_v);
        self.plus_di = Some(pdi);
        self.minus_di = Some(mdi);

        let di_sum = pdi + mdi;
        let dx = if di_sum > f64::EPSILON {
            100.0 * ((pdi - mdi).abs() / di_sum)
        } else {
            0.0
        };

        if let Some(prev_adx) = self.adx {
            self.adx = Some(((prev_adx * (p - 1.0)) + dx) / p);
        } else {
            self.dx_count += 1;
            self.dx_acc += dx;
            if self.dx_count == self.period {
                self.adx = Some(self.dx_acc / p);
            }
        }

        (self.adx, self.plus_di, self.minus_di)
    }
}

/// Session Volume-Weighted Average Price (resets on UTC day boundary).
#[derive(Debug, Clone, Default)]
pub struct SessionVwap {
    current_day: Option<i64>,
    cum_pv: f64,
    cum_vol: f64,
    value: Option<f64>,
}

impl SessionVwap {
    pub fn next(&mut self, candle: &Candle) -> Option<f64> {
        let utc_day = candle.open_time_ms.div_euclid(86_400_000);
        if self.current_day != Some(utc_day) {
            self.current_day = Some(utc_day);
            self.cum_pv = 0.0;
            self.cum_vol = 0.0;
        }
        let typical = (candle.high + candle.low + candle.close) / 3.0;
        self.cum_pv += typical * candle.volume;
        self.cum_vol += candle.volume;
        if self.cum_vol > f64::EPSILON {
            self.value = Some(self.cum_pv / self.cum_vol);
        }
        self.value
    }
}

/// Rolling 20-bar volume SMA for volume expansion confirmation filters.
#[derive(Debug, Clone)]
pub struct RollingVolumeSma {
    period: usize,
    window: std::collections::VecDeque<f64>,
    sum: f64,
    value: Option<f64>,
}

impl RollingVolumeSma {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(1),
            window: std::collections::VecDeque::with_capacity(period.max(1)),
            sum: 0.0,
            value: None,
        }
    }

    pub fn next(&mut self, volume: f64) -> (Option<f64>, Option<f64>) {
        let clean_vol = if volume.is_finite() { volume.max(0.0) } else { 0.0 };
        let prior_avg = if !self.window.is_empty() {
            self.sum / self.window.len() as f64
        } else {
            clean_vol
        };
        self.window.push_back(clean_vol);
        self.sum += clean_vol;
        if self.window.len() > self.period {
            if let Some(old) = self.window.pop_front() {
                self.sum -= old;
            }
        }
        if !self.window.is_empty() {
            self.value = Some(self.sum / self.window.len() as f64);
        }
        let ratio = if prior_avg > 1e-12 {
            clean_vol / prior_avg
        } else {
            1.0
        };
        (self.value, Some(ratio))
    }
}

/// Per-pair composite indicator pipeline updated on every closed bar.
#[derive(Debug, Clone)]
pub struct IndicatorPipeline {
    ema_fast: Ema,
    ema_mid: Ema,
    ema_slow: Ema,
    ema_macro: Ema,
    rsi: WilderRsi,
    atr: Atr,
    adx: Adx,
    vwap: SessionVwap,
    volume_sma_20: RollingVolumeSma,
    latest: IndicatorSnapshot,
}

impl IndicatorPipeline {
    pub fn new(cfg: &IndicatorConfig) -> Self {
        Self {
            ema_fast: Ema::new(cfg.ema_fast),
            ema_mid: Ema::new(cfg.ema_mid),
            ema_slow: Ema::new(cfg.ema_slow),
            ema_macro: Ema::new(cfg.ema_macro),
            rsi: WilderRsi::new(cfg.rsi_period),
            atr: Atr::new(cfg.atr_period),
            adx: Adx::new(cfg.adx_period),
            vwap: SessionVwap::default(),
            volume_sma_20: RollingVolumeSma::new(20),
            latest: IndicatorSnapshot::default(),
        }
    }

    pub fn update(&mut self, candle: &Candle) -> IndicatorSnapshot {
        let prev_atr = self.latest.atr;
        let ema_fast = self.ema_fast.next(candle.close);
        let ema_mid = self.ema_mid.next(candle.close);
        let ema_slow = self.ema_slow.next(candle.close);
        let ema_macro = self.ema_macro.next(candle.close);
        let rsi = self.rsi.next(candle.close);
        let atr = self.atr.next(candle);
        let (adx, plus_di, minus_di) = self.adx.next(candle);
        let vwap = self.vwap.next(candle);
        let (avg_volume_20, volume_ratio) = self.volume_sma_20.next(candle.volume);

        self.latest = IndicatorSnapshot {
            ema_fast,
            ema_mid,
            ema_slow,
            ema_macro,
            rsi,
            prev_rsi: self.rsi.previous,
            adx,
            plus_di,
            minus_di,
            atr,
            prev_atr,
            vwap,
            avg_volume_20,
            volume_ratio,
        };
        self.latest
    }

    pub fn snapshot(&self) -> IndicatorSnapshot {
        self.latest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_converges_on_constant_series() {
        let mut ema = Ema::new(5);
        for _ in 0..10 {
            ema.next(100.0);
        }
        assert!((ema.current().unwrap() - 100.0).abs() < 1e-6);
    }

    #[test]
    fn atr_measures_bar_range() {
        let mut atr = Atr::new(3);
        let bars = [10.0, 12.0, 14.0];
        let mut last = None;
        for (i, c) in bars.iter().enumerate() {
            last = atr.next(&Candle {
                open_time_ms: (i as i64) * 60_000,
                open: *c,
                high: *c + 2.0,
                low: *c - 2.0,
                close: *c,
                volume: 100.0,
                is_closed: true,
            });
        }
        assert!(last.unwrap() >= 4.0);
    }
}
