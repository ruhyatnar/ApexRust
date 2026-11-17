//! Main Tokio trading orchestrator tying together:
//! Binance WebSocket/REST Failover -> Indicator Pipeline -> Trend Strategy ->
//! Risk Circuit Breaker -> Position & Exit Execution -> Broadcast Telemetry.

pub mod git_sync;

use bot_core::{
    BotConfig, CircuitBreakerState, ClosedTrade, EngineSnapshot, ExitReason, MarketEvent,
    PairSnapshot, Position, Result, Side,
};
use bot_exchange::FailoverGateway;
use bot_indicators::IndicatorPipeline;
use bot_risk::RiskManager;
use bot_strategy::{
    build_exit_plan, evaluate_entry_signal_with_options, manage_position_tick, PositionTickAction,
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
        let gateway = Arc::new(FailoverGateway::new(
            cfg.exchange.clone(),
            cfg.trading.pairs.clone(),
            cfg.trading.timeframe.clone(),
        )?);
        let risk = RiskManager::new(cfg.risk.clone(), cfg.trading.clone(), Utc::now());
        let initial = EngineSnapshot {
            running: true,
            venue: cfg.exchange.venue,
            transport_mode: bot_core::TransportMode::WsPrimary,
            failover_count: 0,
            last_ws_age_ms: 0,
            risk: risk.status(),
            pairs: Vec::new(),
            recent_trades: Vec::new(),
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

    pub fn subscribe(&self) -> broadcast::Receiver<EngineSnapshot> {
        self.snapshot_tx.subscribe()
    }

    pub fn latest_snapshot_handle(&self) -> Arc<RwLock<EngineSnapshot>> {
        Arc::clone(&self.latest_snapshot)
    }

    pub async fn run(self: Arc<Self>, mut cmd_rx: mpsc::Receiver<EngineCommand>) -> Result<()> {
        let mut pipelines: HashMap<String, IndicatorPipeline> = HashMap::new();
        let mut last_prices: HashMap<String, f64> = HashMap::new();
        let mut open_positions: HashMap<String, Position> = HashMap::new();
        let mut recent_trades: Vec<ClosedTrade> = Vec::new();
        let mut risk = RiskManager::new(self.cfg.risk.clone(), self.cfg.trading.clone(), Utc::now());
        let mut running = true;

        // 1. Historical kline warmup via REST API
        let rest = self.gateway.rest_client();
        for pair in &self.cfg.trading.pairs {
            let mut pipe = IndicatorPipeline::new(&self.cfg.indicators);
            if let Ok(candles) = rest.fetch_klines(pair, &self.cfg.trading.timeframe, 220).await {
                for c in &candles {
                    pipe.update(c);
                    last_prices.insert(pair.clone(), c.close);
                }
                info!(%pair, bars = candles.len(), "Warmed up indicator pipeline");
            }
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
                                Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk);
                            }
                        }
                        EngineCommand::ResetCircuitBreaker => risk.reset_circuit_breaker(),
                        EngineCommand::FlattenAll => {
                            Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk);
                        }
                    }
                }
                Some(ev) = mkt_rx.recv() => {
                    last_prices.insert(ev.symbol.clone(), ev.price);
                    let pipe = pipelines
                        .entry(ev.symbol.clone())
                        .or_insert_with(|| IndicatorPipeline::new(&self.cfg.indicators));

                    let ind = if ev.candle.is_closed {
                        pipe.update(&ev.candle)
                    } else {
                        pipe.snapshot()
                    };

                    // Manage existing position tick-by-tick (SL / TP1 / BE / ATR Trailing)
                    if let Some(mut pos) = open_positions.remove(&ev.symbol) {
                        let atr_val = ind.atr.unwrap_or(pos.exit_plan.risk_distance_r);
                        match manage_position_tick(&mut pos, ev.price, atr_val, &self.cfg.exits) {
                            PositionTickAction::Hold => {
                                open_positions.insert(ev.symbol.clone(), pos);
                            }
                            PositionTickAction::PartialClose { ratio, exit_price, reason } => {
                                let close_qty = pos.remaining_quantity * ratio;
                                let pnl = Self::calc_pnl(pos.side, pos.entry_price, exit_price, close_qty);
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
                                    r_multiple: 1.5,
                                    reason,
                                    closed_at: ev.received_at,
                                });
                                open_positions.insert(ev.symbol.clone(), pos);
                            }
                            PositionTickAction::FullClose { exit_price, reason } => {
                                let pnl = Self::calc_pnl(pos.side, pos.entry_price, exit_price, pos.remaining_quantity);
                                let r_mult = pnl / (pos.exit_plan.risk_distance_r * pos.quantity).max(1e-9);
                                risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                recent_trades.insert(0, ClosedTrade {
                                    id: pos.id.clone(),
                                    symbol: pos.symbol.clone(),
                                    side: pos.side,
                                    entry_price: pos.entry_price,
                                    exit_price,
                                    quantity: pos.remaining_quantity,
                                    pnl_usdt: pnl,
                                    r_multiple: r_mult,
                                    reason,
                                    closed_at: ev.received_at,
                                });
                                if risk.status().state == CircuitBreakerState::Halted && self.cfg.risk.flatten_on_circuit_breaker {
                                    Self::flatten_all(&mut open_positions, &last_prices, &mut recent_trades, &mut risk);
                                }
                            }
                        }
                    } else if running
                        && ev.candle.is_closed
                        && self.cfg.automation.enabled
                        && self.cfg.features.automated_trading
                        && self.cfg.features.signal_generator
                    {
                        if let Some(sig) = evaluate_entry_signal_with_options(
                            &ev.symbol,
                            &ev.candle,
                            &ind,
                            &self.cfg.trading,
                            &self.cfg.indicators,
                            self.cfg.automation.strategy_profile,
                            self.cfg.automation.direction_policy,
                            &self.cfg.features,
                            ev.received_at,
                        ) {
                            let plan = build_exit_plan(sig.side, sig.entry_price, sig.atr, &self.cfg.exits);
                            match risk.authorize_entry(
                                &sig.symbol,
                                sig.entry_price,
                                plan.initial_stop_loss,
                                open_positions.len(),
                                ev.received_at,
                            ) {
                                Ok(qty) => {
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
                        updated_at: Utc::now(),
                    };
                    *self.latest_snapshot.write().await = snap.clone();
                    let _ = self.snapshot_tx.send(snap);
                }
            }
        }
    }

    fn calc_pnl(side: Side, entry: f64, exit: f64, qty: f64) -> f64 {
        match side {
            Side::Long => (exit - entry) * qty,
            Side::Short => (entry - exit) * qty,
        }
    }

    fn flatten_all(
        open_positions: &mut HashMap<String, Position>,
        last_prices: &HashMap<String, f64>,
        recent_trades: &mut Vec<ClosedTrade>,
        risk: &mut RiskManager,
    ) {
        let now = Utc::now();
        for (sym, pos) in open_positions.drain() {
            let px = last_prices.get(&sym).copied().unwrap_or(pos.entry_price);
            let pnl = Self::calc_pnl(pos.side, pos.entry_price, px, pos.remaining_quantity);
            risk.record_realized_pnl(&sym, pnl, now);
            recent_trades.insert(
                0,
                ClosedTrade {
                    id: pos.id,
                    symbol: sym,
                    side: pos.side,
                    entry_price: pos.entry_price,
                    exit_price: px,
                    quantity: pos.remaining_quantity,
                    pnl_usdt: pnl,
                    r_multiple: 0.0,
                    reason: ExitReason::CircuitBreakerFlatten,
                    closed_at: now,
                },
            );
        }
    }
}
