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

        let risk_usdt = self.current_equity * (self.trading_cfg.base_risk_per_trade_pct / 100.0);
        Ok(risk_usdt / stop_distance)
    }

    /// Record realized PnL for a closed fill and evaluate all circuit breakers.
    pub fn record_realized_pnl(&mut self, symbol: &str, pnl_usdt: f64, now: DateTime<Utc>) {
        self.maybe_rollover_utc_day(now);
        self.current_equity += pnl_usdt;
        *self.pair_daily_pnl.entry(symbol.to_string()).or_insert(0.0) += pnl_usdt;

        if pnl_usdt >= 0.0 {
            self.win_streak += 1;
            self.lose_streak = 0;
        } else {
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
            if self.lose_streak >= self.risk_cfg.max_lose_streak {
                self.state = CircuitBreakerState::Cooldown;
                let until = now + Duration::minutes(self.risk_cfg.streak_cooldown_minutes as i64);
                self.cooldown_until = Some(until);
                self.halt_reason = Some(format!(
                    "Max lose streak ({}) hit — cooldown until {}",
                    self.lose_streak,
                    until.format("%H:%M:%S UTC")
                ));
            } else if self.win_streak >= self.risk_cfg.max_win_streak {
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
