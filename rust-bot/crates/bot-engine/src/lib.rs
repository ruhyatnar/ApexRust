//! Main Tokio trading orchestrator tying together:
//! Binance WebSocket/REST Failover -> Indicator Pipeline -> Trend Strategy ->
//! Risk Circuit Breaker & Quantitative Kelly Sizing -> Live/Paper Order Execution ->
//! Sanitized Git Backup -> Broadcast Telemetry.

pub mod git_sync;

use bot_core::{
    BotConfig, Candle, CircuitBreakerState, ClosedTrade, EngineSnapshot, ExchangeVenue, ExitReason,
    MarketEvent, OrderExecutionMethod, PairSnapshot, Position, PositionSizingMode, Result, Side,
    VolatilitySpikeAlert,
};
use bot_exchange::{FailoverGateway, LiveOrderRequest};
use bot_indicators::IndicatorPipeline;
use bot_risk::{
    compute_expectancy_and_profit_factor, compute_kelly_fraction, compute_log_growth_rate,
    compute_stop_distance_notional, RiskManager,
};
use bot_strategy::{
    build_exit_plan_with_features, evaluate_entry_signal_full, manage_position_tick,
    PositionTickAction,
};
use chrono::Utc;
use git_sync::GitBackupSync;
use std::collections::HashMap;
use std::path::PathBuf;
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
    BackupNow,
    ManualOrder {
        symbol: String,
        side: Side,
        notional_usdt: f64,
        order_method: OrderExecutionMethod,
        limit_price: Option<f64>,
    },
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

    fn venue_enabled(&self) -> bool {
        match self.cfg.exchange.venue {
            ExchangeVenue::Spot => self.cfg.features.spot_market,
            ExchangeVenue::Futures => self.cfg.features.futures_market,
        }
    }

    fn is_live_armed(&self) -> bool {
        !self.cfg.exchange.paper_trading
            && self
                .cfg
                .exchange
                .credentials
                .as_ref()
                .is_some_and(|c| c.armed_for_live_orders)
    }

    /// Compute quantitative position size (in base asset quantity) honoring
    /// `FixedUsdt`, `FixedRiskPct`, `QuarterKelly`, `HalfKelly`, and `FullKelly`,
    /// returning `None` when negative Kelly (`f* <= 0`) blocks entry.
    pub fn compute_position_quantity(
        &self,
        recent_trades: &[ClosedTrade],
        equity_usdt: f64,
        entry_price: f64,
        stop_loss_price: f64,
        risk_qty: f64,
    ) -> Option<f64> {
        if entry_price <= 0.0 {
            return None;
        }
        match self.cfg.trading.position_sizing_mode {
            PositionSizingMode::FixedUsdt => {
                if self.cfg.automation.auto_order_notional_usdt > 0.0 {
                    Some(self.cfg.automation.auto_order_notional_usdt / entry_price)
                } else {
                    Some(risk_qty)
                }
            }
            PositionSizingMode::FixedRiskPct => Some(risk_qty),
            PositionSizingMode::QuarterKelly
            | PositionSizingMode::HalfKelly
            | PositionSizingMode::FullKelly => {
                let (p, avg_win_r, avg_loss_r, gross_profit, gross_loss) =
                    if recent_trades.is_empty() {
                        (0.58, 1.8, 1.0, 180.0, 100.0)
                    } else {
                        let wins: Vec<&ClosedTrade> =
                            recent_trades.iter().filter(|t| t.pnl_usdt > 0.0).collect();
                        let losses: Vec<&ClosedTrade> =
                            recent_trades.iter().filter(|t| t.pnl_usdt <= 0.0).collect();
                        let p = wins.len() as f64 / recent_trades.len() as f64;
                        let gp: f64 = wins.iter().map(|t| t.pnl_usdt).sum();
                        let gl: f64 = losses.iter().map(|t| t.pnl_usdt.abs()).sum();
                        let awr = if wins.is_empty() {
                            1.8
                        } else {
                            wins.iter().map(|t| t.r_multiple.abs().max(0.05)).sum::<f64>()
                                / wins.len() as f64
                        };
                        let alr = if losses.is_empty() {
                            1.0
                        } else {
                            losses
                                .iter()
                                .map(|t| t.r_multiple.abs().max(0.05))
                                .sum::<f64>()
                                / losses.len() as f64
                        };
                        (p, awr, alr, gp, gl)
                    };
                let (exp_r, _pf) =
                    compute_expectancy_and_profit_factor(p, avg_win_r, avg_loss_r, gross_profit, gross_loss);
                let payoff_b = if avg_loss_r > 1e-9 {
                    avg_win_r / avg_loss_r
                } else {
                    1.5
                };
                let raw_kelly = compute_kelly_fraction(p, payoff_b);
                if raw_kelly <= 0.0 || exp_r <= 0.0 {
                    return None;
                }
                let mult = match self.cfg.trading.position_sizing_mode {
                    PositionSizingMode::QuarterKelly => 0.25,
                    PositionSizingMode::HalfKelly => 0.50,
                    PositionSizingMode::FullKelly => 1.0,
                    _ => 0.50,
                };
                let frac = (raw_kelly * mult).clamp(0.0, 0.5);
                let _log_g = compute_log_growth_rate(p, payoff_b, frac);
                let notional = compute_stop_distance_notional(
                    equity_usdt,
                    frac,
                    entry_price,
                    stop_loss_price,
                )
                .ok()?;
                Some(notional / entry_price)
            }
        }
    }

    fn run_git_backup(&self, reason: &str) {
        let sync = GitBackupSync::new(self.cfg.git_backup.clone());
        let repo_root = PathBuf::from(".");
        match sync.backup_snapshot(&repo_root, reason) {
            Ok(outcome) => info!(summary = %outcome.summary, "Git backup sync completed"),
            Err(err) => warn!(%err, "Git backup sync failed"),
        }
    }

    pub async fn run(self: Arc<Self>, mut cmd_rx: mpsc::Receiver<EngineCommand>) -> Result<()> {
        let mut pipelines: HashMap<String, IndicatorPipeline> = HashMap::new();
        let mut candle_history: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut bar_index: HashMap<String, u64> = HashMap::new();
        let mut last_entry_bar: HashMap<String, u64> = HashMap::new();
        let mut last_prices: HashMap<String, f64> = HashMap::new();
        let mut open_positions: HashMap<String, Position> = HashMap::new();
        let mut open_oco_lists: HashMap<String, Option<i64>> = HashMap::new();
        let mut recent_trades: Vec<ClosedTrade> = Vec::new();
        let mut recent_volatility_alerts: Vec<VolatilitySpikeAlert> = Vec::new();
        let mut last_vol_alert_ms: HashMap<String, i64> = HashMap::new();
        let mut risk = RiskManager::new(self.cfg.risk.clone(), self.cfg.trading.clone(), Utc::now());
        let mut running = true;
        let fee_bps = self.cfg.trading.taker_fee_bps;

        // 1. Historical kline warmup via REST API (routed by venue Spot vs Futures)
        for pair in &self.cfg.trading.pairs {
            let mut pipe = IndicatorPipeline::new(&self.cfg.indicators);
            let mut hist = Vec::new();
            let mut bars_seen = 0u64;
            if let Ok(candles) = self
                .gateway
                .fetch_klines(pair, &self.cfg.trading.timeframe, 220)
                .await
            {
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
                                self.flatten_all_positions(&mut open_positions, &mut open_oco_lists, &last_prices, &mut recent_trades, &mut risk, fee_bps).await;
                            }
                        }
                        EngineCommand::ResetCircuitBreaker => risk.reset_circuit_breaker(),
                        EngineCommand::FlattenAll => {
                            self.flatten_all_positions(&mut open_positions, &mut open_oco_lists, &last_prices, &mut recent_trades, &mut risk, fee_bps).await;
                        }
                        EngineCommand::BackupNow => {
                            self.run_git_backup("chore(backup): manual desktop snapshot");
                        }
                        EngineCommand::ManualOrder { symbol, side, notional_usdt, order_method, limit_price } => {
                            if !self.cfg.features.manual_trading || !self.venue_enabled() {
                                warn!(%symbol, "Manual order blocked by FeatureToggles");
                                continue;
                            }
                            if open_positions.contains_key(&symbol) {
                                warn!(%symbol, "Manual order rejected: position already open");
                                continue;
                            }
                            let ref_px = limit_price
                                .filter(|&p| p > 0.0)
                                .or_else(|| last_prices.get(&symbol).copied())
                                .unwrap_or(0.0);
                            if ref_px <= 0.0 || notional_usdt <= 0.0 {
                                warn!(%symbol, "Manual order rejected: invalid price or notional");
                                continue;
                            }
                            let atr = pipelines.get(&symbol).and_then(|p| p.snapshot().atr).unwrap_or(ref_px * 0.01);
                            let plan = build_exit_plan_with_features(side, ref_px, atr, &self.cfg.exits, &self.cfg.features);
                            let auth_ok = if self.cfg.features.circuit_breaker {
                                risk.authorize_entry(&symbol, ref_px, plan.initial_stop_loss, open_positions.len(), Utc::now()).is_ok()
                            } else {
                                true
                            };
                            if auth_ok {
                                let qty = notional_usdt / ref_px;
                                let mut actual_entry = ref_px;
                                let mut actual_qty = qty;
                                let mut list_id = None;
                                if self.is_live_armed() {
                                    let req = LiveOrderRequest {
                                        symbol: symbol.clone(),
                                        side,
                                        order_method,
                                        quantity: qty,
                                        quote_order_qty: Some(notional_usdt),
                                        limit_price,
                                        take_profit_price: Some(plan.take_profit_2),
                                        stop_loss_price: Some(plan.initial_stop_loss),
                                        time_in_force: self.cfg.automation.time_in_force.clone(),
                                        reduce_only: false,
                                    };
                                    match self.gateway.execute_live_order(&req).await {
                                        Ok(ack) => {
                                            if ack.avg_price > 0.0 { actual_entry = ack.avg_price; }
                                            if ack.executed_qty > 0.0 { actual_qty = ack.executed_qty; }
                                            list_id = ack.order_list_id;
                                        }
                                        Err(err) => {
                                            warn!(%symbol, %err, "Live manual order failed");
                                            continue;
                                        }
                                    }
                                }
                                let now = Utc::now();
                                open_oco_lists.insert(symbol.clone(), list_id);
                                open_positions.insert(symbol.clone(), Position {
                                    id: format!("{}-manual-{}", symbol, now.timestamp_millis()),
                                    symbol,
                                    side,
                                    entry_price: actual_entry,
                                    quantity: actual_qty,
                                    remaining_quantity: actual_qty,
                                    unrealized_pnl_usdt: 0.0,
                                    realized_pnl_usdt: 0.0,
                                    highest_favorable_price: actual_entry,
                                    exit_plan: plan,
                                    opened_at: now,
                                });
                            }
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

                    // Manage existing position tick-by-tick (24/7 regardless of session window)
                    if let Some(mut pos) = open_positions.remove(&ev.symbol) {
                        let atr_val = ind.atr.unwrap_or(pos.exit_plan.risk_distance_r);
                        match manage_position_tick(&mut pos, ev.price, atr_val, &self.cfg.exits) {
                            PositionTickAction::Hold => {
                                open_positions.insert(ev.symbol.clone(), pos);
                            }
                            PositionTickAction::PartialClose { ratio, exit_price, reason } => {
                                let close_qty = pos.remaining_quantity * ratio;
                                let mut exec_exit_px = exit_price;
                                if self.is_live_armed() && self.cfg.automation.auto_close_on_exit {
                                    let req = LiveOrderRequest {
                                        symbol: ev.symbol.clone(),
                                        side: pos.side,
                                        order_method: OrderExecutionMethod::Market,
                                        quantity: close_qty,
                                        quote_order_qty: None,
                                        limit_price: None,
                                        take_profit_price: None,
                                        stop_loss_price: None,
                                        time_in_force: "GTC".into(),
                                        reduce_only: true,
                                    };
                                    match self.gateway.execute_live_order(&req).await {
                                        Ok(ack) if ack.avg_price > 0.0 => exec_exit_px = ack.avg_price,
                                        Ok(_) => {}
                                        Err(err) => warn!(symbol = %ev.symbol, %err, "Live partial exit failed"),
                                    }
                                }
                                let pnl = Self::calc_net_pnl(pos.side, pos.entry_price, exec_exit_px, close_qty, fee_bps);
                                let r_mult = pnl / (pos.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                pos.remaining_quantity -= close_qty;
                                pos.realized_pnl_usdt += pnl;
                                risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                recent_trades.insert(0, ClosedTrade {
                                    id: format!("{}-tp1", pos.id),
                                    symbol: pos.symbol.clone(),
                                    side: pos.side,
                                    entry_price: pos.entry_price,
                                    exit_price: exec_exit_px,
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
                                let mut exec_exit_px = exit_price;
                                if self.is_live_armed() && self.cfg.automation.auto_close_on_exit {
                                    let list_id = open_oco_lists.remove(&ev.symbol).flatten();
                                    let _ = self.gateway.cancel_open_brackets(&ev.symbol, list_id).await;
                                    let req = LiveOrderRequest {
                                        symbol: ev.symbol.clone(),
                                        side: pos.side,
                                        order_method: OrderExecutionMethod::Market,
                                        quantity: closed_qty,
                                        quote_order_qty: None,
                                        limit_price: None,
                                        take_profit_price: None,
                                        stop_loss_price: None,
                                        time_in_force: "GTC".into(),
                                        reduce_only: true,
                                    };
                                    match self.gateway.execute_live_order(&req).await {
                                        Ok(ack) if ack.avg_price > 0.0 => exec_exit_px = ack.avg_price,
                                        Ok(_) => {}
                                        Err(err) => warn!(symbol = %ev.symbol, %err, "Live full exit failed"),
                                    }
                                }
                                let pnl = Self::calc_net_pnl(pos.side, pos.entry_price, exec_exit_px, closed_qty, fee_bps);
                                let r_mult = pnl / (pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                                risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                recent_trades.insert(0, ClosedTrade {
                                    id: pos.id.clone(),
                                    symbol: pos.symbol.clone(),
                                    side: pos.side,
                                    entry_price: pos.entry_price,
                                    exit_price: exec_exit_px,
                                    quantity: closed_qty,
                                    pnl_usdt: pnl,
                                    r_multiple: r_mult,
                                    reason,
                                    closed_at: ev.received_at,
                                });
                                if self.cfg.features.git_auto_backup {
                                    self.run_git_backup("chore(backup): auto-sync after trade exit");
                                }
                                if self.cfg.features.circuit_breaker
                                    && risk.status().state == CircuitBreakerState::Halted
                                    && self.cfg.risk.flatten_on_circuit_breaker
                                {
                                    self.flatten_all_positions(&mut open_positions, &mut open_oco_lists, &last_prices, &mut recent_trades, &mut risk, fee_bps).await;
                                }
                            }
                        }
                    } else if running
                        && ev.candle.is_closed
                        && self.venue_enabled()
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
                                let auth_res = if self.cfg.features.circuit_breaker {
                                    risk.authorize_entry(
                                        &sig.symbol,
                                        sig.entry_price,
                                        plan.initial_stop_loss,
                                        open_positions.len(),
                                        ev.received_at,
                                    )
                                } else {
                                    let stop_dist = (sig.entry_price - plan.initial_stop_loss).abs().max(1e-9);
                                    let risk_usdt = risk.current_equity() * (self.cfg.trading.base_risk_per_trade_pct / 100.0);
                                    Ok(risk_usdt / stop_dist)
                                };
                                match auth_res {
                                    Ok(risk_qty) => {
                                        let Some(mut qty) = self.compute_position_quantity(
                                            &recent_trades,
                                            risk.current_equity(),
                                            sig.entry_price,
                                            plan.initial_stop_loss,
                                            risk_qty,
                                        ) else {
                                            warn!(symbol = %sig.symbol, "Entry blocked by negative Kelly filter (EV <= 0)");
                                            continue;
                                        };
                                        let mut actual_entry = sig.entry_price;
                                        let mut list_id = None;
                                        if self.is_live_armed() {
                                            let limit_px = if matches!(
                                                self.cfg.automation.order_method,
                                                OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
                                            ) {
                                                let off = self.cfg.automation.limit_offset_bps.max(0.0) / 10_000.0;
                                                Some(match sig.side {
                                                    Side::Long => sig.entry_price * (1.0 - off),
                                                    Side::Short => sig.entry_price * (1.0 + off),
                                                })
                                            } else {
                                                None
                                            };
                                            let req = LiveOrderRequest {
                                                symbol: sig.symbol.clone(),
                                                side: sig.side,
                                                order_method: self.cfg.automation.order_method,
                                                quantity: qty,
                                                quote_order_qty: Some(qty * sig.entry_price),
                                                limit_price: limit_px,
                                                take_profit_price: Some(plan.take_profit_2),
                                                stop_loss_price: Some(plan.initial_stop_loss),
                                                time_in_force: self.cfg.automation.time_in_force.clone(),
                                                reduce_only: false,
                                            };
                                            match self.gateway.execute_live_order(&req).await {
                                                Ok(ack) => {
                                                    if ack.avg_price > 0.0 { actual_entry = ack.avg_price; }
                                                    if ack.executed_qty > 0.0 { qty = ack.executed_qty; }
                                                    list_id = ack.order_list_id;
                                                }
                                                Err(err) => {
                                                    warn!(symbol = %sig.symbol, %err, "Live entry rejected");
                                                    continue;
                                                }
                                            }
                                        }
                                        last_entry_bar.insert(sig.symbol.clone(), current_bar);
                                        open_oco_lists.insert(sig.symbol.clone(), list_id);
                                        let pos = Position {
                                            id: format!("{}-{}", sig.symbol, ev.received_at.timestamp_millis()),
                                            symbol: sig.symbol.clone(),
                                            side: sig.side,
                                            entry_price: actual_entry,
                                            quantity: qty,
                                            remaining_quantity: qty,
                                            unrealized_pnl_usdt: 0.0,
                                            realized_pnl_usdt: 0.0,
                                            highest_favorable_price: actual_entry,
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

    async fn flatten_all_positions(
        &self,
        open_positions: &mut HashMap<String, Position>,
        open_oco_lists: &mut HashMap<String, Option<i64>>,
        last_prices: &HashMap<String, f64>,
        recent_trades: &mut Vec<ClosedTrade>,
        risk: &mut RiskManager,
        taker_fee_bps: f64,
    ) {
        let now = Utc::now();
        for (sym, pos) in open_positions.drain() {
            let mut px = last_prices.get(&sym).copied().unwrap_or(pos.entry_price);
            let qty = pos.remaining_quantity;
            if self.is_live_armed() {
                let list_id = open_oco_lists.remove(&sym).flatten();
                let _ = self.gateway.cancel_open_brackets(&sym, list_id).await;
                let req = LiveOrderRequest {
                    symbol: sym.clone(),
                    side: pos.side,
                    order_method: OrderExecutionMethod::Market,
                    quantity: qty,
                    quote_order_qty: None,
                    limit_price: None,
                    take_profit_price: None,
                    stop_loss_price: None,
                    time_in_force: "GTC".into(),
                    reduce_only: true,
                };
                if let Ok(ack) = self.gateway.execute_live_order(&req).await {
                    if ack.avg_price > 0.0 {
                        px = ack.avg_price;
                    }
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_kelly_blocks_quantitative_entry() {
        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.trading.position_sizing_mode = PositionSizingMode::HalfKelly;
        let engine = TradingEngine::new(cfg).unwrap();

        let losing_trades = vec![
            ClosedTrade {
                id: "1".into(),
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                entry_price: 100.0,
                exit_price: 98.0,
                quantity: 1.0,
                pnl_usdt: -20.0,
                r_multiple: -1.0,
                reason: ExitReason::StopLoss,
                closed_at: Utc::now(),
            },
            ClosedTrade {
                id: "2".into(),
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                entry_price: 100.0,
                exit_price: 98.0,
                quantity: 1.0,
                pnl_usdt: -20.0,
                r_multiple: -1.0,
                reason: ExitReason::StopLoss,
                closed_at: Utc::now(),
            },
        ];

        assert!(engine.compute_position_quantity(&losing_trades, 10_000.0, 100.0, 98.0, 1.0).is_none());
        assert!(engine.compute_position_quantity(&[], 10_000.0, 100.0, 98.0, 1.0).is_some());
    }
}
