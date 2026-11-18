//! Main Tokio trading orchestrator tying together:
//! Binance WebSocket/REST Failover -> Indicator Pipeline -> Trend Strategy ->
//! Risk Circuit Breaker -> Position & Exit Execution -> Broadcast Telemetry.

pub mod git_sync;

use bot_core::{
    BotConfig, Candle, CircuitBreakerState, ClosedTrade, EngineSnapshot, ExitReason, MarketEvent,
    PairSnapshot, Position, PositionSizingMode, Result, Side, VolatilitySpikeAlert,
};
use bot_exchange::FailoverGateway;
use bot_indicators::IndicatorPipeline;
use bot_risk::RiskManager;
use bot_strategy::{
    build_exit_plan_with_features, evaluate_entry_signal_full, manage_position_tick,
    PositionTickAction,
};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum EngineCommand {
    Pause,
    Resume,
    TripCircuitBreaker(String),
    ResetCircuitBreaker,
    FlattenAll,
}

pub struct TradingEngine {
    cfg: BotConfig,
    gateway: Arc<FailoverGateway>,
    snapshot_tx: broadcast::Sender<EngineSnapshot>,
    latest_snapshot: Arc<RwLock<EngineSnapshot>>,
}

impl TradingEngine {
    pub fn new(cfg: BotConfig) -> Result<Self> {
        let gateway = Arc::new(FailoverGateway::new_with_toggles(
            cfg.exchange.clone(),
            cfg.trading.pairs.clone(),
            cfg.trading.timeframe.clone(),
            cfg.features.ws_primary_feed,
            cfg.features.rest_fallback,
        )?);
        let gw_mode = if cfg.features.ws_primary_feed {
            bot_core::TransportMode::WsPrimary
        } else if cfg.features.rest_fallback {
            bot_core::TransportMode::RestFallback
        } else {
            bot_core::TransportMode::Reconnecting
        };
        let risk = RiskManager::new(cfg.risk.clone(), cfg.trading.clone(), Utc::now());
        let initial = EngineSnapshot {
            running: true,
            venue: cfg.exchange.venue,
            transport_mode: gw_mode,
            failover_count: 0,
            last_ws_age_ms: 0,
            risk: risk.status(),
            pairs: Vec::new(),
            recent_trades: Vec::new(),
            recent_volatility_alerts: Vec::new(),
            updated_at: Utc::now(),
        };
        let (snapshot_tx, _) = broadcast::channel(64);
        Ok(Self {
            cfg,
            gateway,
            snapshot_tx,
            latest_snapshot: Arc::new(RwLock::new(initial)),
        })
    }

    pub fn config(&self) -> &BotConfig {
        &self.cfg
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineSnapshot> {
        self.snapshot_tx.subscribe()
    }

    pub fn latest_snapshot_handle(&self) -> Arc<RwLock<EngineSnapshot>> {
        Arc::clone(&self.latest_snapshot)
    }

    pub async fn run(self: Arc<Self>, mut cmd_rx: mpsc::Receiver<EngineCommand>) -> Result<()> {
        let mut pipelines: HashMap<String, IndicatorPipeline> = HashMap::new();
        let mut candle_history: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut bar_index: HashMap<String, u64> = HashMap::new();
        let mut last_entry_bar: HashMap<String, u64> = HashMap::new();
        let mut last_prices: HashMap<String, f64> = HashMap::new();
        let mut open_positions: HashMap<String, Position> = HashMap::new();
        let mut recent_trades: Vec<ClosedTrade> = Vec::new();
        let mut recent_volatility_alerts: Vec<VolatilitySpikeAlert> = Vec::new();
        let mut last_vol_alert_ms: HashMap<String, i64> = HashMap::new();
        let mut risk = RiskManager::new(self.cfg.risk.clone(), self.cfg.trading.clone(), Utc::now());
        let mut running = true;
        let fee_bps = self.cfg.trading.taker_fee_bps;

        // 1. Historical kline warmup via REST API
        let rest = self.gateway.rest_client();
        for pair in &self.cfg.trading.pairs {
            let mut pipe = IndicatorPipeline::new(&self.cfg.indicators);
            let mut hist = Vec::new();
            let mut bars_seen = 0u64;
            if let Ok(candles) = rest.fetch_klines(pair, &self.cfg.trading.timeframe, 220).await {
                for c in &candles {
                    if !c.is_closed {
                        continue;
                    }
                    pipe.update(c);
                    last_prices.insert(pair.clone(), c.close);
                    hist.push(c.clone());
                    if hist.len() > 30 {
                        hist.remove(0);
                    }
                    bars_seen += 1;
                }
                info!(%pair, bars = bars_seen, "Warmed up indicator pipeline");
            }
            bar_index.insert(pair.clone(), bars_seen);
            candle_history.insert(pair.clone(), hist);
            pipelines.insert(pair.clone(), pipe);
        }

        // 2. Spawn WebSocket primary + REST fallback feed
        let (mkt_tx, mut mkt_rx) = mpsc::channel::<MarketEvent>(512);
        Arc::clone(&self.gateway).spawn(mkt_tx);

        // 3. Single-writer event loop
        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    match cmd {
                        EngineCommand::Pause => running = false,
                        EngineCommand::Resume => running = true,
                        EngineCommand::TripCircuitBreaker(reason) => {
                            risk.trip_circuit_breaker(reason);
                            if self.cfg.risk.flatten_on_circuit_breaker {
                                Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk, fee_bps);
                            }
                        }
                        EngineCommand::ResetCircuitBreaker => risk.reset_circuit_breaker(),
                        EngineCommand::FlattenAll => {
                            Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk, fee_bps);
                        }
                    }
                }
                Some(ev) = mkt_rx.recv() => {
                    last_prices.insert(ev.symbol.clone(), ev.price);
                    let pipe = pipelines
                        .entry(ev.symbol.clone())
                        .or_insert_with(|| IndicatorPipeline::new(&self.cfg.indicators));

                    let ind = if ev.candle.is_closed {
                        let next_idx = bar_index.get(&ev.symbol).copied().unwrap_or(0) + 1;
                        bar_index.insert(ev.symbol.clone(), next_idx);
                        let hist = candle_history.entry(ev.symbol.clone()).or_default();
                        if hist.last().map_or(true, |c| c.open_time_ms != ev.candle.open_time_ms) {
                            hist.push(ev.candle.clone());
                            if hist.len() > 30 {
                                hist.remove(0);
                            }
                        }
                        pipe.update(&ev.candle)
                    } else {
                        pipe.snapshot()
                    };

                    // Evaluate ATR volatility spike alerts on closed bars
                    if ev.candle.is_closed && self.cfg.indicators.volatility_alerts_enabled {
                        if let (Some(atr), Some(prev_atr)) = (ind.atr, ind.prev_atr) {
                            if ev.price > 0.0 && prev_atr > 0.0 {
                                let atr_pct = (atr / ev.price) * 100.0;
                                let bar_range = (ev.candle.high - ev.candle.low).max(0.0);
                                let exp_ratio = (atr / prev_atr).max(bar_range / prev_atr);
                                let now_ms = ev.received_at.timestamp_millis();
                                let cooldown_ms = (self.cfg.indicators.volatility_alert_cooldown_sec as i64) * 1000;
                                let last_ms = last_vol_alert_ms.get(&ev.symbol).copied().unwrap_or(0);
                                let is_spike = (atr_pct >= self.cfg.indicators.atr_spike_pct_threshold
                                    && exp_ratio >= self.cfg.indicators.atr_expansion_ratio_threshold)
                                    || exp_ratio >= self.cfg.indicators.atr_expansion_ratio_threshold * 1.18;
                                if is_spike && now_ms - last_ms >= cooldown_ms {
                                    last_vol_alert_ms.insert(ev.symbol.clone(), now_ms);
                                    let msg = format!(
                                        "{} ATR spike: {:.2}% of price · {:.2}x baseline",
                                        ev.symbol, atr_pct, exp_ratio
                                    );
                                    warn!(symbol = %ev.symbol, atr_pct, exp_ratio, "ATR volatility spike detected");
                                    recent_volatility_alerts.insert(0, VolatilitySpikeAlert {
                                        id: format!("vol-{}-{}", ev.symbol, now_ms),
                                        symbol: ev.symbol.clone(),
                                        price: ev.price,
                                        atr,
                                        atr_pct,
                                        expansion_ratio: exp_ratio,
                                        message: msg,
                                        triggered_at: ev.received_at,
                                    });
                                    recent_volatility_alerts.truncate(25);
                                }
                            }
                        }
                    }

                    // Manage existing position tick-by-tick (SL / TP1 / BE / ATR Trailing)
                    if let Some(mut pos) = open_positions.remove(&ev.symbol) {
                        let atr_val = ind.atr.unwrap_or(pos.exit_plan.risk_distance_r);
                        match manage_position_tick(&mut pos, ev.price, atr_val, &self.cfg.exits) {
                            PositionTickAction::Hold => {
                                open_positions.insert(ev.symbol.clone(), pos);
                            }
                            PositionTickAction::PartialClose { ratio, exit_price, reason } => {
                                let close_qty = pos.remaining_quantity * ratio;
                                let pnl = Self::calc_net_pnl(pos.side, pos.entry_price, exit_price, close_qty, fee_bps);
                                let r_mult = pnl / (pos.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                pos.remaining_quantity -= close_qty;
                                pos.realized_pnl_usdt += pnl;
                                risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                recent_trades.insert(0, ClosedTrade {
                                    id: format!("{}-tp1", pos.id),
                                    symbol: pos.symbol.clone(),
                                    side: pos.side,
                                    entry_price: pos.entry_price,
                                    exit_price,
                                    quantity: close_qty,
                                    pnl_usdt: pnl,
                                    r_multiple: r_mult,
                                    reason,
                                    closed_at: ev.received_at,
                                });
                                open_positions.insert(ev.symbol.clone(), pos);
                            }
                            PositionTickAction::FullClose { exit_price, reason } => {
                                let closed_qty = pos.remaining_quantity;
                                let pnl = Self::calc_net_pnl(pos.side, pos.entry_price, exit_price, closed_qty, fee_bps);
                                let r_mult = pnl / (pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                                risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                recent_trades.insert(0, ClosedTrade {
                                    id: pos.id.clone(),
                                    symbol: pos.symbol.clone(),
                                    side: pos.side,
                                    entry_price: pos.entry_price,
                                    exit_price,
                                    quantity: closed_qty,
                                    pnl_usdt: pnl,
                                    r_multiple: r_mult,
                                    reason,
                                    closed_at: ev.received_at,
                                });
                                if self.cfg.features.circuit_breaker
                                    && risk.status().state == CircuitBreakerState::Halted
                                    && self.cfg.risk.flatten_on_circuit_breaker
                                {
                                    Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk, fee_bps);
                                }
                            }
                        }
                    } else if running
                        && ev.candle.is_closed
                        && self.cfg.automation.enabled
                        && self.cfg.features.automated_trading
                        && self.cfg.features.signal_generator
                        && (!self.cfg.features.session_window_filter
                            || self.cfg.automation.is_within_session_windows(ev.received_at))
                    {
                        let current_bar = bar_index.get(&ev.symbol).copied().unwrap_or(0);
                        let last_bar = last_entry_bar.get(&ev.symbol).copied();
                        let cooldown_ok = last_bar.map_or(true, |prev| {
                            current_bar.saturating_sub(prev) >= self.cfg.automation.signal_cooldown_bars as u64
                        });

                        if cooldown_ok {
                            let recent_slice = candle_history
                                .get(&ev.symbol)
                                .map(Vec::as_slice)
                                .unwrap_or(&[]);
                            if let Some(sig) = evaluate_entry_signal_full(
                                &ev.symbol,
                                &ev.candle,
                                &ind,
                                &self.cfg.trading,
                                &self.cfg.indicators,
                                self.cfg.automation.strategy_profile,
                                self.cfg.automation.direction_policy,
                                &self.cfg.features,
                                recent_slice,
                                ev.received_at,
                            ) {
                                let plan = build_exit_plan_with_features(
                                    sig.side,
                                    sig.entry_price,
                                    sig.atr,
                                    &self.cfg.exits,
                                    &self.cfg.features,
                                );
                                match risk.authorize_entry(
                                    &sig.symbol,
                                    sig.entry_price,
                                    plan.initial_stop_loss,
                                    open_positions.len(),
                                    ev.received_at,
                                ) {
                                    Ok(risk_qty) => {
                                        let qty = match self.cfg.trading.position_sizing_mode {
                                            PositionSizingMode::FixedUsdt
                                                if self.cfg.automation.auto_order_notional_usdt > 0.0
                                                    && sig.entry_price > 0.0 =>
                                            {
                                                self.cfg.automation.auto_order_notional_usdt / sig.entry_price
                                            }
                                            _ => risk_qty,
                                        };
                                        last_entry_bar.insert(sig.symbol.clone(), current_bar);
                                        let pos = Position {
                                            id: format!("{}-{}", sig.symbol, ev.received_at.timestamp_millis()),
                                            symbol: sig.symbol.clone(),
                                            side: sig.side,
                                            entry_price: sig.entry_price,
                                            quantity: qty,
                                            remaining_quantity: qty,
                                            unrealized_pnl_usdt: 0.0,
                                            realized_pnl_usdt: 0.0,
                                            highest_favorable_price: sig.entry_price,
                                            exit_plan: plan,
                                            opened_at: ev.received_at,
                                        };
                                        info!(symbol = %pos.symbol, side = ?pos.side, entry = pos.entry_price, "Opened position");
                                        open_positions.insert(sig.symbol, pos);
                                    }
                                    Err(err) => warn!(symbol = %sig.symbol, %err, "Entry blocked by risk manager"),
                                }
                            }
                        }
                    }

                    recent_trades.truncate(100);
                    let gw_health = self.gateway.health().await;
                    let eq_base = risk.status().starting_daily_equity.max(1.0);
                    let pairs = self.cfg.trading.pairs.iter().map(|sym| {
                        let p_pnl = risk.pair_daily_pnl(sym);
                        PairSnapshot {
                            symbol: sym.clone(),
                            last_price: last_prices.get(sym).copied().unwrap_or(0.0),
                            daily_pnl_usdt: p_pnl,
                            daily_pnl_pct: (p_pnl / eq_base) * 100.0,
                            indicators: pipelines.get(sym).map(|p| p.snapshot()).unwrap_or_default(),
                            open_position: open_positions.get(sym).cloned(),
                        }
                    }).collect();

                    let snap = EngineSnapshot {
                        running,
                        venue: self.cfg.exchange.venue,
                        transport_mode: gw_health.mode,
                        failover_count: gw_health.failover_count,
                        last_ws_age_ms: gw_health.last_ws_age_ms,
                        risk: risk.status(),
                        pairs,
                        recent_trades: recent_trades.clone(),
                        recent_volatility_alerts: recent_volatility_alerts.clone(),
                        updated_at: Utc::now(),
                    };
                    *self.latest_snapshot.write().await = snap.clone();
                    let _ = self.snapshot_tx.send(snap);
                }
            }
        }
    }

    fn calc_net_pnl(side: Side, entry: f64, exit: f64, qty: f64, taker_fee_bps: f64) -> f64 {
        let gross = match side {
            Side::Long => (exit - entry) * qty,
            Side::Short => (entry - exit) * qty,
        };
        let fee_rate = (taker_fee_bps.max(0.0)) / 10_000.0;
        let round_trip_fee = (entry + exit) * qty * fee_rate;
        gross - round_trip_fee
    }

    fn flatten_all(
        open_positions: &mut HashMap<String, Position>,
        last_prices: &HashMap<String, f64>,
        recent_trades: &mut Vec<ClosedTrade>,
        risk: &mut RiskManager,
        taker_fee_bps: f64,
    ) {
        let now = Utc::now();
        for (sym, pos) in open_positions.drain() {
            let px = last_prices.get(&sym).copied().unwrap_or(pos.entry_price);
            let qty = pos.remaining_quantity;
            let pnl = Self::calc_net_pnl(pos.side, pos.entry_price, px, qty, taker_fee_bps);
            let r_mult = pnl / (pos.exit_plan.risk_distance_r * qty).max(1e-9);
            risk.record_realized_pnl(&sym, pnl, now);
            recent_trades.insert(
                0,
                ClosedTrade {
                    id: pos.id,
                    symbol: sym,
                    side: pos.side,
                    entry_price: pos.entry_price,
                    exit_price: px,
                    quantity: qty,
                    pnl_usdt: pnl,
                    r_multiple: r_mult,
                    reason: ExitReason::CircuitBreakerFlatten,
                    closed_at: now,
                },
            );
        }
    }
}
