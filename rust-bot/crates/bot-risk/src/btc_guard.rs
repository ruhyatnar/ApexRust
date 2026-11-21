//! BTC crash regime guard.
//!
//! Tracks a short rolling window of BTCUSDT reference prices and blocks **new
//! entries** when BTC falls faster than the configured threshold. Open position
//! exits are never touched by this module: 24/7 exit management continues while
//! new risk is paused.
//!
//! The guard deliberately fails **open** when the feed is stale so a stalled
//! market-data socket can never permanently halt the engine.

use bot_core::RiskConfig;
use chrono::{DateTime, Duration, Utc};

/// Rolling BTC price sampler evaluated by `RiskManager::authorize_entry`.
#[derive(Debug, Clone, Default)]
pub struct BtcRegimeGuard {
    samples: Vec<(DateTime<Utc>, f64)>,
    last_block_reason: Option<String>,
}

impl BtcRegimeGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a BTCUSDT price. Out-of-order samples are ignored, duplicate
    /// timestamps overwrite, and samples older than two windows are pruned.
    pub fn observe(&mut self, price: f64, now: DateTime<Utc>, cfg: &RiskConfig) {
        if !price.is_finite() || price <= 0.0 {
            return;
        }
        if let Some(&(last_ts, _)) = self.samples.last() {
            if now < last_ts {
                return;
            }
            if now == last_ts {
                if let Some(last) = self.samples.last_mut() {
                    last.1 = price;
                }
                return;
            }
        }
        self.samples.push((now, price));
        let keep = Duration::minutes((cfg.btc_crash_window_minutes.max(1) as i64) * 2);
        self.samples.retain(|(ts, _)| now - *ts <= keep);
    }

    /// BTC move (%) across the guard window, or `None` when data is missing/stale.
    pub fn change_pct(&self, now: DateTime<Utc>, cfg: &RiskConfig) -> Option<f64> {
        let (latest_ts, latest_px) = self.samples.last().copied()?;
        let max_age = Duration::seconds(cfg.btc_crash_max_staleness_sec.max(1) as i64);
        if now - latest_ts > max_age {
            return None;
        }
        let window = Duration::minutes(cfg.btc_crash_window_minutes.max(1) as i64);
        // Anchor at the OLDEST sample still inside the window (excluding the latest).
        let mut anchor = latest_px;
        for (ts, px) in &self.samples {
            if *ts >= latest_ts {
                break;
            }
            if latest_ts - *ts <= window && *px > 0.0 {
                anchor = *px;
                break;
            }
        }
        if anchor <= 0.0 {
            return None;
        }
        Some(((latest_px - anchor) / anchor) * 100.0)
    }

    /// True when the guard is enabled and the threshold is currently breached.
    pub fn is_blocking(&self, now: DateTime<Utc>, cfg: &RiskConfig) -> bool {
        if !cfg.btc_crash_guard_enabled {
            return false;
        }
        self.change_pct(now, cfg)
            .is_some_and(|pct| pct <= -cfg.btc_crash_threshold_pct.abs())
    }

    /// Human-readable reason recorded on the most recent rejection.
    pub fn last_block_reason(&self) -> Option<&str> {
        self.last_block_reason.as_deref()
    }

    pub fn set_block_reason(&mut self, reason: Option<String>) {
        self.last_block_reason = reason;
    }

    pub fn clear(&mut self) {
        self.last_block_reason = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RiskConfig {
        RiskConfig {
            max_daily_drawdown_pct: 3.0,
            max_pair_daily_drawdown_pct: 1.25,
            max_daily_profit_pct: 5.0,
            max_win_streak: 5,
            max_lose_streak: 3,
            streak_cooldown_minutes: 30,
            flatten_on_circuit_breaker: true,
            btc_crash_guard_enabled: true,
            btc_crash_threshold_pct: 1.5,
            btc_crash_window_minutes: 15,
            btc_crash_max_staleness_sec: 120,
        }
    }

    #[test]
    fn blocks_after_configured_drop_and_recovers_with_new_samples() {
        let cfg = cfg();
        let mut guard = BtcRegimeGuard::new();
        let t0 = Utc::now();
        guard.observe(100_000.0, t0, &cfg);
        guard.observe(99_000.0, t0 + Duration::minutes(5), &cfg);
        assert!(!guard.is_blocking(t0 + Duration::minutes(5), &cfg));

        guard.observe(98_000.0, t0 + Duration::minutes(10), &cfg);
        assert_eq!(guard.change_pct(t0 + Duration::minutes(10), &cfg), Some(-2.0));
        assert!(guard.is_blocking(t0 + Duration::minutes(10), &cfg));

        // A fresh higher print beyond the window restores trading.
        guard.observe(99_500.0, t0 + Duration::minutes(20), &cfg);
        assert!(!guard.is_blocking(t0 + Duration::minutes(20), &cfg));
    }

    #[test]
    fn stale_feed_fails_open_and_disabled_guard_never_blocks() {
        let cfg = cfg();
        let mut guard = BtcRegimeGuard::new();
        let t0 = Utc::now();
        guard.observe(100_000.0, t0, &cfg);
        guard.observe(97_000.0, t0 + Duration::seconds(30), &cfg);
        assert!(guard.is_blocking(t0 + Duration::seconds(30), &cfg));
        // 3 minutes later the last sample is older than the 120s staleness cap.
        assert_eq!(guard.change_pct(t0 + Duration::minutes(3), &cfg), None);
        assert!(!guard.is_blocking(t0 + Duration::minutes(3), &cfg));

        let mut disabled = cfg.clone();
        disabled.btc_crash_guard_enabled = false;
        assert!(!guard.is_blocking(t0 + Duration::seconds(30), &disabled));
    }

    #[test]
    fn ignores_invalid_and_out_of_order_prices() {
        let cfg = cfg();
        let mut guard = BtcRegimeGuard::new();
        let t0 = Utc::now();
        guard.observe(f64::NAN, t0, &cfg);
        guard.observe(0.0, t0, &cfg);
        guard.observe(50_000.0, t0, &cfg);
        guard.observe(49_000.0, t0 - Duration::seconds(1), &cfg);
        assert_eq!(guard.change_pct(t0, &cfg), Some(0.0));
    }
}
