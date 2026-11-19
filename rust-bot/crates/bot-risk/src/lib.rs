//! Portfolio and per-pair risk governance engine.
//!
//! Enforces:
//! - Cumulative max daily drawdown (%)
//! - Per-pair max daily drawdown (%) with automatic daily quarantine
//! - Max daily profit lock (%)
//! - Max consecutive win streak & lose streak cooldown/halt
//! - Global emergency circuit breaker

use bot_core::{
    BotError, CircuitBreakerState, Result, RiskConfig, RiskStatus, TradingConfig,
};
use chrono::{DateTime, Duration, Utc};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct RiskManager {
    risk_cfg: RiskConfig,
    trading_cfg: TradingConfig,
    active_utc_day: i64,
    starting_daily_equity: f64,
    current_equity: f64,
    pair_daily_pnl: HashMap<String, f64>,
    quarantined_pairs: HashSet<String>,
    win_streak: u32,
    lose_streak: u32,
    state: CircuitBreakerState,
    halt_reason: Option<String>,
    cooldown_until: Option<DateTime<Utc>>,
}

impl RiskManager {
    pub fn new(risk_cfg: RiskConfig, trading_cfg: TradingConfig, now: DateTime<Utc>) -> Self {
        let eq = trading_cfg.initial_equity_usdt;
        Self {
            risk_cfg,
            trading_cfg,
            active_utc_day: now.timestamp().div_euclid(86_400),
            starting_daily_equity: eq,
            current_equity: eq,
            pair_daily_pnl: HashMap::new(),
            quarantined_pairs: HashSet::new(),
            win_streak: 0,
            lose_streak: 0,
            state: CircuitBreakerState::Active,
            halt_reason: None,
            cooldown_until: None,
        }
    }

    /// Reset daily drawdown/profit/quarantine counters when UTC midnight passes.
    pub fn maybe_rollover_utc_day(&mut self, now: DateTime<Utc>) {
        let day = now.timestamp().div_euclid(86_400);
        if day > self.active_utc_day {
            self.active_utc_day = day;
            self.starting_daily_equity = self.current_equity;
            self.pair_daily_pnl.clear();
            self.quarantined_pairs.clear();
            self.win_streak = 0;
            self.lose_streak = 0;
            self.state = CircuitBreakerState::Active;
            self.halt_reason = None;
            self.cooldown_until = None;
        }
    }

    /// Authorize whether a new position may be opened for `symbol`, returning
    /// the risk-adjusted position quantity in base asset units.
    pub fn authorize_entry(
        &mut self,
        symbol: &str,
        entry_price: f64,
        stop_loss_price: f64,
        open_positions_count: usize,
        now: DateTime<Utc>,
    ) -> Result<f64> {
        self.maybe_rollover_utc_day(now);

        if let Some(until) = self.cooldown_until {
            if now < until {
                return Err(BotError::RiskRejected(format!(
                    "Streak cooldown active until {}",
                    until.to_rfc3339()
                )));
            }
            self.cooldown_until = None;
            if self.state == CircuitBreakerState::Cooldown {
                self.state = CircuitBreakerState::Active;
                self.halt_reason = None;
            }
        }

        if self.state == CircuitBreakerState::Halted {
            return Err(BotError::CircuitBreakerHalted(
                self.halt_reason.clone().unwrap_or_else(|| "Circuit breaker active".into()),
            ));
        }

        if self.quarantined_pairs.contains(symbol) {
            return Err(BotError::RiskRejected(format!(
                "{symbol} reached max per-pair daily drawdown"
            )));
        }

        if open_positions_count >= self.trading_cfg.max_concurrent_positions {
            return Err(BotError::RiskRejected(
                "Max concurrent positions reached".into(),
            ));
        }

        let stop_distance = (entry_price - stop_loss_price).abs();
        if stop_distance <= f64::EPSILON {
            return Err(BotError::RiskRejected("Zero stop distance".into()));
        }

        if self.current_equity <= 0.0 {
            return Err(BotError::RiskRejected("Account equity depleted".into()));
        }

        let risk_usdt = self.current_equity * (self.trading_cfg.base_risk_per_trade_pct / 100.0);
        Ok(risk_usdt / stop_distance)
    }

    /// Record realized PnL for a closed fill and evaluate all circuit breakers.
    pub fn record_realized_pnl(&mut self, symbol: &str, pnl_usdt: f64, now: DateTime<Utc>) {
        self.maybe_rollover_utc_day(now);
        self.current_equity += pnl_usdt;
        *self.pair_daily_pnl.entry(symbol.to_string()).or_insert(0.0) += pnl_usdt;

        if pnl_usdt > 1e-9 {
            self.win_streak += 1;
            self.lose_streak = 0;
        } else if pnl_usdt < -1e-9 {
            self.lose_streak += 1;
            self.win_streak = 0;
        }

        let cumulative_pnl = self.current_equity - self.starting_daily_equity;
        let cumulative_pct = if self.starting_daily_equity > 0.0 {
            (cumulative_pnl / self.starting_daily_equity) * 100.0
        } else {
            0.0
        };

        // 1. Cumulative max daily drawdown check
        if cumulative_pct <= -self.risk_cfg.max_daily_drawdown_pct {
            self.trip_circuit_breaker(format!(
                "Cumulative daily drawdown {:.2}% breached -{}% limit",
                cumulative_pct, self.risk_cfg.max_daily_drawdown_pct
            ));
            return;
        }

        // 2. Max daily profit lock
        if cumulative_pct >= self.risk_cfg.max_daily_profit_pct {
            self.trip_circuit_breaker(format!(
                "Max daily profit target +{:.2}% achieved — gains locked",
                cumulative_pct
            ));
            return;
        }

        // 3. Per-pair max daily drawdown check
        let pair_pnl = self.pair_daily_pnl.get(symbol).copied().unwrap_or(0.0);
        let pair_pct = if self.starting_daily_equity > 0.0 {
            (pair_pnl / self.starting_daily_equity) * 100.0
        } else {
            0.0
        };
        if pair_pct <= -self.risk_cfg.max_pair_daily_drawdown_pct {
            self.quarantined_pairs.insert(symbol.to_string());
        }

        // 4. Streak guards (do not downgrade an already Halted circuit breaker)
        if self.state != CircuitBreakerState::Halted {
            if self.risk_cfg.max_lose_streak > 0 && self.lose_streak >= self.risk_cfg.max_lose_streak {
                self.state = CircuitBreakerState::Cooldown;
                let until = now + Duration::minutes(self.risk_cfg.streak_cooldown_minutes as i64);
                self.cooldown_until = Some(until);
                self.halt_reason = Some(format!(
                    "Max lose streak ({}) hit — cooldown until {}",
                    self.lose_streak,
                    until.format("%H:%M:%S UTC")
                ));
            } else if self.risk_cfg.max_win_streak > 0 && self.win_streak >= self.risk_cfg.max_win_streak {
                self.state = CircuitBreakerState::Cooldown;
                let until = now + Duration::minutes(self.risk_cfg.streak_cooldown_minutes as i64);
                self.cooldown_until = Some(until);
                self.halt_reason = Some(format!(
                    "Max win streak ({}) cap reached — protecting gains",
                    self.win_streak
                ));
            }
        }
    }

    pub fn trip_circuit_breaker(&mut self, reason: impl Into<String>) {
        self.state = CircuitBreakerState::Halted;
        self.halt_reason = Some(reason.into());
    }

    pub fn reset_circuit_breaker(&mut self) {
        self.state = CircuitBreakerState::Active;
        self.halt_reason = None;
        self.cooldown_until = None;
        self.lose_streak = 0;
        self.win_streak = 0;
        self.quarantined_pairs.clear();
    }

    pub fn current_equity(&self) -> f64 {
        self.current_equity
    }

    pub fn pair_daily_pnl(&self, symbol: &str) -> f64 {
        self.pair_daily_pnl.get(symbol).copied().unwrap_or(0.0)
    }

    pub fn status(&self) -> RiskStatus {
        let cum_pnl = self.current_equity - self.starting_daily_equity;
        let cum_pct = if self.starting_daily_equity > 0.0 {
            (cum_pnl / self.starting_daily_equity) * 100.0
        } else {
            0.0
        };
        RiskStatus {
            state: self.state,
            halt_reason: self.halt_reason.clone(),
            cooldown_until: self.cooldown_until,
            starting_daily_equity: self.starting_daily_equity,
            current_equity: self.current_equity,
            cumulative_daily_pnl_usdt: cum_pnl,
            cumulative_daily_pnl_pct: cum_pct,
            win_streak: self.win_streak,
            lose_streak: self.lose_streak,
            quarantined_pairs: self.quarantined_pairs.iter().cloned().collect(),
        }
    }
}

/// Calculates the optimal Full Kelly fraction `f* = (b * p - q) / b`.
/// Returns a negative value when mathematical expectancy is negative (`EV < 0`),
/// which acts as a mandatory systematic filter to block trade execution.
pub fn compute_kelly_fraction(win_rate_p: f64, payoff_ratio_b: f64) -> f64 {
    if payoff_ratio_b <= f64::EPSILON {
        return -1.0;
    }
    let p = win_rate_p.clamp(0.0, 1.0);
    let q = 1.0 - p;
    (payoff_ratio_b * p - q) / payoff_ratio_b
}

/// Calculates expected logarithmic utility growth rate per trade:
/// `G(f) = p * ln(1 + b * f) + q * ln(1 - f)`
pub fn compute_log_growth_rate(win_rate_p: f64, payoff_ratio_b: f64, fraction_f: f64) -> f64 {
    let f = fraction_f.clamp(0.0, 0.99);
    if f <= 0.0 || payoff_ratio_b <= 0.0 {
        return 0.0;
    }
    let p = win_rate_p.clamp(0.01, 0.99);
    let q = 1.0 - p;
    p * (1.0 + payoff_ratio_b * f).ln() + q * (1.0 - f).ln()
}

/// Converts an account risk fraction `f` (e.g. Half-Kelly `0.5 * f*` or Quarter-Kelly `0.25 * f*`)
/// into notional position size (`USDT`) using the structural stop-loss distance:
/// `Dollar Risk = Equity * f`
/// `Notional Position Size = Dollar Risk / (|Entry - StopLoss| / Entry)`
pub fn compute_stop_distance_notional(
    account_equity_usdt: f64,
    risk_fraction_f: f64,
    entry_price: f64,
    stop_loss_price: f64,
) -> Result<f64> {
    if risk_fraction_f <= 0.0 {
        return Err(BotError::RiskRejected(
            "Negative or zero Kelly risk fraction (EV <= 0) — systematic filter blocked trade".into(),
        ));
    }
    if entry_price <= f64::EPSILON {
        return Err(BotError::RiskRejected("Invalid entry price".into()));
    }
    let stop_dist_dec = ((entry_price - stop_loss_price).abs() / entry_price).max(0.002);
    let dollar_risk = account_equity_usdt.max(0.0) * risk_fraction_f;
    Ok(dollar_risk / stop_dist_dec)
}

/// Computes strategy mathematical Expectancy `(p * avg_win) - (q * avg_loss)`
/// and Profit Factor `gross_profit / gross_loss`.
pub fn compute_expectancy_and_profit_factor(
    win_rate_p: f64,
    avg_win_r: f64,
    avg_loss_r: f64,
    gross_profit_usdt: f64,
    gross_loss_usdt: f64,
) -> (f64, f64) {
    let p = win_rate_p.clamp(0.0, 1.0);
    let q = 1.0 - p;
    let expectancy_r = (p * avg_win_r) - (q * avg_loss_r.abs());
    let profit_factor = if gross_loss_usdt.abs() > f64::EPSILON {
        gross_profit_usdt / gross_loss_usdt.abs()
    } else if gross_profit_usdt > f64::EPSILON {
        f64::INFINITY
    } else {
        0.0
    };
    (expectancy_r, profit_factor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bot_core::StrategyMode;

    #[test]
    fn reset_circuit_breaker_clears_quarantined_pairs() {
        let risk_cfg = RiskConfig {
            max_daily_drawdown_pct: 5.0,
            max_pair_daily_drawdown_pct: 1.0,
            max_daily_profit_pct: 10.0,
            max_win_streak: 5,
            max_lose_streak: 5,
            streak_cooldown_minutes: 30,
            flatten_on_circuit_breaker: true,
        };
        let trading_cfg = TradingConfig {
            mode: StrategyMode::Scalping,
            timeframe: "5m".into(),
            pairs: vec!["BTCUSDT".into()],
            max_concurrent_positions: 3,
            base_risk_per_trade_pct: 0.75,
            position_sizing_mode: bot_core::PositionSizingMode::FixedUsdt,
            initial_equity_usdt: 10_000.0,
            taker_fee_bps: 10.0,
        };
        let now = Utc::now();
        let mut rm = RiskManager::new(risk_cfg, trading_cfg, now);
        rm.record_realized_pnl("BTCUSDT", -150.0, now);
        assert!(rm.status().quarantined_pairs.contains(&"BTCUSDT".to_string()));
        rm.reset_circuit_breaker();
        assert!(rm.status().quarantined_pairs.is_empty());
    }

    #[test]
    fn zero_equity_blocks_entry_and_zero_streak_threshold_does_not_trip() {
        let risk_cfg = RiskConfig {
            max_daily_drawdown_pct: 5.0,
            max_pair_daily_drawdown_pct: 2.0,
            max_daily_profit_pct: 10.0,
            max_win_streak: 0,
            max_lose_streak: 0,
            streak_cooldown_minutes: 30,
            flatten_on_circuit_breaker: true,
        };
        let trading_cfg = TradingConfig {
            mode: StrategyMode::Scalping,
            timeframe: "5m".into(),
            pairs: vec!["BTCUSDT".into()],
            max_concurrent_positions: 3,
            base_risk_per_trade_pct: 0.75,
            position_sizing_mode: bot_core::PositionSizingMode::FixedUsdt,
            initial_equity_usdt: 0.0,
            taker_fee_bps: 10.0,
        };
        let now = Utc::now();
        let mut rm = RiskManager::new(risk_cfg, trading_cfg, now);
        assert!(rm.authorize_entry("BTCUSDT", 100.0, 98.0, 0, now).is_err());

        // With streak limits set to 0, consecutive wins/losses should NOT enter Cooldown
        rm.record_realized_pnl("BTCUSDT", 10.0, now);
        assert_ne!(rm.status().state, bot_core::CircuitBreakerState::Cooldown);
        rm.record_realized_pnl("BTCUSDT", -10.0, now);
        assert_ne!(rm.status().state, bot_core::CircuitBreakerState::Cooldown);
    }
}

