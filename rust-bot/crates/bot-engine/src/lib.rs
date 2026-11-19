//! Main Tokio trading orchestrator tying together:
//! Binance WebSocket/REST Failover -> Indicator Pipeline -> Trend Strategy ->
//! Risk Circuit Breaker & Quantitative Kelly Sizing -> Live/Paper Order Execution ->
//! Sanitized Git Backup -> Broadcast Telemetry.

pub mod git_sync;

use bot_core::{
    has_candle_sequence_gap, normalize_symbol_list, rank_screener_tickers,
    resolve_effective_watchlist, BotConfig, Candle, CircuitBreakerState,
    ClosedTrade, DirectionPolicy, EngineSnapshot, ExchangeEnvironment, ExchangeVenue, ExitPlan,
    ExitReason, MarketTicker24h, OrderExecutionLog, OrderExecutionMethod,
    OrderHistoryStore, PairSelectionMode, PairSnapshot, PairSourceTag, PendingOrderSnapshot,
    Position, PositionSizingMode, ResolvedWatchlistEntry, Result, ScreenerSnapshotPayload, Side,
    TradingConfig, TrendingCategory, TrendingRankingSource, VolatilitySpikeAlert,
    WatchlistDwellState,
};
use bot_exchange::{CancelOrderOutcome, FailoverGateway, LiveOrderAck, LiveOrderRequest, WsStreamEvent};
use bot_indicators::IndicatorPipeline;
use bot_risk::{
    compute_expectancy_and_profit_factor, compute_kelly_fraction, compute_log_growth_rate,
    compute_stop_distance_notional, RiskManager,
};
use bot_strategy::{
    build_exit_plan_with_features, evaluate_entry_signal_with_options,
    evaluate_open_position_dynamic_action, evaluate_pending_order_dynamic_action,
    manage_position_tick_with_trail_override, OpenPositionDynamicAction, PendingCancelReason,
    PendingOrderDynamicAction, PendingOrderEvalCtx, PositionTickAction,
};
use chrono::{DateTime, Utc};
use git_sync::GitBackupSync;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};
use tracing::{info, warn};

pub type CommandReplyTx = oneshot::Sender<std::result::Result<serde_json::Value, String>>;

#[derive(Debug)]
pub enum EngineCommand {
    Pause {
        reply: Option<CommandReplyTx>,
    },
    Resume {
        reply: Option<CommandReplyTx>,
    },
    Shutdown,
    TripCircuitBreaker {
        reason: String,
        reply: Option<CommandReplyTx>,
    },
    ResetCircuitBreaker {
        reply: Option<CommandReplyTx>,
    },
    FlattenAll {
        reply: Option<CommandReplyTx>,
    },
    ClosePosition {
        symbol: String,
        reply: Option<CommandReplyTx>,
    },
    BackupNow {
        reply: Option<CommandReplyTx>,
    },
    ManualOrder {
        symbol: String,
        side: Side,
        notional_usdt: f64,
        order_method: OrderExecutionMethod,
        limit_price: Option<f64>,
        take_profit_price: Option<f64>,
        stop_loss_price: Option<f64>,
        reduce_only: bool,
        reply: Option<CommandReplyTx>,
    },
    UpdateWatchlist {
        pair_selection_mode: Option<PairSelectionMode>,
        pinned_pairs: Option<Vec<String>>,
        trending_category: Option<TrendingCategory>,
        quote_asset: Option<String>,
        max_watchlist_pairs: Option<usize>,
        trending_top_n: Option<usize>,
        reply: Option<CommandReplyTx>,
    },
}

#[derive(Debug, Clone, Default)]
struct OpenPositionMeta {
    order_list_id: Option<i64>,
    algo_order_ids: Vec<i64>,
    entry_fee_bps: f64,
}

#[derive(Debug, Clone)]
struct PendingOrderState {
    order_id: String,
    symbol: String,
    side: Side,
    order_method: OrderExecutionMethod,
    quantity: f64,
    limit_price: f64,
    take_profit_price: Option<f64>,
    stop_loss_price: Option<f64>,
    reduce_only: bool,
    atr: f64,
    exit_plan: ExitPlan,
    rationale: String,
    bar_idx: u64,
    is_live: bool,
    is_manual: bool,
    created_at: DateTime<Utc>,
}

const KNOWN_QUOTES: &[&str] = &[
    "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "TRY", "JPY", "BRL", "AUD", "GBP", "BNB", "ETH", "BTC",
];

fn extract_symbol_base_asset(symbol: &str) -> String {
    let upper = symbol.trim().to_uppercase();
    for q in KNOWN_QUOTES {
        if upper.len() > q.len() && upper.ends_with(q) {
            return upper[..upper.len() - q.len()].to_string();
        }
    }
    upper
}

fn reply_ok(reply: Option<CommandReplyTx>, val: serde_json::Value) {
    if let Some(tx) = reply {
        let _ = tx.send(Ok(val));
    }
}

fn reply_err(reply: Option<CommandReplyTx>, msg: impl Into<String>) {
    if let Some(tx) = reply {
        let _ = tx.send(Err(msg.into()));
    }
}

type BboQuoteMap = Arc<RwLock<HashMap<String, (f64, f64, f64)>>>;

pub struct TradingEngine {
    cfg: BotConfig,
    gateway: Arc<FailoverGateway>,
    order_store: Arc<OrderHistoryStore>,
    snapshot_tx: broadcast::Sender<EngineSnapshot>,
    latest_snapshot: Arc<RwLock<EngineSnapshot>>,
    screener_tx: broadcast::Sender<ScreenerSnapshotPayload>,
    latest_screener: Arc<RwLock<ScreenerSnapshotPayload>>,
    screener_cache: Arc<RwLock<HashMap<String, MarketTicker24h>>>,
    tradable_symbols: Arc<RwLock<HashSet<String>>>,
    active_watchlist: Arc<RwLock<Vec<ResolvedWatchlistEntry>>>,
    bbo_quotes: BboQuoteMap,
    pair_selection_mode: Arc<RwLock<PairSelectionMode>>,
    futures_hedge_mode: AtomicBool,
}

impl TradingEngine {
    pub fn new(cfg: BotConfig) -> Result<Self> {
        let initial_pairs = normalize_symbol_list(&cfg.trading.pairs, &[]);
        let gateway = Arc::new(FailoverGateway::new_with_toggles(
            cfg.exchange.clone(),
            initial_pairs.clone(),
            cfg.trading.timeframe.clone(),
            cfg.features.ws_primary_feed,
            cfg.features.rest_fallback,
        )?);
        let db_path = std::env::var("APEXRUST_ORDER_DB_PATH")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(test) {
                    std::env::temp_dir().join("apexrust-engine-unit-test.sqlite")
                } else {
                    Self::find_git_root().join(".apexrust-orders.sqlite")
                }
            });
        let order_store = Arc::new(OrderHistoryStore::new(db_path)?);
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
            pending_orders: Vec::new(),
            pair_selection_mode: cfg.trading.pair_selection_mode,
            recent_trades: Vec::new(),
            recent_volatility_alerts: Vec::new(),
            updated_at: Utc::now(),
        };
        let initial_screener = ScreenerSnapshotPayload {
            venue: cfg.exchange.venue,
            environment: match cfg.exchange.environment {
                ExchangeEnvironment::Production => "Production".into(),
                ExchangeEnvironment::Testnet => "Testnet".into(),
            },
            ranking_source_used: match cfg.trading.ranking_source {
                TrendingRankingSource::Environment => "environment".into(),
                _ => "production".into(),
            },
            stream_connected: false,
            total_tradable_symbols: 0,
            updated_at_ms: Utc::now().timestamp_millis(),
            rate_weight_used_1m: Some(0),
            tickers: Vec::new(),
        };
        let initial_wl: Vec<ResolvedWatchlistEntry> = initial_pairs
            .iter()
            .map(|sym| ResolvedWatchlistEntry {
                symbol: sym.clone(),
                source_tag: PairSourceTag::Pinned,
            })
            .collect();
        let (snapshot_tx, _) = broadcast::channel(64);
        let (screener_tx, _) = broadcast::channel(32);
        let pair_mode = cfg.trading.pair_selection_mode;
        Ok(Self {
            cfg,
            gateway,
            order_store,
            snapshot_tx,
            latest_snapshot: Arc::new(RwLock::new(initial)),
            screener_tx,
            latest_screener: Arc::new(RwLock::new(initial_screener)),
            screener_cache: Arc::new(RwLock::new(HashMap::new())),
            tradable_symbols: Arc::new(RwLock::new(HashSet::new())),
            active_watchlist: Arc::new(RwLock::new(initial_wl)),
            bbo_quotes: Arc::new(RwLock::new(HashMap::new())),
            pair_selection_mode: Arc::new(RwLock::new(pair_mode)),
            futures_hedge_mode: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> &BotConfig {
        &self.cfg
    }

    pub fn order_store(&self) -> &OrderHistoryStore {
        &self.order_store
    }

    pub fn subscribe_screener(&self) -> broadcast::Receiver<ScreenerSnapshotPayload> {
        self.screener_tx.subscribe()
    }

    pub fn latest_screener_handle(&self) -> Arc<RwLock<ScreenerSnapshotPayload>> {
        Arc::clone(&self.latest_screener)
    }

    pub async fn query_screener(
        &self,
        category: TrendingCategory,
        quote_asset: &str,
        min_quote_volume_usdt: f64,
        only_tradable: bool,
        limit: usize,
        search_query: Option<&str>,
    ) -> ScreenerSnapshotPayload {
        let tickers: Vec<MarketTicker24h> = self.screener_cache.read().await.values().cloned().collect();
        let tradable = self.tradable_symbols.read().await;
        let wl = self.active_watchlist.read().await;
        let tag_map: HashMap<&str, PairSourceTag> = wl
            .iter()
            .map(|e| (e.symbol.as_str(), e.source_tag))
            .collect();
        let mut enriched: Vec<MarketTicker24h> = tickers
            .into_iter()
            .map(|mut t| {
                t.tradable_on_active_env = tradable.is_empty() || tradable.contains(&t.symbol);
                t.source_tag = tag_map.get(t.symbol.as_str()).copied();
                t.in_watchlist = t.source_tag.is_some();
                t
            })
            .collect();
        enriched = rank_screener_tickers(
            &enriched,
            category,
            quote_asset,
            min_quote_volume_usdt,
            only_tradable,
            limit,
            search_query,
        );
        ScreenerSnapshotPayload {
            venue: self.cfg.exchange.venue,
            environment: match self.cfg.exchange.environment {
                ExchangeEnvironment::Production => "Production".into(),
                ExchangeEnvironment::Testnet => "Testnet".into(),
            },
            ranking_source_used: match self.cfg.trading.ranking_source {
                TrendingRankingSource::Environment => "environment".into(),
                _ => "production".into(),
            },
            stream_connected: self.gateway.is_screener_connected(),
            total_tradable_symbols: if tradable.is_empty() {
                enriched.len()
            } else {
                tradable.len()
            },
            updated_at_ms: Utc::now().timestamp_millis(),
            rate_weight_used_1m: Some(self.gateway.used_weight_1m()),
            tickers: enriched,
        }
    }

    fn position_side_str(&self, side: Side) -> &'static str {
        if self.cfg.exchange.venue == ExchangeVenue::Futures
            && self.futures_hedge_mode.load(Ordering::Relaxed)
        {
            match side {
                Side::Long => "LONG",
                Side::Short => "SHORT",
            }
        } else {
            "BOTH"
        }
    }

    async fn mark_pending_order_canceled_async(
        &self,
        symbol: &str,
        order_id: &str,
        rationale: &str,
    ) {
        let store = Arc::clone(&self.order_store);
        let sym = symbol.to_string();
        let oid = order_id.to_string();
        let reason = rationale.to_string();
        let venue = self.cfg.exchange.venue;
        let env_str = match self.cfg.exchange.environment {
            ExchangeEnvironment::Testnet => "Testnet".to_string(),
            ExchangeEnvironment::Production => "Production".to_string(),
        };
        let acct_mode = if self.cfg.exchange.paper_trading {
            "Paper".to_string()
        } else {
            "Live".to_string()
        };
        let now_ms = Utc::now().timestamp_millis();
        let _ = tokio::task::spawn_blocking(move || {
            if let Err(err) = store.mark_entry_canceled(
                &acct_mode,
                venue,
                &env_str,
                &sym,
                &oid,
                now_ms,
                &reason,
            ) {
                warn!(%err, "Failed to update pending ENTRY to CANCELED in SQLite");
            }
        })
        .await;
    }

    async fn persist_logs_async(&self, logs: Vec<OrderExecutionLog>) {
        if logs.is_empty() {
            return;
        }
        let store = Arc::clone(&self.order_store);
        let _ = tokio::task::spawn_blocking(move || {
            if let Err(err) = store.upsert_logs(&logs) {
                warn!(%err, "Failed to persist order log to SQLite");
            }
        })
        .await;
    }

    fn effective_fee_bps(&self, is_maker: bool) -> f64 {
        let taker_bps = self.cfg.trading.taker_fee_bps.max(0.0);
        if self.cfg.exchange.venue == ExchangeVenue::Futures {
            let futures_taker = if taker_bps > 0.0 { taker_bps * 0.4 } else { 4.0 };
            if is_maker {
                futures_taker * 0.5
            } else {
                futures_taker
            }
        } else if is_maker {
            taker_bps * 0.75
        } else {
            taker_bps
        }
    }

    pub async fn persist_trade_execution(
        &self,
        trade: &ClosedTrade,
        exit_fee_bps: f64,
        exchange_order_id: Option<&str>,
        algo_id: Option<i64>,
        endpoint: Option<&str>,
        is_maker_exit: bool,
    ) {
        let ts = trade.closed_at.timestamp_millis();
        let quote_qty = trade.exit_price * trade.quantity;
        // Single-side exit fee (entry fee was recorded on the ENTRY order log).
        let comm = quote_qty * (exit_fee_bps.max(0.0) / 10_000.0);
        let env_str = match self.cfg.exchange.environment {
            ExchangeEnvironment::Testnet => "Testnet",
            ExchangeEnvironment::Production => "Production",
        };
        let acct_mode = if self.cfg.exchange.paper_trading {
            "Paper"
        } else {
            "Live"
        };
        let binance_side = match trade.side {
            Side::Long => "SELL",
            Side::Short => "BUY",
        };
        let resolved_oid = exchange_order_id
            .filter(|s| !s.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| trade.id.clone());
        let resolved_endpoint = endpoint.map(ToOwned::to_owned).unwrap_or_else(|| {
            match self.cfg.exchange.venue {
                ExchangeVenue::Spot => "POST /api/v3/order".into(),
                ExchangeVenue::Futures => {
                    if algo_id.is_some() {
                        "POST /fapi/v1/algoOrder".into()
                    } else {
                        "POST /fapi/v1/order".into()
                    }
                }
            }
        });
        let log = OrderExecutionLog {
            id: format!("rust-exit-{}", trade.id),
            order_id: resolved_oid,
            client_order_id: format!("apex_rust_{}", trade.id),
            order_list_id: None,
            algo_id: algo_id.map(|id| id.to_string()),
            algo_order_ids: algo_id.map(|id| vec![id.to_string()]),
            symbol: trade.symbol.clone(),
            venue: self.cfg.exchange.venue,
            environment: env_str.into(),
            account_mode: acct_mode.into(),
            source: if self.cfg.exchange.paper_trading {
                "paper_engine".into()
            } else {
                "live_proxy".into()
            },
            lifecycle: "EXIT".into(),
            side: trade.side,
            binance_side: binance_side.into(),
            position_side: self.position_side_str(trade.side).into(),
            order_type: if is_maker_exit { "LIMIT_MAKER" } else { "MARKET" }.into(),
            orig_type: Some(if is_maker_exit { "LIMIT_MAKER" } else { "MARKET" }.into()),
            time_in_force: "GTC".into(),
            status: "FILLED".into(),
            price: trade.exit_price,
            avg_price: trade.exit_price,
            stop_price: 0.0,
            activate_price: None,
            price_rate: None,
            executed_qty: trade.quantity,
            orig_qty: trade.quantity,
            quote_qty,
            commission: comm,
            commission_asset: "USDT".into(),
            is_maker: is_maker_exit,
            reduce_only: self.cfg.exchange.venue == ExchangeVenue::Futures,
            close_position: false,
            price_protect: false,
            working_type: if self.cfg.exchange.venue == ExchangeVenue::Futures {
                Some("MARK_PRICE".into())
            } else {
                None
            },
            self_trade_prevention_mode: Some("NONE".into()),
            realized_pnl_usdt: Some(trade.pnl_usdt),
            r_multiple: Some(trade.r_multiple),
            exit_reason: Some(format!("{:?}", trade.reason)),
            latency_ms: Some(12),
            endpoint: resolved_endpoint,
            rationale: format!("Rust engine {:?} exit", trade.reason),
            error_message: None,
            order_time_ms: ts,
            update_time_ms: ts,
            working_time_ms: None,
            timestamp_ms: ts,
        };
        self.persist_logs_async(vec![log]).await;
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn persist_entry_execution(
        &self,
        pos: &Position,
        order_method: OrderExecutionMethod,
        ack: Option<&LiveOrderAck>,
        fee_bps: f64,
        rationale: &str,
        status_override: Option<&str>,
    ) {
        let ts = pos.opened_at.timestamp_millis();
        let status_str = status_override.unwrap_or("FILLED").to_string();
        let is_resting_new = status_str == "NEW";
        let exec_qty = if is_resting_new { 0.0 } else { pos.quantity };
        let quote_qty = pos.entry_price * exec_qty;
        let comm = quote_qty * (fee_bps.max(0.0) / 10_000.0);
        let env_str = match self.cfg.exchange.environment {
            ExchangeEnvironment::Testnet => "Testnet",
            ExchangeEnvironment::Production => "Production",
        };
        let acct_mode = if self.cfg.exchange.paper_trading {
            "Paper"
        } else {
            "Live"
        };
        let binance_side = match pos.side {
            Side::Long => "BUY",
            Side::Short => "SELL",
        };
        let order_type_str = match order_method {
            OrderExecutionMethod::Market => "MARKET",
            OrderExecutionMethod::Limit => "LIMIT",
            OrderExecutionMethod::LimitMaker => "LIMIT_MAKER",
            OrderExecutionMethod::Oco => "OCO",
        };
        let resolved_oid = ack
            .and_then(|a| a.order_id.as_deref())
            .filter(|s| !s.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| pos.id.clone());
        let list_id = ack.and_then(|a| a.order_list_id);
        let algo_order_ids = ack
            .filter(|a| !a.algo_order_ids.is_empty())
            .map(|a| a.algo_order_ids.clone());
        let algo_id = algo_order_ids.as_ref().and_then(|v| v.first().copied());
        let resolved_endpoint = match self.cfg.exchange.venue {
            ExchangeVenue::Spot => {
                if list_id.is_some() {
                    "POST /api/v3/order + /api/v3/orderList/oco".into()
                } else {
                    "POST /api/v3/order".into()
                }
            }
            ExchangeVenue::Futures => {
                if algo_id.is_some() {
                    "POST /fapi/v1/order + /fapi/v1/algoOrder".into()
                } else {
                    "POST /fapi/v1/order".into()
                }
            }
        };
        let resolved_tif = if order_method == OrderExecutionMethod::LimitMaker
            && self.cfg.exchange.venue == ExchangeVenue::Futures
        {
            "GTX".to_string()
        } else {
            self.cfg.automation.time_in_force.clone()
        };
        let log = OrderExecutionLog {
            id: format!("rust-entry-{}", pos.id),
            order_id: resolved_oid,
            client_order_id: format!("apex_rust_entry_{}", pos.id),
            order_list_id: list_id,
            algo_id: algo_id.map(|id| id.to_string()),
            algo_order_ids: algo_order_ids.map(|ids| ids.into_iter().map(|id| id.to_string()).collect()),
            symbol: pos.symbol.clone(),
            venue: self.cfg.exchange.venue,
            environment: env_str.into(),
            account_mode: acct_mode.into(),
            source: if self.cfg.exchange.paper_trading {
                "paper_engine".into()
            } else {
                "live_proxy".into()
            },
            lifecycle: "ENTRY".into(),
            side: pos.side,
            binance_side: binance_side.into(),
            position_side: self.position_side_str(pos.side).into(),
            order_type: order_type_str.into(),
            orig_type: Some(order_type_str.into()),
            time_in_force: resolved_tif,
            status: status_str,
            price: pos.entry_price,
            avg_price: if is_resting_new { 0.0 } else { pos.entry_price },
            stop_price: pos.exit_plan.initial_stop_loss,
            activate_price: None,
            price_rate: None,
            executed_qty: exec_qty,
            orig_qty: pos.quantity,
            quote_qty,
            commission: comm,
            commission_asset: "USDT".into(),
            is_maker: matches!(order_method, OrderExecutionMethod::LimitMaker),
            reduce_only: false,
            close_position: false,
            price_protect: self.cfg.exchange.venue == ExchangeVenue::Futures,
            working_type: if self.cfg.exchange.venue == ExchangeVenue::Futures {
                Some("MARK_PRICE".into())
            } else {
                None
            },
            self_trade_prevention_mode: Some("NONE".into()),
            realized_pnl_usdt: None,
            r_multiple: None,
            exit_reason: None,
            latency_ms: Some(12),
            endpoint: resolved_endpoint,
            rationale: rationale.to_string(),
            error_message: ack.and_then(|a| a.bracket_warning.clone()),
            order_time_ms: ts,
            update_time_ms: ts,
            working_time_ms: None,
            timestamp_ms: ts,
        };
        self.persist_logs_async(vec![log]).await;
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

    fn session_allows_entry(&self, now: DateTime<Utc>) -> bool {
        if !self.cfg.features.session_window_filter {
            return true;
        }
        self.cfg.automation.is_within_session_windows(now)
    }

    fn compute_portfolio_diversification_multiplier(
        candle_history: &HashMap<String, Vec<Candle>>,
        pairs: &[String],
    ) -> f64 {
        let n = pairs.len();
        if n <= 1 {
            return 1.0;
        }
        let returns_by_symbol: Vec<Vec<f64>> = pairs
            .iter()
            .map(|sym| {
                let Some(candles) = candle_history.get(sym) else {
                    return Vec::new();
                };
                let start = candles.len().saturating_sub(65);
                let slice = &candles[start..];
                let mut rets = Vec::with_capacity(slice.len().saturating_sub(1));
                for w in slice.windows(2) {
                    let prev = if w[0].close.abs() > 1e-12 { w[0].close } else { 1.0 };
                    rets.push((w[1].close - prev) / prev);
                }
                rets
            })
            .collect();

        let pearson = |a: &[f64], b: &[f64]| -> f64 {
            let len = a.len().min(b.len());
            if len < 3 {
                return 0.0;
            }
            let a_tail = &a[a.len() - len..];
            let b_tail = &b[b.len() - len..];
            let mean_a = a_tail.iter().sum::<f64>() / len as f64;
            let mean_b = b_tail.iter().sum::<f64>() / len as f64;
            let mut num = 0.0;
            let mut den_a = 0.0;
            let mut den_b = 0.0;
            for i in 0..len {
                let da = a_tail[i] - mean_a;
                let db = b_tail[i] - mean_b;
                num += da * db;
                den_a += da * da;
                den_b += db * db;
            }
            let denom = (den_a * den_b).sqrt();
            if denom > 1e-12 {
                (num / denom).clamp(-1.0, 1.0)
            } else {
                0.0
            }
        };

        let mut off_diag_sum = 0.0;
        let mut off_diag_count = 0usize;
        for i in 0..n {
            for j in (i + 1)..n {
                let corr = pearson(&returns_by_symbol[i], &returns_by_symbol[j]);
                off_diag_sum += corr.max(0.0);
                off_diag_count += 1;
            }
        }
        let avg_corr = if off_diag_count > 0 {
            off_diag_sum / off_diag_count as f64
        } else {
            0.5
        };
        let effective_concurrent = n.min(3) as f64;
        1.0 / (1.0 + ((effective_concurrent - 1.0) * avg_corr).max(0.0))
    }

    pub fn compute_position_quantity(
        &self,
        recent_trades: &[ClosedTrade],
        equity_usdt: f64,
        entry_price: f64,
        stop_loss_price: f64,
        risk_qty: f64,
    ) -> Option<f64> {
        self.compute_position_quantity_scaled(
            recent_trades,
            equity_usdt,
            entry_price,
            stop_loss_price,
            risk_qty,
            1.0,
        )
    }

    /// Compute quantitative position size (in base asset quantity) honoring
    /// `FixedUsdt`, `FixedRiskPct`, `QuarterKelly`, `HalfKelly`, and `FullKelly`,
    /// matching frontend `quantAnalytics.ts` (`rawFullKellyFraction` clamped `[0, 0.5]`
    /// before tier/diversification multiplier, buying-power leverage cap, `$10` min notional,
    /// and negative-expectancy Kelly block).
    pub fn compute_position_quantity_scaled(
        &self,
        recent_trades: &[ClosedTrade],
        equity_usdt: f64,
        entry_price: f64,
        stop_loss_price: f64,
        risk_qty: f64,
        diversification_multiplier: f64,
    ) -> Option<f64> {
        if entry_price <= 0.0 || !entry_price.is_finite() {
            return None;
        }
        let max_buying_power = match self.cfg.exchange.venue {
            ExchangeVenue::Futures => {
                equity_usdt.max(0.0) * f64::from(self.cfg.exchange.leverage.max(1)) * 0.95
            }
            ExchangeVenue::Spot => equity_usdt.max(0.0) * 0.98,
        };
        if max_buying_power < 10.0 {
            return None;
        }
        let div_mult = if diversification_multiplier.is_finite() && diversification_multiplier > 0.0
        {
            diversification_multiplier.clamp(0.1, 1.0)
        } else {
            1.0
        };

        let raw_notional = match self.cfg.trading.position_sizing_mode {
            PositionSizingMode::FixedUsdt => {
                if self.cfg.automation.auto_order_notional_usdt > 0.0 {
                    self.cfg.automation.auto_order_notional_usdt.max(10.0)
                } else {
                    (risk_qty * entry_price).max(10.0)
                }
            }
            PositionSizingMode::FixedRiskPct => risk_qty * entry_price,
            PositionSizingMode::QuarterKelly
            | PositionSizingMode::HalfKelly
            | PositionSizingMode::FullKelly => {
                // Exclude partial TP1 scale-outs so Kelly win-rate and payoff aren't double-counted.
                let closed_trades: Vec<&ClosedTrade> = recent_trades
                    .iter()
                    .filter(|t| !t.id.ends_with("-tp1"))
                    .collect();
                let (p, avg_win_r, avg_loss_r, gross_profit, gross_loss) =
                    if closed_trades.is_empty() {
                        (0.58, 1.8, 1.0, 180.0, 100.0)
                    } else {
                        let wins: Vec<&&ClosedTrade> =
                            closed_trades.iter().filter(|t| t.pnl_usdt > 0.0).collect();
                        let losses: Vec<&&ClosedTrade> =
                            closed_trades.iter().filter(|t| t.pnl_usdt <= 0.0).collect();
                        let p = wins.len() as f64 / closed_trades.len() as f64;
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
                let (exp_r, _pf) = compute_expectancy_and_profit_factor(
                    p,
                    avg_win_r,
                    avg_loss_r,
                    gross_profit,
                    gross_loss,
                );
                let payoff_b = if avg_loss_r > 1e-9 {
                    avg_win_r / avg_loss_r
                } else {
                    1.5
                };
                let raw_kelly = compute_kelly_fraction(p, payoff_b);
                let clamped_full = raw_kelly.clamp(0.0, 0.5);
                let tier_mult = match self.cfg.trading.position_sizing_mode {
                    PositionSizingMode::QuarterKelly => 0.25,
                    PositionSizingMode::HalfKelly => 0.50,
                    PositionSizingMode::FullKelly => 1.0,
                    _ => 0.50,
                };
                let tier_frac = clamped_full * tier_mult;
                let log_g = compute_log_growth_rate(p, payoff_b, tier_frac);
                if raw_kelly <= 0.0 || exp_r <= 0.0 || log_g <= 0.0 {
                    return None;
                }
                let scaled_frac = (tier_frac * div_mult).clamp(0.0, 0.5);
                compute_stop_distance_notional(
                    equity_usdt,
                    scaled_frac,
                    entry_price,
                    stop_loss_price,
                )
                .ok()?
            }
        };

        let capped = raw_notional.min(max_buying_power);
        if !capped.is_finite() || capped < 10.0 {
            return None;
        }
        Some(capped / entry_price)
    }

    fn find_git_root() -> PathBuf {
        if let Ok(mut cur) = std::env::current_dir() {
            for _ in 0..4 {
                if cur.join(".git").exists() {
                    return cur;
                }
                if !cur.pop() {
                    break;
                }
            }
        }
        PathBuf::from(".")
    }

    fn spawn_git_backup(&self, reason: &'static str) {
        let cfg = self.cfg.git_backup.clone();
        let repo_root = Self::find_git_root();
        tokio::task::spawn_blocking(move || {
            let sync = GitBackupSync::new(cfg);
            match sync.backup_snapshot(&repo_root, reason) {
                Ok(outcome) => info!(summary = %outcome.summary, "Git backup sync completed"),
                Err(err) => warn!(%err, "Git backup sync failed"),
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn publish_snapshot(
        &self,
        running: bool,
        risk: &RiskManager,
        last_prices: &HashMap<String, f64>,
        pipelines: &HashMap<String, IndicatorPipeline>,
        open_positions: &HashMap<String, Position>,
        pending_orders: &HashMap<String, PendingOrderState>,
        bar_index: &HashMap<String, u64>,
        recent_trades: &[ClosedTrade],
        recent_volatility_alerts: &[VolatilitySpikeAlert],
    ) {
        let gw_health = self.gateway.health().await;
        let eq_base = risk.status().starting_daily_equity.max(1.0);
        let wl = self.active_watchlist.read().await.clone();
        let tradable = self.tradable_symbols.read().await.clone();
        let screener = self.screener_cache.read().await;
        let bbo = self.bbo_quotes.read().await;
        let pair_mode = *self.pair_selection_mode.read().await;

        let mut sym_list: Vec<(String, Option<PairSourceTag>)> = if wl.is_empty() {
            self.cfg
                .trading
                .pairs
                .iter()
                .map(|s| (s.clone(), Some(PairSourceTag::Pinned)))
                .collect()
        } else {
            wl.iter().map(|e| (e.symbol.clone(), Some(e.source_tag))).collect()
        };
        for sym in open_positions.keys() {
            if !sym_list.iter().any(|(s, _)| s == sym) {
                sym_list.push((sym.clone(), Some(PairSourceTag::ProtectedPosition)));
            }
        }

        let pairs = sym_list
            .iter()
            .map(|(sym, src_tag)| {
                let p_pnl = risk.pair_daily_pnl(sym);
                let ind_snap = pipelines.get(sym).map(|p| p.snapshot()).unwrap_or_default();
                let bbo_opt = bbo.get(sym).copied();
                PairSnapshot {
                    symbol: sym.clone(),
                    last_price: last_prices.get(sym).copied().unwrap_or(0.0),
                    daily_pnl_usdt: p_pnl,
                    daily_pnl_pct: (p_pnl / eq_base) * 100.0,
                    indicators: ind_snap,
                    open_position: open_positions.get(sym).cloned(),
                    source_tag: *src_tag,
                    tradable_on_active_venue: Some(tradable.is_empty() || tradable.contains(sym)),
                    quote_volume_24h_usdt: screener.get(sym).map(|t| t.quote_volume),
                    best_bid: bbo_opt.map(|(b, _, _)| b),
                    best_ask: bbo_opt.map(|(_, a, _)| a),
                    spread_bps: bbo_opt.map(|(_, _, sp)| sp),
                    bars_warmed_up: Some(ind_snap.warmup_bars_count),
                }
            })
            .collect();

        let pending_snaps: Vec<PendingOrderSnapshot> = pending_orders
            .values()
            .map(|p| {
                let cur_bar = bar_index.get(&p.symbol).copied().unwrap_or(p.bar_idx);
                PendingOrderSnapshot {
                    order_id: p.order_id.clone(),
                    symbol: p.symbol.clone(),
                    side: p.side,
                    order_method: p.order_method,
                    quantity: p.quantity,
                    limit_price: p.limit_price,
                    is_live: p.is_live,
                    is_manual: p.is_manual,
                    created_bar_idx: p.bar_idx,
                    age_bars: cur_bar.saturating_sub(p.bar_idx),
                    rationale: p.rationale.clone(),
                    created_at: p.created_at,
                }
            })
            .collect();

        let snap = EngineSnapshot {
            running,
            venue: self.cfg.exchange.venue,
            transport_mode: gw_health.mode,
            failover_count: gw_health.failover_count,
            last_ws_age_ms: gw_health.last_ws_age_ms,
            risk: risk.status(),
            pairs,
            pending_orders: pending_snaps,
            pair_selection_mode: pair_mode,
            recent_trades: recent_trades.to_vec(),
            recent_volatility_alerts: recent_volatility_alerts.to_vec(),
            updated_at: Utc::now(),
        };
        *self.latest_snapshot.write().await = snap.clone();
        let _ = self.snapshot_tx.send(snap);
    }

    /// Before submitting a live exit on Binance, check whether exchange-native OCO/Algo brackets
    /// already closed the position on Binance so we never trigger `-2022 ReduceOnly rejected` or
    /// orphan opposite bracket orders. Returns `Some((fill_price, algo_id_opt))` if already flat on Binance.
    async fn detect_exchange_already_closed(
        &self,
        sym: &str,
        pos: &Position,
        meta: Option<&OpenPositionMeta>,
        fallback_px: f64,
    ) -> Option<(f64, Option<i64>)> {
        if !self.is_live_armed() {
            return None;
        }
        match self.cfg.exchange.venue {
            ExchangeVenue::Futures => {
                let positions = self.gateway.get_futures_positions(Some(sym)).await.ok()?;
                let still_open = positions.iter().any(|p| match pos.side {
                    Side::Long => p.position_amt > 1e-8,
                    Side::Short => p.position_amt < -1e-8,
                });
                if still_open {
                    return None;
                }
                let _ = self.gateway.cancel_open_brackets(sym, None).await;
                if let Some(m) = meta {
                    for &aid in &m.algo_order_ids {
                        if let Ok(st) = self.gateway.query_futures_algo_order_status(aid).await {
                            if (st.status == "TRIGGERED" || st.status == "FILLED" || st.status == "FINISHED")
                                && st.avg_price > 0.0
                            {
                                return Some((st.avg_price, Some(aid)));
                            }
                        }
                    }
                }
                Some((fallback_px, None))
            }
            ExchangeVenue::Spot => {
                if let Some(m) = meta {
                    if m.order_list_id.is_some() {
                        if let Ok(open) = self.gateway.get_spot_open_orders(Some(sym)).await {
                            if !open.is_empty() {
                                return None;
                            }
                            let base = extract_symbol_base_asset(sym);
                            if let Ok(free_qty) = self.gateway.get_spot_free_balance(&base).await {
                                if free_qty < pos.remaining_quantity * 0.5 {
                                    return Some((fallback_px, None));
                                }
                            }
                        }
                    }
                }
                None
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn warmup_symbol_bars(
        &self,
        pair: &str,
        limit: usize,
        timeframe: &str,
        pipelines: &mut HashMap<String, IndicatorPipeline>,
        candle_history: &mut HashMap<String, Vec<Candle>>,
        atr_history: &mut HashMap<String, Vec<f64>>,
        prev_closes: &mut HashMap<String, f64>,
        bar_index: &mut HashMap<String, u64>,
        last_closed_bar_ms: &mut HashMap<String, i64>,
        last_prices: &mut HashMap<String, f64>,
    ) {
        let mut pipe = pipelines
            .remove(pair)
            .unwrap_or_else(|| IndicatorPipeline::new(&self.cfg.indicators));
        let mut hist = candle_history.remove(pair).unwrap_or_default();
        let mut a_hist = atr_history.remove(pair).unwrap_or_default();
        let mut bars_seen = bar_index.get(pair).copied().unwrap_or(0);
        match self.gateway.fetch_klines(pair, timeframe, limit).await {
            Ok(candles) => {
                for c in &candles {
                    if !c.is_closed {
                        continue;
                    }
                    if last_closed_bar_ms
                        .get(pair)
                        .is_some_and(|&prev| c.open_time_ms <= prev)
                    {
                        continue;
                    }
                    last_closed_bar_ms.insert(pair.to_string(), c.open_time_ms);
                    let snap = pipe.update_with_gap(c, false);
                    if let Some(a) = snap.atr {
                        a_hist.push(a);
                        if a_hist.len() > 16 {
                            a_hist.remove(0);
                        }
                    }
                    prev_closes.insert(pair.to_string(), c.close);
                    last_prices.insert(pair.to_string(), c.close);
                    hist.push(*c);
                    if hist.len() > 70 {
                        hist.remove(0);
                    }
                    bars_seen += 1;
                }
                info!(%pair, bars = bars_seen, "Warmed up indicator pipeline");
            }
            Err(err) => {
                warn!(%pair, %err, "Failed to warm up historical klines");
            }
        }
        bar_index.insert(pair.to_string(), bars_seen);
        candle_history.insert(pair.to_string(), hist);
        atr_history.insert(pair.to_string(), a_hist);
        pipelines.insert(pair.to_string(), pipe);
    }

    #[allow(clippy::too_many_arguments)]
    async fn recompute_and_sync_watchlist(
        &self,
        trading_cfg: &TradingConfig,
        pinned_pairs: &[String],
        open_positions: &HashMap<String, Position>,
        pending_orders: &HashMap<String, PendingOrderState>,
        dwell_state: &mut WatchlistDwellState,
        pipelines: &mut HashMap<String, IndicatorPipeline>,
        candle_history: &mut HashMap<String, Vec<Candle>>,
        atr_history: &mut HashMap<String, Vec<f64>>,
        prev_closes: &mut HashMap<String, f64>,
        bar_index: &mut HashMap<String, u64>,
        last_closed_bar_ms: &mut HashMap<String, i64>,
        last_prices: &mut HashMap<String, f64>,
    ) {
        if let Ok(trad) = self.gateway.fetch_tradable_symbols().await {
            if !trad.is_empty() {
                *self.tradable_symbols.write().await = trad;
            }
        }
        let trad_guard = self.tradable_symbols.read().await;
        let trad_opt = (!trad_guard.is_empty()).then_some(&*trad_guard);

        let tickers: Vec<MarketTicker24h> = self.screener_cache.read().await.values().cloned().collect();
        let cur_trending: Vec<String> = self
            .active_watchlist
            .read()
            .await
            .iter()
            .filter(|e| e.source_tag == PairSourceTag::Trending)
            .map(|e| e.symbol.clone())
            .collect();
        let protected: HashSet<String> = open_positions
            .keys()
            .chain(pending_orders.keys())
            .cloned()
            .collect();

        let next_wl = resolve_effective_watchlist(
            trading_cfg.pair_selection_mode,
            pinned_pairs,
            &tickers,
            &protected,
            &cur_trending,
            Some(dwell_state),
            trad_opt,
            trading_cfg,
            Utc::now().timestamp_millis(),
        );
        drop(trad_guard);

        let next_syms: Vec<String> = next_wl.iter().map(|e| e.symbol.clone()).collect();
        let prev_syms: Vec<String> = self
            .active_watchlist
            .read()
            .await
            .iter()
            .map(|e| e.symbol.clone())
            .collect();

        if next_wl != *self.active_watchlist.read().await {
            *self.active_watchlist.write().await = next_wl;
        }
        if next_syms != prev_syms {
            self.gateway.update_watchlist(next_syms.clone()).await;
        }

        for sym in &next_syms {
            if !pipelines.contains_key(sym) {
                self.warmup_symbol_bars(
                    sym,
                    220,
                    &trading_cfg.timeframe,
                    pipelines,
                    candle_history,
                    atr_history,
                    prev_closes,
                    bar_index,
                    last_closed_bar_ms,
                    last_prices,
                )
                .await;
                if next_syms.len() > 2 {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                }
            }
        }
    }

    pub async fn run(self: Arc<Self>, mut cmd_rx: mpsc::Receiver<EngineCommand>) -> Result<()> {
        let mut trading_cfg = self.cfg.trading.clone();
        let mut pinned_pairs = normalize_symbol_list(&trading_cfg.pairs, &[]);
        let mut dwell_state = WatchlistDwellState::default();
        let mut trailing_tighten_factor: HashMap<String, f64> = HashMap::new();
        let mut reversal_bypass_cooldown: HashMap<String, Side> = HashMap::new();

        if self.is_live_armed() && self.cfg.exchange.venue == ExchangeVenue::Futures {
            let hedge = self.gateway.is_futures_hedge_mode().await;
            self.futures_hedge_mode.store(hedge, Ordering::Relaxed);
        }

        let mut pipelines: HashMap<String, IndicatorPipeline> = HashMap::new();
        let mut candle_history: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut atr_history: HashMap<String, Vec<f64>> = HashMap::new();
        let mut prev_closes: HashMap<String, f64> = HashMap::new();
        let mut bar_index: HashMap<String, u64> = HashMap::new();
        let mut last_closed_bar_ms: HashMap<String, i64> = HashMap::new();
        let mut last_entry_bar: HashMap<String, u64> = HashMap::new();
        let mut last_prices: HashMap<String, f64> = HashMap::new();
        let mut open_positions: HashMap<String, Position> = HashMap::new();
        let mut open_meta: HashMap<String, OpenPositionMeta> = HashMap::new();
        let mut pending_orders: HashMap<String, PendingOrderState> = HashMap::new();
        let mut recent_trades: Vec<ClosedTrade> = Vec::new();
        let mut recent_volatility_alerts: Vec<VolatilitySpikeAlert> = Vec::new();
        let mut last_vol_alert_ms: HashMap<String, i64> = HashMap::new();
        let mut risk = RiskManager::new(self.cfg.risk.clone(), trading_cfg.clone(), Utc::now());
        let mut running = true;

        // 0. Seed tradability table + initial 24h market tickers for hybrid/dynamic resolution
        if !matches!(trading_cfg.pair_selection_mode, PairSelectionMode::Static) {
            let prod_rank = matches!(
                trading_cfg.ranking_source,
                TrendingRankingSource::Auto | TrendingRankingSource::Production
            );
            if let Ok(seed) = self.gateway.fetch_ticker_24h_seed_once(prod_rank).await {
                let mut sc = self.screener_cache.write().await;
                for t in seed {
                    sc.insert(t.symbol.clone(), t);
                }
            }
        }

        // 1. Resolve initial watchlist & staggered 220-bar warmup via REST API
        self.recompute_and_sync_watchlist(
            &trading_cfg,
            &pinned_pairs,
            &open_positions,
            &pending_orders,
            &mut dwell_state,
            &mut pipelines,
            &mut candle_history,
            &mut atr_history,
            &mut prev_closes,
            &mut bar_index,
            &mut last_closed_bar_ms,
            &mut last_prices,
        )
        .await;

        // 2. Spawn reactive combined WebSocket + !miniTicker@arr screener + REST fallback feed
        let (mkt_tx, mut mkt_rx) = mpsc::channel::<WsStreamEvent>(1024);
        Arc::clone(&self.gateway).spawn_with_events(mkt_tx, trading_cfg.ranking_source);

        let mut reconcile_tick = tokio::time::interval(Duration::from_secs(3));
        reconcile_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut watchlist_tick = tokio::time::interval(Duration::from_secs(30));
        watchlist_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        self.publish_snapshot(
            running,
            &risk,
            &last_prices,
            &pipelines,
            &open_positions,
            &pending_orders,
            &bar_index,
            &recent_trades,
            &recent_volatility_alerts,
        )
        .await;

        // 3. Single-writer event loop
        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    match cmd {
                        EngineCommand::Pause { reply } => {
                            running = false;
                            reply_ok(reply, serde_json::json!({ "accepted": true, "running": false }));
                        }
                        EngineCommand::Resume { reply } => {
                            running = true;
                            reply_ok(reply, serde_json::json!({ "accepted": true, "running": true }));
                        }
                        EngineCommand::Shutdown => {
                            running = false;
                            self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                            break;
                        }
                        EngineCommand::TripCircuitBreaker { reason, reply } => {
                            if !self.cfg.features.circuit_breaker {
                                warn!("TripCircuitBreaker ignored because circuit_breaker is disabled in FeatureToggles");
                                reply_err(reply, "Circuit Breaker is disabled in FeatureToggles");
                                continue;
                            }
                            risk.trip_circuit_breaker(reason);
                            if self.cfg.risk.flatten_on_circuit_breaker {
                                self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                            }
                            reply_ok(reply, serde_json::json!({ "accepted": true, "state": "Halted" }));
                        }
                        EngineCommand::ResetCircuitBreaker { reply } => {
                            if !self.cfg.features.circuit_breaker {
                                warn!("ResetCircuitBreaker ignored because circuit_breaker is disabled in FeatureToggles");
                                reply_err(reply, "Circuit Breaker is disabled in FeatureToggles");
                                continue;
                            }
                            risk.reset_circuit_breaker();
                            reply_ok(reply, serde_json::json!({ "accepted": true, "state": "Active" }));
                        }
                        EngineCommand::FlattenAll { reply } => {
                            let closed = self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                            reply_ok(reply, serde_json::json!({ "accepted": true, "closed": closed }));
                        }
                        EngineCommand::ClosePosition { symbol, reply } => {
                            let sym = symbol.trim().to_uppercase();
                            let Some(pos) = open_positions.remove(&sym) else {
                                if let Some(pend) = pending_orders.remove(&sym) {
                                    if self.is_live_armed() && pend.is_live {
                                        if let Ok(oid_num) = pend.order_id.parse::<i64>() {
                                            match self.gateway.cancel_single_order(&sym, oid_num).await {
                                                Ok(CancelOrderOutcome::AlreadyFilled(st)) => {
                                                    let now = Utc::now();
                                                    let fill_px = if st.avg_price > 0.0 { st.avg_price } else { pend.limit_price };
                                                    let exec_qty = if st.executed_qty > 0.0 { st.executed_qty } else { pend.quantity };
                                                    let plan = if pend.stop_loss_price.is_some() || pend.take_profit_price.is_some() {
                                                        pend.exit_plan.clone()
                                                    } else {
                                                        build_exit_plan_with_features(pend.side, fill_px, pend.atr, &self.cfg.exits, &self.cfg.features)
                                                    };
                                                    let entry_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                                                    let promoted = Position {
                                                        id: format!("{sym}-{}", now.timestamp_millis()),
                                                        symbol: sym.clone(),
                                                        side: pend.side,
                                                        entry_price: fill_px,
                                                        quantity: exec_qty,
                                                        remaining_quantity: exec_qty,
                                                        unrealized_pnl_usdt: 0.0,
                                                        realized_pnl_usdt: 0.0,
                                                        highest_favorable_price: fill_px,
                                                        exit_plan: plan,
                                                        opened_at: now,
                                                    };
                                                    let ack = LiveOrderAck {
                                                        order_id: Some(pend.order_id.clone()),
                                                        status: st.status.clone(),
                                                        filled: true,
                                                        executed_qty: exec_qty,
                                                        avg_price: fill_px,
                                                        ..Default::default()
                                                    };
                                                    self.persist_entry_execution(&promoted, pend.order_method, Some(&ack), entry_fee_bps, &pend.rationale, Some("FILLED")).await;
                                                    open_meta.insert(sym.clone(), OpenPositionMeta {
                                                        order_list_id: None,
                                                        algo_order_ids: Vec::new(),
                                                        entry_fee_bps,
                                                    });
                                                    open_positions.insert(sym.clone(), promoted);
                                                    reply_ok(reply, serde_json::json!({ "accepted": true, "promotedFilledPending": sym, "avgPrice": fill_px, "executedQty": exec_qty }));
                                                    self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                                                    continue;
                                                }
                                                Ok(CancelOrderOutcome::Canceled) => {}
                                                Err(err) => {
                                                    pending_orders.insert(sym.clone(), pend);
                                                    reply_err(reply, format!("Live pending cancel failed for {sym}: {err}"));
                                                    continue;
                                                }
                                            }
                                        } else {
                                            let _ = self.gateway.cancel_open_orders(&sym).await;
                                        }
                                    }
                                    self.mark_pending_order_canceled_async(&sym, &pend.order_id, "Manual ClosePosition canceled pending limit").await;
                                    reply_ok(reply, serde_json::json!({ "accepted": true, "canceledPending": sym }));
                                    self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                                    continue;
                                }
                                reply_err(reply, format!("No open position or pending order for {sym}"));
                                continue;
                            };
                            trailing_tighten_factor.remove(&sym);
                            let meta = open_meta.remove(&sym);
                            let mut px = last_prices.get(&sym).copied().unwrap_or(pos.entry_price);
                            let qty = pos.remaining_quantity;
                            let mut close_oid: Option<String> = None;
                            let mut close_aid: Option<i64> = None;
                            if self.is_live_armed() {
                                if let Some((reconciled_px, aid)) = self.detect_exchange_already_closed(&sym, &pos, meta.as_ref(), px).await {
                                    px = reconciled_px;
                                    close_aid = aid;
                                } else {
                                    let _ = self.gateway.cancel_open_brackets(&sym, meta.as_ref().and_then(|m| m.order_list_id)).await;
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
                                    match self.gateway.execute_live_order(&req).await {
                                        Ok(ack) => {
                                            if ack.avg_price > 0.0 { px = ack.avg_price; }
                                            close_oid = ack.order_id;
                                        }
                                        Err(err) => {
                                            if let Some(m) = meta { open_meta.insert(sym.clone(), m); }
                                            open_positions.insert(sym, pos);
                                            reply_err(reply, format!("Live manual close failed: {err}"));
                                            continue;
                                        }
                                    }
                                }
                            }
                            let entry_fee_bps = meta.as_ref().map(|m| m.entry_fee_bps).unwrap_or_else(|| self.effective_fee_bps(false));
                            let exit_fee_bps = self.effective_fee_bps(false);
                            let pnl = Self::calc_net_pnl_with_fees(pos.side, pos.entry_price, px, qty, entry_fee_bps, exit_fee_bps);
                            let r_mult = pnl / (pos.exit_plan.risk_distance_r * qty).max(1e-9);
                            let now = Utc::now();
                            risk.record_realized_pnl(&sym, pnl, now);
                            let closed_trade = ClosedTrade {
                                id: pos.id,
                                symbol: sym,
                                side: pos.side,
                                entry_price: pos.entry_price,
                                exit_price: px,
                                quantity: qty,
                                pnl_usdt: pnl,
                                r_multiple: r_mult,
                                reason: ExitReason::ManualClose,
                                closed_at: now,
                            };
                            self.persist_trade_execution(&closed_trade, exit_fee_bps, close_oid.as_deref(), close_aid, None, false).await;
                            recent_trades.insert(0, closed_trade.clone());
                            recent_trades.truncate(100);
                            reply_ok(reply, serde_json::json!({ "accepted": true, "trade": closed_trade }));
                        }
                        EngineCommand::BackupNow { reply } => {
                            self.spawn_git_backup("chore(backup): manual desktop snapshot");
                            reply_ok(reply, serde_json::json!({ "accepted": true }));
                        }
                        EngineCommand::ManualOrder {
                            symbol,
                            side,
                            notional_usdt,
                            order_method,
                            limit_price,
                            take_profit_price,
                            stop_loss_price,
                            reduce_only,
                            reply,
                        } => {
                            let symbol = symbol.trim().to_uppercase();
                            if !self.cfg.features.manual_trading || !self.venue_enabled() {
                                warn!(%symbol, "Manual order blocked by FeatureToggles");
                                reply_err(reply, "Manual Trading or selected market venue is disabled in FeatureToggles");
                                continue;
                            }
                            if self.cfg.exchange.venue == ExchangeVenue::Spot && side == Side::Short && !reduce_only {
                                warn!(%symbol, "Manual short order rejected on Binance Spot");
                                reply_err(reply, "Binance Spot cannot open Short positions");
                                continue;
                            }
                            if !reduce_only && (open_positions.contains_key(&symbol) || pending_orders.contains_key(&symbol)) {
                                warn!(%symbol, "Manual order rejected: position or pending order already active");
                                reply_err(reply, format!("{symbol} already has an active position or pending order"));
                                continue;
                            }
                            if !reduce_only
                                && (open_positions.len() + pending_orders.len())
                                    >= self.cfg.trading.max_concurrent_positions
                            {
                                warn!(%symbol, "Manual order rejected: max concurrent positions reached");
                                reply_err(reply, "Max concurrent positions reached");
                                continue;
                            }
                            let mut market_px = last_prices
                                .get(&symbol)
                                .copied()
                                .filter(|&p| p > 0.0)
                                .unwrap_or(0.0);
                            if market_px <= 0.0 {
                                if let Ok(px) = self.gateway.fetch_ticker_price(&symbol).await {
                                    market_px = px;
                                    last_prices.insert(symbol.clone(), px);
                                }
                            }
                            let lim_px_opt = limit_price.filter(|&p| p.is_finite() && p > 0.0);
                            let ref_px = if market_px > 0.0 {
                                market_px
                            } else {
                                lim_px_opt.unwrap_or(0.0)
                            };
                            if ref_px <= 0.0 || !notional_usdt.is_finite() || notional_usdt <= 0.0 {
                                warn!(%symbol, "Manual order rejected: invalid price or notional");
                                reply_err(reply, format!("Invalid reference price or notional for {symbol}"));
                                continue;
                            }
                            if reduce_only {
                                let Some(existing_ref) = open_positions.get(&symbol).cloned() else {
                                    reply_err(reply, format!("No open position to reduce for {symbol}"));
                                    continue;
                                };
                                if self.cfg.exchange.venue == ExchangeVenue::Spot && existing_ref.side != Side::Long {
                                    reply_err(reply, format!("Unsupported Spot reduce-only close on {symbol}"));
                                    continue;
                                }
                            }
                            let entry_ref_px = lim_px_opt.unwrap_or(ref_px);
                            let atr = pipelines.get(&symbol).and_then(|p| p.snapshot().atr).unwrap_or(entry_ref_px * 0.01);
                            let mut plan = build_exit_plan_with_features(side, entry_ref_px, atr, &self.cfg.exits, &self.cfg.features);
                            if let Some(sl) = stop_loss_price.filter(|&p| p.is_finite() && p > 0.0) {
                                plan.initial_stop_loss = sl;
                                plan.active_stop_loss = sl;
                                plan.risk_distance_r = (entry_ref_px - sl).abs().max(entry_ref_px * 0.002);
                            }
                            if let Some(tp) = take_profit_price.filter(|&p| p.is_finite() && p > 0.0) {
                                plan.take_profit_2 = tp;
                            }
                            let active_slots = open_positions.len() + pending_orders.len();
                            let auth_ok = if reduce_only {
                                Ok(notional_usdt / entry_ref_px)
                            } else if self.cfg.features.circuit_breaker {
                                risk.authorize_entry(&symbol, entry_ref_px, plan.initial_stop_loss, active_slots, Utc::now())
                            } else {
                                Ok(notional_usdt / entry_ref_px)
                            };
                            match auth_ok {
                                Err(err) => {
                                    reply_err(reply, err.to_string());
                                    continue;
                                }
                                Ok(_) => {
                                    let is_limit = matches!(order_method, OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker);
                                    let qty = if reduce_only {
                                        let max_rem = open_positions
                                            .get(&symbol)
                                            .map(|p| p.remaining_quantity)
                                            .unwrap_or(0.0);
                                        (notional_usdt / entry_ref_px).min(max_rem)
                                    } else {
                                        notional_usdt / entry_ref_px
                                    };
                                    let effective_order_side = if reduce_only {
                                        open_positions.get(&symbol).map(|p| p.side).unwrap_or(side)
                                    } else {
                                        side
                                    };
                                    if self.is_live_armed() {
                                        if reduce_only {
                                            if let Some(existing_meta) = open_meta.get(&symbol).cloned() {
                                                let will_fully_close = open_positions
                                                    .get(&symbol)
                                                    .is_some_and(|p| (p.remaining_quantity - qty) <= 1e-10);
                                                if will_fully_close {
                                                    let _ = self
                                                        .gateway
                                                        .cancel_open_brackets(&symbol, existing_meta.order_list_id)
                                                        .await;
                                                }
                                            }
                                        }
                                        let req = LiveOrderRequest {
                                            symbol: symbol.clone(),
                                            side: effective_order_side,
                                            order_method,
                                            quantity: qty,
                                            quote_order_qty: if !is_limit && !reduce_only { Some(notional_usdt) } else { None },
                                            limit_price: lim_px_opt,
                                            take_profit_price: if reduce_only {
                                                None
                                            } else {
                                                take_profit_price.or_else(|| {
                                                    if self.cfg.features.take_profit_ladder {
                                                        Some(plan.take_profit_2)
                                                    } else {
                                                        None
                                                    }
                                                })
                                            },
                                            stop_loss_price: if reduce_only {
                                                None
                                            } else {
                                                stop_loss_price.or(Some(plan.initial_stop_loss))
                                            },
                                            time_in_force: self.cfg.automation.time_in_force.clone(),
                                            reduce_only,
                                        };
                                        match self.gateway.execute_live_order(&req).await {
                                            Ok(ack) => {
                                                let now = Utc::now();
                                                let is_maker_method = order_method == OrderExecutionMethod::LimitMaker;
                                                let entry_fee_bps = self.effective_fee_bps(is_maker_method);
                                                let status_upper = ack.status.to_uppercase();
                                                let is_terminal_unfilled = matches!(
                                                    status_upper.as_str(),
                                                    "EXPIRED" | "EXPIRED_IN_MATCH" | "CANCELED" | "CANCELLED" | "REJECTED"
                                                ) && ack.executed_qty <= 0.0;
                                                if is_terminal_unfilled {
                                                    warn!(%symbol, status = %status_upper, "Live manual order ended terminal unfilled");
                                                    reply_err(
                                                        reply,
                                                        format!("Live manual order on {symbol} ended {status_upper} with 0 fill"),
                                                    );
                                                } else if !ack.filled && ack.executed_qty <= 0.0 {
                                                    let pend_px = lim_px_opt.unwrap_or(ref_px);
                                                    let oid = ack.order_id.clone().unwrap_or_else(|| format!("pend-{}-{}", symbol, now.timestamp_millis()));
                                                    let pend_pos = Position {
                                                        id: oid.clone(),
                                                        symbol: symbol.clone(),
                                                        side: effective_order_side,
                                                        entry_price: pend_px,
                                                        quantity: qty,
                                                        remaining_quantity: qty,
                                                        unrealized_pnl_usdt: 0.0,
                                                        realized_pnl_usdt: 0.0,
                                                        highest_favorable_price: pend_px,
                                                        exit_plan: plan.clone(),
                                                        opened_at: now,
                                                    };
                                                    self.persist_entry_execution(&pend_pos, order_method, Some(&ack), entry_fee_bps, "Manual limit order resting", Some("NEW")).await;
                                                    pending_orders.insert(symbol.clone(), PendingOrderState {
                                                        order_id: oid.clone(),
                                                        symbol: symbol.clone(),
                                                        side: effective_order_side,
                                                        order_method,
                                                        quantity: qty,
                                                        limit_price: pend_px,
                                                        take_profit_price: req.take_profit_price,
                                                        stop_loss_price: req.stop_loss_price,
                                                        reduce_only,
                                                        atr,
                                                        exit_plan: plan,
                                                        rationale: if reduce_only { "Manual reduce-only limit order".into() } else { "Manual limit order".into() },
                                                        bar_idx: bar_index.get(&symbol).copied().unwrap_or(0),
                                                        is_live: true,
                                                        is_manual: true,
                                                        created_at: now,
                                                    });
                                                    reply_ok(reply, serde_json::json!({ "accepted": true, "status": "NEW", "orderId": oid }));
                                                } else {
                                                    let actual_entry = if ack.avg_price > 0.0 { ack.avg_price } else { entry_ref_px };
                                                    let actual_qty = if ack.executed_qty > 0.0 { ack.executed_qty } else { qty };
                                                    if reduce_only {
                                                        if let Some(mut existing) = open_positions.remove(&symbol) {
                                                            let close_qty = actual_qty.min(existing.remaining_quantity);
                                                            let orig_entry_fee_bps = open_meta
                                                                .get(&symbol)
                                                                .map(|m| m.entry_fee_bps)
                                                                .unwrap_or_else(|| self.effective_fee_bps(false));
                                                            let exit_fee_bps = self.effective_fee_bps(is_maker_method);
                                                            let pnl = Self::calc_net_pnl_with_fees(
                                                                existing.side,
                                                                existing.entry_price,
                                                                actual_entry,
                                                                close_qty,
                                                                orig_entry_fee_bps,
                                                                exit_fee_bps,
                                                            );
                                                            let r_mult = pnl / (existing.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                                            risk.record_realized_pnl(&symbol, pnl, now);
                                                            existing.remaining_quantity = (existing.remaining_quantity - close_qty).max(0.0);
                                                            existing.realized_pnl_usdt += pnl;
                                                            let closed_trade = ClosedTrade {
                                                                id: format!("{}-reduce-{}", existing.id, now.timestamp_millis()),
                                                                symbol: symbol.clone(),
                                                                side: existing.side,
                                                                entry_price: existing.entry_price,
                                                                exit_price: actual_entry,
                                                                quantity: close_qty,
                                                                pnl_usdt: pnl,
                                                                r_multiple: r_mult,
                                                                reason: ExitReason::ManualClose,
                                                                closed_at: now,
                                                            };
                                                            let is_partial = existing.remaining_quantity > 1e-10;
                                                            if is_partial {
                                                                open_positions.insert(symbol.clone(), existing);
                                                            } else {
                                                                open_meta.remove(&symbol);
                                                                trailing_tighten_factor.remove(&symbol);
                                                            }
                                                            self.persist_trade_execution(
                                                                &closed_trade,
                                                                exit_fee_bps,
                                                                ack.order_id.as_deref(),
                                                                None,
                                                                None,
                                                                is_maker_method,
                                                            )
                                                            .await;
                                                            recent_trades.insert(0, closed_trade);
                                                            recent_trades.truncate(100);
                                                            if self.cfg.features.circuit_breaker
                                                                && self.cfg.risk.flatten_on_circuit_breaker
                                                                && risk.status().state == CircuitBreakerState::Halted
                                                            {
                                                                self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                                                            }
                                                        }
                                                    } else {
                                                        if stop_loss_price.is_none() && take_profit_price.is_none() {
                                                            plan = build_exit_plan_with_features(side, actual_entry, atr, &self.cfg.exits, &self.cfg.features);
                                                        }
                                                        let pos = Position {
                                                            id: format!("{}-manual-{}", symbol, now.timestamp_millis()),
                                                            symbol: symbol.clone(),
                                                            side,
                                                            entry_price: actual_entry,
                                                            quantity: actual_qty,
                                                            remaining_quantity: actual_qty,
                                                            unrealized_pnl_usdt: 0.0,
                                                            realized_pnl_usdt: 0.0,
                                                            highest_favorable_price: actual_entry,
                                                            exit_plan: plan,
                                                            opened_at: now,
                                                        };
                                                        self.persist_entry_execution(&pos, order_method, Some(&ack), entry_fee_bps, "Manual order entry", None).await;
                                                        open_meta.insert(symbol.clone(), OpenPositionMeta {
                                                            order_list_id: ack.order_list_id,
                                                            algo_order_ids: ack.algo_order_ids.clone(),
                                                            entry_fee_bps,
                                                        });
                                                        open_positions.insert(symbol.clone(), pos);
                                                    }
                                                    reply_ok(reply, serde_json::json!({ "accepted": true, "status": ack.status, "reduceOnly": reduce_only, "orderId": ack.order_id, "avgPrice": actual_entry, "executedQty": actual_qty }));
                                                }
                                            }
                                            Err(err) => {
                                                warn!(%symbol, %err, "Live manual order failed");
                                                reply_err(reply, err.to_string());
                                                continue;
                                            }
                                        }
                                    } else {
                                        let now = Utc::now();
                                        let lim_px = lim_px_opt.unwrap_or(ref_px);
                                        if reduce_only {
                                            let Some(mut existing) = open_positions.remove(&symbol) else {
                                                reply_err(reply, format!("No open paper position to reduce for {symbol}"));
                                                continue;
                                            };
                                            let exit_px = if is_limit { lim_px } else { ref_px };
                                            let close_qty = qty.min(existing.remaining_quantity);
                                            let entry_fee_bps = open_meta
                                                .get(&symbol)
                                                .map(|m| m.entry_fee_bps)
                                                .unwrap_or_else(|| self.effective_fee_bps(false));
                                            let is_maker_exit = order_method == OrderExecutionMethod::LimitMaker;
                                            let exit_fee_bps = self.effective_fee_bps(is_maker_exit);
                                            let pnl = Self::calc_net_pnl_with_fees(
                                                existing.side,
                                                existing.entry_price,
                                                exit_px,
                                                close_qty,
                                                entry_fee_bps,
                                                exit_fee_bps,
                                            );
                                            let r_mult = pnl / (existing.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                            risk.record_realized_pnl(&symbol, pnl, now);
                                            existing.remaining_quantity = (existing.remaining_quantity - close_qty).max(0.0);
                                            existing.realized_pnl_usdt += pnl;
                                            let closed_trade = ClosedTrade {
                                                id: format!("{}-reduce-{}", existing.id, now.timestamp_millis()),
                                                symbol: symbol.clone(),
                                                side: existing.side,
                                                entry_price: existing.entry_price,
                                                exit_price: exit_px,
                                                quantity: close_qty,
                                                pnl_usdt: pnl,
                                                r_multiple: r_mult,
                                                reason: ExitReason::ManualClose,
                                                closed_at: now,
                                            };
                                            let is_partial = existing.remaining_quantity > 1e-10;
                                            if is_partial {
                                                open_positions.insert(symbol.clone(), existing);
                                            } else {
                                                open_meta.remove(&symbol);
                                                trailing_tighten_factor.remove(&symbol);
                                            }
                                            self.persist_trade_execution(&closed_trade, exit_fee_bps, None, None, None, is_maker_exit).await;
                                            recent_trades.insert(0, closed_trade);
                                            recent_trades.truncate(100);
                                            if self.cfg.features.circuit_breaker
                                                && self.cfg.risk.flatten_on_circuit_breaker
                                                && risk.status().state == CircuitBreakerState::Halted
                                            {
                                                self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                                            }
                                            reply_ok(reply, serde_json::json!({ "accepted": true, "status": "FILLED", "reduceOnly": true, "avgPrice": exit_px, "executedQty": close_qty }));
                                        } else {
                                            let crosses_book = is_limit
                                                && match side {
                                                    Side::Long => lim_px >= ref_px,
                                                    Side::Short => lim_px <= ref_px,
                                                };
                                            if order_method == OrderExecutionMethod::LimitMaker && crosses_book {
                                                reply_err(
                                                    reply,
                                                    format!("LIMIT_MAKER (Post-Only) on {symbol} would cross market ({ref_px})"),
                                                );
                                                continue;
                                            }
                                            let immediately_marketable = !is_limit || crosses_book;
                                            let tif_upper = self.cfg.automation.time_in_force.to_uppercase();
                                            if !immediately_marketable
                                                && order_method == OrderExecutionMethod::Limit
                                                && matches!(tif_upper.as_str(), "IOC" | "FOK")
                                            {
                                                reply_err(
                                                    reply,
                                                    format!("{tif_upper} LIMIT order on {symbol} ({lim_px}) did not cross market ({ref_px}) and expired"),
                                                );
                                                continue;
                                            }
                                            let entry_fee_bps = self.effective_fee_bps(order_method == OrderExecutionMethod::LimitMaker && !immediately_marketable);
                                            if !immediately_marketable {
                                                let oid = format!("paper-lim-{}-{}", symbol, now.timestamp_millis());
                                                let pend_pos = Position {
                                                    id: oid.clone(),
                                                    symbol: symbol.clone(),
                                                    side,
                                                    entry_price: lim_px,
                                                    quantity: qty,
                                                    remaining_quantity: qty,
                                                    unrealized_pnl_usdt: 0.0,
                                                    realized_pnl_usdt: 0.0,
                                                    highest_favorable_price: lim_px,
                                                    exit_plan: plan.clone(),
                                                    opened_at: now,
                                                };
                                                self.persist_entry_execution(&pend_pos, order_method, None, entry_fee_bps, "Paper limit order resting", Some("NEW")).await;
                                                pending_orders.insert(symbol.clone(), PendingOrderState {
                                                    order_id: oid.clone(),
                                                    symbol: symbol.clone(),
                                                    side,
                                                    order_method,
                                                    quantity: qty,
                                                    limit_price: lim_px,
                                                    take_profit_price,
                                                    stop_loss_price,
                                                    reduce_only,
                                                    atr,
                                                    exit_plan: plan,
                                                    rationale: "Manual paper limit order".into(),
                                                    bar_idx: bar_index.get(&symbol).copied().unwrap_or(0),
                                                    is_live: false,
                                                    is_manual: true,
                                                    created_at: now,
                                                });
                                                reply_ok(reply, serde_json::json!({ "accepted": true, "status": "NEW", "orderId": oid }));
                                            } else {
                                                let fill_px = ref_px;
                                                let pos = Position {
                                                    id: format!("{}-manual-{}", symbol, now.timestamp_millis()),
                                                    symbol: symbol.clone(),
                                                    side,
                                                    entry_price: fill_px,
                                                    quantity: qty,
                                                    remaining_quantity: qty,
                                                    unrealized_pnl_usdt: 0.0,
                                                    realized_pnl_usdt: 0.0,
                                                    highest_favorable_price: fill_px,
                                                    exit_plan: plan,
                                                    opened_at: now,
                                                };
                                                self.persist_entry_execution(&pos, order_method, None, entry_fee_bps, "Manual order entry", None).await;
                                                open_meta.insert(symbol.clone(), OpenPositionMeta {
                                                    order_list_id: None,
                                                    algo_order_ids: Vec::new(),
                                                    entry_fee_bps,
                                                });
                                                open_positions.insert(symbol.clone(), pos);
                                                reply_ok(reply, serde_json::json!({ "accepted": true, "status": "FILLED", "avgPrice": fill_px, "executedQty": qty }));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        EngineCommand::UpdateWatchlist {
                            pair_selection_mode,
                            pinned_pairs: new_pinned,
                            trending_category,
                            quote_asset,
                            max_watchlist_pairs,
                            trending_top_n,
                            reply,
                        } => {
                            if let Some(m) = pair_selection_mode {
                                trading_cfg.pair_selection_mode = m;
                                *self.pair_selection_mode.write().await = m;
                            }
                            if let Some(pp) = new_pinned {
                                pinned_pairs = normalize_symbol_list(&pp, &[]);
                                trading_cfg.pairs = pinned_pairs.clone();
                            }
                            if let Some(cat) = trending_category {
                                trading_cfg.trending_category = cat;
                            }
                            if let Some(qa) = quote_asset {
                                let clean_qa = qa.trim().to_uppercase();
                                if !clean_qa.is_empty() {
                                    trading_cfg.quote_asset = clean_qa;
                                }
                            }
                            if let Some(max_w) = max_watchlist_pairs {
                                trading_cfg.max_watchlist_pairs = max_w.clamp(1, 40);
                            }
                            if let Some(top_n) = trending_top_n {
                                trading_cfg.trending_top_n = top_n.clamp(1, 20);
                            }
                            self.recompute_and_sync_watchlist(
                                &trading_cfg,
                                &pinned_pairs,
                                &open_positions,
                                &pending_orders,
                                &mut dwell_state,
                                &mut pipelines,
                                &mut candle_history,
                                &mut atr_history,
                                &mut prev_closes,
                                &mut bar_index,
                                &mut last_closed_bar_ms,
                                &mut last_prices,
                            )
                            .await;
                            let active_wl = self.active_watchlist.read().await.clone();
                            reply_ok(
                                reply,
                                serde_json::json!({
                                    "accepted": true,
                                    "pairSelectionMode": trading_cfg.pair_selection_mode,
                                    "pinnedPairs": pinned_pairs,
                                    "activeWatchlist": active_wl,
                                }),
                            );
                        }
                    }
                    self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                }
                _ = watchlist_tick.tick() => {
                    self.recompute_and_sync_watchlist(
                        &trading_cfg,
                        &pinned_pairs,
                        &open_positions,
                        &pending_orders,
                        &mut dwell_state,
                        &mut pipelines,
                        &mut candle_history,
                        &mut atr_history,
                        &mut prev_closes,
                        &mut bar_index,
                        &mut last_closed_bar_ms,
                        &mut last_prices,
                    )
                    .await;
                    let sc_snap = self.query_screener(
                        trading_cfg.trending_category,
                        &trading_cfg.quote_asset,
                        trading_cfg.trending_min_quote_volume_usdt,
                        true,
                        50,
                        None,
                    ).await;
                    *self.latest_screener.write().await = sc_snap.clone();
                    let _ = self.screener_tx.send(sc_snap);
                    self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                }
                _ = reconcile_tick.tick(), if self.is_live_armed() && !pending_orders.is_empty() => {
                    let syms: Vec<String> = pending_orders
                        .iter()
                        .filter(|(_, p)| p.is_live)
                        .map(|(s, _)| s.clone())
                        .collect();
                    let mut changed = false;
                    for sym in syms {
                        let Some(pend) = pending_orders.get(&sym).cloned() else {
                            continue;
                        };
                        let Ok(oid_num) = pend.order_id.parse::<i64>() else {
                            continue;
                        };
                        let Ok(st) = self.gateway.query_order_status(&sym, oid_num).await else {
                            continue;
                        };
                        if st.status == "FILLED" || (st.executed_qty > 0.0 && matches!(st.status.as_str(), "CANCELED" | "CANCELLED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED")) {
                            pending_orders.remove(&sym);
                            changed = true;
                            if st.executed_qty > 0.0 && pend.reduce_only {
                                if let Some(mut existing) = open_positions.remove(&sym) {
                                    let fill_px = if st.avg_price > 0.0 { st.avg_price } else { pend.limit_price };
                                    let close_qty = st.executed_qty.min(existing.remaining_quantity);
                                    let orig_entry_fee_bps = open_meta
                                        .get(&sym)
                                        .map(|m| m.entry_fee_bps)
                                        .unwrap_or_else(|| self.effective_fee_bps(false));
                                    let is_maker_exit = pend.order_method == OrderExecutionMethod::LimitMaker;
                                    let exit_fee_bps = self.effective_fee_bps(is_maker_exit);
                                    let now = Utc::now();
                                    let pnl = Self::calc_net_pnl_with_fees(
                                        existing.side,
                                        existing.entry_price,
                                        fill_px,
                                        close_qty,
                                        orig_entry_fee_bps,
                                        exit_fee_bps,
                                    );
                                    let r_mult = pnl / (existing.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                    risk.record_realized_pnl(&sym, pnl, now);
                                    existing.remaining_quantity = (existing.remaining_quantity - close_qty).max(0.0);
                                    existing.realized_pnl_usdt += pnl;
                                    let closed_trade = ClosedTrade {
                                        id: format!("{}-reduce-{}", existing.id, now.timestamp_millis()),
                                        symbol: sym.clone(),
                                        side: existing.side,
                                        entry_price: existing.entry_price,
                                        exit_price: fill_px,
                                        quantity: close_qty,
                                        pnl_usdt: pnl,
                                        r_multiple: r_mult,
                                        reason: ExitReason::ManualClose,
                                        closed_at: now,
                                    };
                                    if existing.remaining_quantity > 1e-10 {
                                        open_positions.insert(sym.clone(), existing);
                                    } else {
                                        open_meta.remove(&sym);
                                        trailing_tighten_factor.remove(&sym);
                                    }
                                    self.persist_trade_execution(&closed_trade, exit_fee_bps, Some(&pend.order_id), None, None, is_maker_exit).await;
                                    recent_trades.insert(0, closed_trade);
                                    recent_trades.truncate(100);
                                }
                            } else if st.executed_qty > 0.0 && !pend.reduce_only && !open_positions.contains_key(&sym) {
                                let fill_px = if st.avg_price > 0.0 { st.avg_price } else { pend.limit_price };
                                let plan = if pend.stop_loss_price.is_some() || pend.take_profit_price.is_some() {
                                    pend.exit_plan.clone()
                                } else {
                                    build_exit_plan_with_features(pend.side, fill_px, pend.atr, &self.cfg.exits, &self.cfg.features)
                                };
                                let entry_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                                let now = Utc::now();
                                info!(symbol = %pend.symbol, age_secs = (now - pend.created_at).num_seconds(), order_id = %pend.order_id, "Live resting order filled");
                                let pos = Position {
                                    id: format!("{}-{}", sym, now.timestamp_millis()),
                                    symbol: sym.clone(),
                                    side: pend.side,
                                    entry_price: fill_px,
                                    quantity: st.executed_qty,
                                    remaining_quantity: st.executed_qty,
                                    unrealized_pnl_usdt: 0.0,
                                    realized_pnl_usdt: 0.0,
                                    highest_favorable_price: fill_px,
                                    exit_plan: plan,
                                    opened_at: now,
                                };
                                let ack = LiveOrderAck {
                                    order_id: Some(pend.order_id.clone()),
                                    status: st.status.clone(),
                                    filled: true,
                                    executed_qty: st.executed_qty,
                                    avg_price: fill_px,
                                    ..Default::default()
                                };
                                self.persist_entry_execution(&pos, pend.order_method, Some(&ack), entry_fee_bps, &pend.rationale, Some("FILLED")).await;
                                last_entry_bar.insert(sym.clone(), pend.bar_idx);
                                open_meta.insert(sym.clone(), OpenPositionMeta {
                                    order_list_id: None,
                                    algo_order_ids: Vec::new(),
                                    entry_fee_bps,
                                });
                                open_positions.insert(sym, pos);
                            }
                        } else if matches!(st.status.as_str(), "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED") {
                            pending_orders.remove(&sym);
                            self.mark_pending_order_canceled_async(
                                &sym,
                                &pend.order_id,
                                &format!("Exchange reported resting order {}", st.status),
                            )
                            .await;
                            changed = true;
                        }
                    }
                    if changed {
                        self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                    }
                }
                Some(ws_ev) = mkt_rx.recv() => {
                    let ev = match ws_ev {
                        WsStreamEvent::MiniTickerAll(tickers) => {
                            {
                                let mut sc = self.screener_cache.write().await;
                                for t in tickers {
                                    sc.insert(t.symbol.clone(), t);
                                }
                            }
                            let sc_snap = self.query_screener(
                                trading_cfg.trending_category,
                                &trading_cfg.quote_asset,
                                trading_cfg.trending_min_quote_volume_usdt,
                                true,
                                50,
                                None,
                            ).await;
                            *self.latest_screener.write().await = sc_snap.clone();
                            let _ = self.screener_tx.send(sc_snap);
                            continue;
                        }
                        WsStreamEvent::BookTicker { symbol, best_bid, best_ask } => {
                            let mid = (best_bid + best_ask) * 0.5;
                            let spread_bps = if mid > 0.0 && best_ask >= best_bid {
                                ((best_ask - best_bid) / mid) * 10_000.0
                            } else {
                                0.0
                            };
                            self.bbo_quotes.write().await.insert(symbol, (best_bid, best_ask, spread_bps));
                            continue;
                        }
                        WsStreamEvent::Candle(c_ev) => c_ev,
                    };

                    last_prices.insert(ev.symbol.clone(), ev.price);
                    let pipe = pipelines
                        .entry(ev.symbol.clone())
                        .or_insert_with(|| IndicatorPipeline::new(&self.cfg.indicators));

                    // Deduplicate closed-bar updates across REST poll ticks and WS close frames.
                    let is_newly_closed = ev.candle.is_closed
                        && last_closed_bar_ms.get(&ev.symbol).copied() != Some(ev.candle.open_time_ms);

                    let mut prev_close_for_tr = prev_closes.get(&ev.symbol).copied().unwrap_or(ev.candle.close);
                    let ind = if is_newly_closed {
                        if has_candle_sequence_gap(
                            last_closed_bar_ms.get(&ev.symbol).copied(),
                            ev.candle.open_time_ms,
                            &trading_cfg.timeframe,
                        ) && !self.gateway.is_rate_constrained()
                        {
                            if let Ok(backfill) = self.gateway.fetch_klines(&ev.symbol, &trading_cfg.timeframe, 50).await {
                                for bc in &backfill {
                                    if !bc.is_closed || bc.open_time_ms >= ev.candle.open_time_ms {
                                        continue;
                                    }
                                    if last_closed_bar_ms.get(&ev.symbol).is_some_and(|&prev| bc.open_time_ms <= prev) {
                                        continue;
                                    }
                                    last_closed_bar_ms.insert(ev.symbol.clone(), bc.open_time_ms);
                                    let next_b = bar_index.get(&ev.symbol).copied().unwrap_or(0) + 1;
                                    bar_index.insert(ev.symbol.clone(), next_b);
                                    let hist = candle_history.entry(ev.symbol.clone()).or_default();
                                    hist.push(*bc);
                                    if hist.len() > 70 { hist.remove(0); }
                                    let b_snap = pipe.update_with_gap(bc, false);
                                    prev_close_for_tr = bc.close;
                                    prev_closes.insert(ev.symbol.clone(), bc.close);
                                    if let Some(a) = b_snap.atr {
                                        let ah = atr_history.entry(ev.symbol.clone()).or_default();
                                        ah.push(a);
                                        if ah.len() > 16 { ah.remove(0); }
                                    }
                                }
                            }
                        }

                        let still_gapped = has_candle_sequence_gap(
                            last_closed_bar_ms.get(&ev.symbol).copied(),
                            ev.candle.open_time_ms,
                            &trading_cfg.timeframe,
                        );
                        last_closed_bar_ms.insert(ev.symbol.clone(), ev.candle.open_time_ms);
                        let next_idx = bar_index.get(&ev.symbol).copied().unwrap_or(0) + 1;
                        bar_index.insert(ev.symbol.clone(), next_idx);
                        let hist = candle_history.entry(ev.symbol.clone()).or_default();
                        if hist.last().is_none_or(|c| c.open_time_ms != ev.candle.open_time_ms) {
                            hist.push(ev.candle);
                            if hist.len() > 70 {
                                hist.remove(0);
                            }
                        }
                        let snap = pipe.update_with_gap(&ev.candle, still_gapped);
                        prev_closes.insert(ev.symbol.clone(), ev.candle.close);
                        if let Some(a) = snap.atr {
                            let ah = atr_history.entry(ev.symbol.clone()).or_default();
                            ah.push(a);
                            if ah.len() > 16 {
                                ah.remove(0);
                            }
                        }
                        snap
                    } else {
                        pipe.snapshot()
                    };

                    // Evaluate ATR volatility spike alerts once per closed bar (11-bar baseline matching simulator.ts)
                    if is_newly_closed && self.cfg.indicators.volatility_alerts_enabled {
                        if let Some(atr) = ind.atr {
                            if ev.price > 0.0 && atr > 0.0 {
                                let ah = atr_history.get(&ev.symbol);
                                let baseline_atr = ah
                                    .map(|vals| {
                                        let prev_end = vals.len().saturating_sub(1);
                                        let prev_start = prev_end.saturating_sub(11);
                                        let slice = &vals[prev_start..prev_end];
                                        if slice.is_empty() {
                                            atr
                                        } else {
                                            slice.iter().sum::<f64>() / slice.len() as f64
                                        }
                                    })
                                    .unwrap_or(atr);
                                if baseline_atr > 0.0 {
                                    let atr_pct = (atr / ev.price) * 100.0;
                                    let tr = (ev.candle.high - ev.candle.low)
                                        .max((ev.candle.high - prev_close_for_tr).abs())
                                        .max((ev.candle.low - prev_close_for_tr).abs());
                                    let exp_ratio = (atr / baseline_atr).max(tr / baseline_atr);
                                    let now_ms = ev.received_at.timestamp_millis();
                                    let cooldown_ms = (self.cfg.indicators.volatility_alert_cooldown_sec as i64) * 1000;
                                    let last_ms = last_vol_alert_ms.get(&ev.symbol).copied().unwrap_or(-1_000_000_000);
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
                    }

                    // Dynamic pending order inspection + Paper LIMIT / LIMIT_MAKER fill
                    let spread_bps = self.bbo_quotes.read().await.get(&ev.symbol).map(|(_, _, sp)| *sp);
                    let current_bar_idx = bar_index.get(&ev.symbol).copied().unwrap_or(0);
                    let opp_signal_closed = if is_newly_closed {
                        let recent_slice = candle_history.get(&ev.symbol).map(Vec::as_slice).unwrap_or(&[]);
                        // Use Both + enforce_spot_long_only=false strictly for REVERSAL DETECTION (never for Spot Short opening!)
                        evaluate_entry_signal_with_options(
                            &ev.symbol,
                            &ev.candle,
                            &ind,
                            &self.cfg,
                            recent_slice,
                            ev.received_at,
                            spread_bps,
                            Some(DirectionPolicy::Both),
                            false,
                        )
                    } else {
                        None
                    };

                    if is_newly_closed {
                        if let Some(pend) = pending_orders.get(&ev.symbol).cloned() {
                            if let PendingOrderDynamicAction::Cancel { reason, rationale } =
                                evaluate_pending_order_dynamic_action(&PendingOrderEvalCtx {
                                    pending_side: pend.side,
                                    limit_price: pend.limit_price,
                                    is_manual: pend.is_manual,
                                    created_bar_idx: pend.bar_idx,
                                    current_bar_idx,
                                    candle: &ev.candle,
                                    ind: &ind,
                                    auto_cfg: &self.cfg.automation,
                                    opposing_signal: opp_signal_closed.as_ref(),
                                })
                            {
                                let mut handle_canceled = true;
                                if pend.is_live {
                                    if let Ok(oid_num) = pend.order_id.parse::<i64>() {
                                        match self.gateway.cancel_single_order(&ev.symbol, oid_num).await {
                                            Ok(CancelOrderOutcome::AlreadyFilled(st)) => {
                                                handle_canceled = false;
                                                pending_orders.remove(&ev.symbol);
                                                let fill_px = if st.avg_price > 0.0 { st.avg_price } else { pend.limit_price };
                                                let exec_qty = if st.executed_qty > 0.0 { st.executed_qty } else { pend.quantity };
                                                let plan = if pend.stop_loss_price.is_some() || pend.take_profit_price.is_some() {
                                                    pend.exit_plan.clone()
                                                } else {
                                                    build_exit_plan_with_features(pend.side, fill_px, pend.atr, &self.cfg.exits, &self.cfg.features)
                                                };
                                                let entry_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                                                let pos = Position {
                                                    id: format!("{}-{}", ev.symbol, ev.received_at.timestamp_millis()),
                                                    symbol: ev.symbol.clone(),
                                                    side: pend.side,
                                                    entry_price: fill_px,
                                                    quantity: exec_qty,
                                                    remaining_quantity: exec_qty,
                                                    unrealized_pnl_usdt: 0.0,
                                                    realized_pnl_usdt: 0.0,
                                                    highest_favorable_price: fill_px,
                                                    exit_plan: plan,
                                                    opened_at: ev.received_at,
                                                };
                                                let ack = LiveOrderAck {
                                                    order_id: Some(pend.order_id.clone()),
                                                    status: st.status.clone(),
                                                    filled: true,
                                                    executed_qty: exec_qty,
                                                    avg_price: fill_px,
                                                    ..Default::default()
                                                };
                                                self.persist_entry_execution(&pos, pend.order_method, Some(&ack), entry_fee_bps, &pend.rationale, Some("FILLED")).await;
                                                last_entry_bar.insert(ev.symbol.clone(), pend.bar_idx);
                                                open_meta.insert(ev.symbol.clone(), OpenPositionMeta {
                                                    order_list_id: None,
                                                    algo_order_ids: Vec::new(),
                                                    entry_fee_bps,
                                                });
                                                open_positions.insert(ev.symbol.clone(), pos);
                                            }
                                            Ok(CancelOrderOutcome::Canceled) => {}
                                            Err(err) => {
                                                handle_canceled = false;
                                                warn!(symbol = %ev.symbol, %err, "Dynamic pending order cancel failed; keeping local tracking");
                                            }
                                        }
                                    }
                                }
                                if handle_canceled {
                                    pending_orders.remove(&ev.symbol);
                                    self.mark_pending_order_canceled_async(&ev.symbol, &pend.order_id, &rationale).await;
                                    info!(symbol = %ev.symbol, ?reason, %rationale, "Dynamic pending limit order auto-canceled");
                                    if reason == PendingCancelReason::SignalReversed {
                                        let opp_side = match pend.side {
                                            Side::Long => Side::Short,
                                            Side::Short => Side::Long,
                                        };
                                        reversal_bypass_cooldown.insert(ev.symbol.clone(), opp_side);
                                    }
                                }
                            }
                        }
                    }

                    // Fill resting Paper LIMIT / LIMIT_MAKER orders when price crosses limit
                    if let Some(pend) = pending_orders.get(&ev.symbol).cloned() {
                        if !pend.is_live {
                            let crossed = match pend.side {
                                Side::Long => ev.price <= pend.limit_price || ev.candle.low <= pend.limit_price,
                                Side::Short => ev.price >= pend.limit_price || ev.candle.high >= pend.limit_price,
                            };
                            if crossed {
                                pending_orders.remove(&ev.symbol);
                                if !pend.reduce_only && !open_positions.contains_key(&ev.symbol) {
                                    let fill_px = pend.limit_price;
                                    info!(symbol = %pend.symbol, age_secs = (ev.received_at - pend.created_at).num_seconds(), "Paper resting limit order filled");
                                    let entry_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                                    let plan = if pend.stop_loss_price.is_some() || pend.take_profit_price.is_some() {
                                        pend.exit_plan.clone()
                                    } else {
                                        build_exit_plan_with_features(pend.side, fill_px, pend.atr, &self.cfg.exits, &self.cfg.features)
                                    };
                                    let pos = Position {
                                        id: format!("{}-{}", ev.symbol, ev.received_at.timestamp_millis()),
                                        symbol: ev.symbol.clone(),
                                        side: pend.side,
                                        entry_price: fill_px,
                                        quantity: pend.quantity,
                                        remaining_quantity: pend.quantity,
                                        unrealized_pnl_usdt: 0.0,
                                        realized_pnl_usdt: 0.0,
                                        highest_favorable_price: fill_px,
                                        exit_plan: plan,
                                        opened_at: ev.received_at,
                                    };
                                    self.persist_entry_execution(&pos, pend.order_method, None, entry_fee_bps, &pend.rationale, Some("FILLED")).await;
                                    last_entry_bar.insert(ev.symbol.clone(), pend.bar_idx);
                                    open_meta.insert(ev.symbol.clone(), OpenPositionMeta {
                                        order_list_id: None,
                                        algo_order_ids: Vec::new(),
                                        entry_fee_bps,
                                    });
                                    open_positions.insert(ev.symbol.clone(), pos);
                                }
                            }
                        }
                    }

                    // Manage existing position tick-by-tick (24/7 regardless of session window)
                    let mut flip_signal_after_exit: Option<bot_core::EntrySignal> = None;
                    if let Some(mut pos) = open_positions.remove(&ev.symbol) {
                        pos.unrealized_pnl_usdt = match pos.side {
                            Side::Long => (ev.price - pos.entry_price) * pos.remaining_quantity,
                            Side::Short => (pos.entry_price - ev.price) * pos.remaining_quantity,
                        };
                        let mut early_exit_signal: Option<(bot_core::EntrySignal, String)> = None;
                        if is_newly_closed {
                            match evaluate_open_position_dynamic_action(
                                &pos,
                                &ev.candle,
                                &ind,
                                &self.cfg.automation,
                                opp_signal_closed.as_ref(),
                            ) {
                                OpenPositionDynamicAction::Hold => {}
                                OpenPositionDynamicAction::TightenTrailing { factor, rationale } => {
                                    trailing_tighten_factor.insert(ev.symbol.clone(), factor);
                                    info!(symbol = %ev.symbol, factor, %rationale, "Tightened open position trailing stop");
                                }
                                OpenPositionDynamicAction::EarlyReversalExit { opposing_signal, rationale } => {
                                    early_exit_signal = Some((opposing_signal, rationale));
                                }
                            }
                        }

                        if let Some((opp_sig, rationale)) = early_exit_signal {
                            if self.is_live_armed() && !self.cfg.automation.auto_close_on_exit {
                                open_positions.insert(ev.symbol.clone(), pos);
                            } else {
                                let mut closed_qty = pos.remaining_quantity;
                                let mut exec_exit_px = ev.price;
                                let mut close_oid: Option<String> = None;
                                let mut close_aid: Option<i64> = None;
                                let mut aborted = false;
                                let meta = open_meta.remove(&ev.symbol);
                                let entry_fee_bps = meta
                                    .as_ref()
                                    .map(|m| m.entry_fee_bps)
                                    .unwrap_or_else(|| self.effective_fee_bps(false));
                                if self.is_live_armed() {
                                    if let Some((reconciled_px, aid)) = self.detect_exchange_already_closed(&ev.symbol, &pos, meta.as_ref(), exec_exit_px).await {
                                        exec_exit_px = reconciled_px;
                                        close_aid = aid;
                                    } else {
                                        let _ = self.gateway.cancel_open_brackets(&ev.symbol, meta.as_ref().and_then(|m| m.order_list_id)).await;
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
                                            Ok(ack) => {
                                                if ack.avg_price > 0.0 { exec_exit_px = ack.avg_price; }
                                                if ack.executed_qty > 0.0 {
                                                    closed_qty = ack.executed_qty.min(pos.remaining_quantity);
                                                }
                                                close_oid = ack.order_id;
                                            }
                                            Err(err) => {
                                                warn!(symbol = %ev.symbol, %err, "Early SignalReversal live close failed; keeping position");
                                                if let Some(m) = meta { open_meta.insert(ev.symbol.clone(), m); }
                                                open_positions.insert(ev.symbol.clone(), pos.clone());
                                                aborted = true;
                                            }
                                        }
                                    }
                                }
                                if !aborted {
                                    trailing_tighten_factor.remove(&ev.symbol);
                                    let exit_fee_bps = self.effective_fee_bps(false);
                                    let pnl = Self::calc_net_pnl_with_fees(pos.side, pos.entry_price, exec_exit_px, closed_qty, entry_fee_bps, exit_fee_bps);
                                    let r_mult = pnl / (pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                                    risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                    let closed_rev = ClosedTrade {
                                        id: pos.id.clone(),
                                        symbol: pos.symbol.clone(),
                                        side: pos.side,
                                        entry_price: pos.entry_price,
                                        exit_price: exec_exit_px,
                                        quantity: closed_qty,
                                        pnl_usdt: pnl,
                                        r_multiple: r_mult,
                                        reason: ExitReason::SignalReversal,
                                        closed_at: ev.received_at,
                                    };
                                    info!(symbol = %ev.symbol, %rationale, pnl, "Closed open position early on SignalReversal");
                                    self.persist_trade_execution(&closed_rev, exit_fee_bps, close_oid.as_deref(), close_aid, None, false).await;
                                    recent_trades.insert(0, closed_rev);
                                    let cb_halted = self.cfg.features.circuit_breaker
                                        && self.cfg.risk.flatten_on_circuit_breaker
                                        && risk.status().state == CircuitBreakerState::Halted;
                                    if cb_halted {
                                        self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                                    } else if running
                                        && self.cfg.automation.enabled
                                        && self.session_allows_entry(ev.received_at)
                                        && self.cfg.automation.auto_flip_on_reversal
                                        && self.cfg.exchange.venue == ExchangeVenue::Futures
                                        && matches!(
                                            (self.cfg.automation.direction_policy, opp_sig.side),
                                            (DirectionPolicy::Both, _)
                                                | (DirectionPolicy::LongOnly, Side::Long)
                                                | (DirectionPolicy::ShortOnly, Side::Short)
                                        )
                                    {
                                        reversal_bypass_cooldown.insert(ev.symbol.clone(), opp_sig.side);
                                        flip_signal_after_exit = Some(opp_sig);
                                    }
                                }
                            }
                        } else {
                            let atr_val = ind.atr.unwrap_or(pos.exit_plan.risk_distance_r);
                            let mut sim_pos = pos.clone();
                            let trail_override = trailing_tighten_factor
                                .get(&ev.symbol)
                                .copied()
                                .map(|factor| (self.cfg.exits.atr_trailing_multiplier * factor).max(0.25));
                            match manage_position_tick_with_trail_override(&mut sim_pos, ev.price, atr_val, &self.cfg.exits, trail_override) {
                                PositionTickAction::Hold => {
                                    open_positions.insert(ev.symbol.clone(), sim_pos);
                                }
                                PositionTickAction::PartialClose { ratio, exit_price, reason } => {
                                if self.is_live_armed() && !self.cfg.automation.auto_close_on_exit {
                                    // Leave live position open/managed on exchange without logging fake closes
                                    open_positions.insert(ev.symbol.clone(), pos);
                                } else {
                                    let mut close_qty = sim_pos.remaining_quantity * ratio;
                                    let mut exec_exit_px = exit_price;
                                    let mut close_oid: Option<String> = None;
                                    let mut close_aid: Option<i64> = None;
                                    let mut keep_open_on_error = false;
                                    if self.is_live_armed() {
                                        let meta = open_meta.get(&ev.symbol).cloned();
                                        if let Some((reconciled_px, aid)) = self.detect_exchange_already_closed(&ev.symbol, &sim_pos, meta.as_ref(), ev.price).await {
                                            exec_exit_px = reconciled_px;
                                            close_aid = aid;
                                            let full_qty = sim_pos.remaining_quantity;
                                            let entry_fee_bps = meta.as_ref().map(|m| m.entry_fee_bps).unwrap_or_else(|| self.effective_fee_bps(false));
                                            let exit_fee_bps = self.effective_fee_bps(false);
                                            let pnl = Self::calc_net_pnl_with_fees(sim_pos.side, sim_pos.entry_price, exec_exit_px, full_qty, entry_fee_bps, exit_fee_bps);
                                            let r_mult = pnl / (sim_pos.exit_plan.risk_distance_r * full_qty).max(1e-9);
                                            risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                            let closed_full = ClosedTrade {
                                                id: sim_pos.id.clone(),
                                                symbol: sim_pos.symbol.clone(),
                                                side: sim_pos.side,
                                                entry_price: sim_pos.entry_price,
                                                exit_price: exec_exit_px,
                                                quantity: full_qty,
                                                pnl_usdt: pnl,
                                                r_multiple: r_mult,
                                                reason: ExitReason::TakeProfit2,
                                                closed_at: ev.received_at,
                                            };
                                            open_meta.remove(&ev.symbol);
                                            self.persist_trade_execution(&closed_full, exit_fee_bps, None, close_aid, None, false).await;
                                            recent_trades.insert(0, closed_full);
                                            recent_trades.truncate(100);
                                            self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                                            continue;
                                        }
                                        let list_id = meta.as_ref().and_then(|m| m.order_list_id);
                                        let _ = self.gateway.cancel_open_brackets(&ev.symbol, list_id).await;
                                        if let Some(m) = open_meta.get_mut(&ev.symbol) {
                                            m.order_list_id = None;
                                            m.algo_order_ids.clear();
                                        }
                                        let req = LiveOrderRequest {
                                            symbol: ev.symbol.clone(),
                                            side: sim_pos.side,
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
                                            Ok(ack) => {
                                                if ack.avg_price > 0.0 { exec_exit_px = ack.avg_price; }
                                                if ack.executed_qty > 0.0 {
                                                    close_qty = ack.executed_qty.min(sim_pos.remaining_quantity);
                                                }
                                                close_oid = ack.order_id;
                                            }
                                            Err(err) => {
                                                warn!(symbol = %ev.symbol, %err, "Live partial exit failed; keeping position intact");
                                                keep_open_on_error = true;
                                            }
                                        }
                                    }
                                    if keep_open_on_error {
                                        open_positions.insert(ev.symbol.clone(), pos);
                                    } else {
                                        let entry_fee_bps = open_meta.get(&ev.symbol).map(|m| m.entry_fee_bps).unwrap_or_else(|| self.effective_fee_bps(false));
                                        let exit_fee_bps = self.effective_fee_bps(false);
                                        let pnl = Self::calc_net_pnl_with_fees(sim_pos.side, sim_pos.entry_price, exec_exit_px, close_qty, entry_fee_bps, exit_fee_bps);
                                        let r_mult = pnl / (sim_pos.exit_plan.risk_distance_r * close_qty).max(1e-9);
                                        sim_pos.remaining_quantity -= close_qty;
                                        sim_pos.realized_pnl_usdt += pnl;
                                        risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                        let closed_tp1 = ClosedTrade {
                                            id: format!("{}-tp1", sim_pos.id),
                                            symbol: sim_pos.symbol.clone(),
                                            side: sim_pos.side,
                                            entry_price: sim_pos.entry_price,
                                            exit_price: exec_exit_px,
                                            quantity: close_qty,
                                            pnl_usdt: pnl,
                                            r_multiple: r_mult,
                                            reason,
                                            closed_at: ev.received_at,
                                        };
                                        self.persist_trade_execution(&closed_tp1, exit_fee_bps, close_oid.as_deref(), close_aid, None, false).await;
                                        recent_trades.insert(0, closed_tp1);
                                        if sim_pos.remaining_quantity <= 1e-10 {
                                            open_meta.remove(&ev.symbol);
                                        } else {
                                            open_positions.insert(ev.symbol.clone(), sim_pos);
                                        }
                                    }
                                }
                            }
                            PositionTickAction::FullClose { exit_price, reason } => {
                                if self.is_live_armed() && !self.cfg.automation.auto_close_on_exit {
                                    open_positions.insert(ev.symbol.clone(), pos);
                                } else {
                                    let closed_qty = sim_pos.remaining_quantity;
                                    let mut exec_exit_px = exit_price;
                                    let mut close_oid: Option<String> = None;
                                    let mut close_aid: Option<i64> = None;
                                    let mut aborted = false;
                                    if self.is_live_armed() {
                                        let meta = open_meta.remove(&ev.symbol);
                                        let entry_fee_bps = meta
                                            .as_ref()
                                            .map(|m| m.entry_fee_bps)
                                            .unwrap_or_else(|| self.effective_fee_bps(false));
                                        if let Some((reconciled_px, aid)) = self.detect_exchange_already_closed(&ev.symbol, &sim_pos, meta.as_ref(), exec_exit_px).await {
                                            exec_exit_px = reconciled_px;
                                            close_aid = aid;
                                        } else {
                                            let _ = self.gateway.cancel_open_brackets(&ev.symbol, meta.as_ref().and_then(|m| m.order_list_id)).await;
                                            let req = LiveOrderRequest {
                                                symbol: ev.symbol.clone(),
                                                side: sim_pos.side,
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
                                                Ok(ack) => {
                                                    if ack.avg_price > 0.0 { exec_exit_px = ack.avg_price; }
                                                    close_oid = ack.order_id;
                                                }
                                                Err(err) => {
                                                    warn!(symbol = %ev.symbol, %err, "Live full exit failed; keeping position intact");
                                                    if let Some(m) = meta { open_meta.insert(ev.symbol.clone(), m); }
                                                    open_positions.insert(ev.symbol.clone(), pos);
                                                    aborted = true;
                                                }
                                            }
                                        }
                                        if !aborted {
                                            trailing_tighten_factor.remove(&ev.symbol);
                                            let is_maker_exit = reason == ExitReason::TakeProfit2 && close_aid.is_some();
                                            let exit_fee_bps = self.effective_fee_bps(is_maker_exit);
                                            let pnl = Self::calc_net_pnl_with_fees(sim_pos.side, sim_pos.entry_price, exec_exit_px, closed_qty, entry_fee_bps, exit_fee_bps);
                                            let r_mult = pnl / (sim_pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                                            risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                            let closed_full = ClosedTrade {
                                                id: sim_pos.id.clone(),
                                                symbol: sim_pos.symbol.clone(),
                                                side: sim_pos.side,
                                                entry_price: sim_pos.entry_price,
                                                exit_price: exec_exit_px,
                                                quantity: closed_qty,
                                                pnl_usdt: pnl,
                                                r_multiple: r_mult,
                                                reason,
                                                closed_at: ev.received_at,
                                            };
                                            self.persist_trade_execution(&closed_full, exit_fee_bps, close_oid.as_deref(), close_aid, None, is_maker_exit).await;
                                            recent_trades.insert(0, closed_full);
                                            if self.cfg.features.git_auto_backup {
                                                self.spawn_git_backup("chore(backup): auto-sync after trade exit");
                                            }
                                            if self.cfg.features.circuit_breaker
                                                && risk.status().state == CircuitBreakerState::Halted
                                                && self.cfg.risk.flatten_on_circuit_breaker
                                            {
                                                self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                                            }
                                        }
                                    } else {
                                        trailing_tighten_factor.remove(&ev.symbol);
                                        let meta = open_meta.remove(&ev.symbol);
                                        let entry_fee_bps = meta.as_ref().map(|m| m.entry_fee_bps).unwrap_or_else(|| self.effective_fee_bps(false));
                                        let is_maker_exit = reason == ExitReason::TakeProfit2;
                                        let exit_fee_bps = self.effective_fee_bps(is_maker_exit);
                                        let pnl = Self::calc_net_pnl_with_fees(sim_pos.side, sim_pos.entry_price, exec_exit_px, closed_qty, entry_fee_bps, exit_fee_bps);
                                        let r_mult = pnl / (sim_pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                                        risk.record_realized_pnl(&ev.symbol, pnl, ev.received_at);
                                        let closed_full = ClosedTrade {
                                            id: sim_pos.id.clone(),
                                            symbol: sim_pos.symbol.clone(),
                                            side: sim_pos.side,
                                            entry_price: sim_pos.entry_price,
                                            exit_price: exec_exit_px,
                                            quantity: closed_qty,
                                            pnl_usdt: pnl,
                                            r_multiple: r_mult,
                                            reason,
                                            closed_at: ev.received_at,
                                        };
                                        self.persist_trade_execution(&closed_full, exit_fee_bps, None, None, None, is_maker_exit).await;
                                        recent_trades.insert(0, closed_full);
                                        if self.cfg.features.git_auto_backup {
                                            self.spawn_git_backup("chore(backup): auto-sync after trade exit");
                                        }
                                        if self.cfg.features.circuit_breaker
                                            && risk.status().state == CircuitBreakerState::Halted
                                            && self.cfg.risk.flatten_on_circuit_breaker
                                        {
                                            self.flatten_all_positions(&mut open_positions, &mut open_meta, &mut pending_orders, &last_prices, &mut recent_trades, &mut risk).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    }

                    if !open_positions.contains_key(&ev.symbol)
                        && running
                        && !pending_orders.contains_key(&ev.symbol)
                        && (is_newly_closed || flip_signal_after_exit.is_some())
                        && self.venue_enabled()
                        && self.cfg.automation.enabled
                        && self.cfg.features.automated_trading
                        && self.cfg.features.signal_generator
                        && self.session_allows_entry(ev.received_at)
                    {
                        let current_bar = bar_index.get(&ev.symbol).copied().unwrap_or(0);
                        let last_bar = last_entry_bar.get(&ev.symbol).copied();
                        let bypass_side = reversal_bypass_cooldown.get(&ev.symbol).copied();
                        let recent_slice = candle_history
                            .get(&ev.symbol)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]);
                        let candidate_sig = flip_signal_after_exit.or_else(|| {
                            evaluate_entry_signal_with_options(
                                &ev.symbol,
                                &ev.candle,
                                &ind,
                                &self.cfg,
                                recent_slice,
                                ev.received_at,
                                spread_bps,
                                None,
                                true,
                            )
                        });
                        if let Some(sig) = candidate_sig {
                            let cooldown_ok = bypass_side == Some(sig.side)
                                || last_bar.is_none_or(|prev| {
                                    current_bar.saturating_sub(prev) >= self.cfg.automation.signal_cooldown_bars as u64
                                });
                            let same_dir_limit = trading_cfg.max_same_direction_positions;
                            let same_dir_count = open_positions
                                .values()
                                .filter(|p| p.side == sig.side)
                                .count()
                                + pending_orders
                                    .values()
                                    .filter(|p| !p.reduce_only && p.side == sig.side)
                                    .count();
                            let active_slots = open_positions.len() + pending_orders.len();
                            let direction_cap_ok = same_dir_limit == 0 || same_dir_count < same_dir_limit;
                            if cooldown_ok && direction_cap_ok {
                                if self.cfg.exchange.venue == ExchangeVenue::Spot && sig.side == Side::Short {
                                    warn!(symbol = %sig.symbol, "Blocked Spot short signal");
                                } else {
                                    if bypass_side == Some(sig.side) {
                                        reversal_bypass_cooldown.remove(&ev.symbol);
                                    }
                                    let mut plan = build_exit_plan_with_features(
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
                                            active_slots,
                                            ev.received_at,
                                        )
                                    } else if active_slots >= self.cfg.trading.max_concurrent_positions {
                                        Err(bot_core::BotError::RiskRejected(format!(
                                            "Max concurrent positions ({}) reached",
                                            self.cfg.trading.max_concurrent_positions
                                        )))
                                    } else {
                                        let stop_dist = (sig.entry_price - plan.initial_stop_loss).abs().max(1e-9);
                                        let risk_usdt = risk.current_equity() * (self.cfg.trading.base_risk_per_trade_pct / 100.0);
                                        Ok(risk_usdt / stop_dist)
                                    };
                                    match auth_res {
                                        Ok(risk_qty) => {
                                            let active_pairs_vec: Vec<String> = self
                                                .active_watchlist
                                                .read()
                                                .await
                                                .iter()
                                                .map(|e| e.symbol.clone())
                                                .collect();
                                            let div_mult = Self::compute_portfolio_diversification_multiplier(
                                                &candle_history,
                                                if active_pairs_vec.is_empty() {
                                                    &trading_cfg.pairs
                                                } else {
                                                    &active_pairs_vec
                                                },
                                            );
                                            if let Some(mut qty) = self.compute_position_quantity_scaled(
                                                &recent_trades,
                                                risk.current_equity(),
                                                sig.entry_price,
                                                plan.initial_stop_loss,
                                                risk_qty,
                                                div_mult,
                                            ) {
                                                let order_method = self.cfg.automation.order_method;
                                                let is_limit = matches!(
                                                    order_method,
                                                    OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
                                                );
                                                let limit_px = if is_limit {
                                                    let off = self.cfg.automation.limit_offset_bps.max(0.0) / 10_000.0;
                                                    Some(match sig.side {
                                                        Side::Long => sig.entry_price * (1.0 - off),
                                                        Side::Short => sig.entry_price * (1.0 + off),
                                                    })
                                                } else {
                                                    None
                                                };
                                                if self.is_live_armed() {
                                                    let req = LiveOrderRequest {
                                                        symbol: sig.symbol.clone(),
                                                        side: sig.side,
                                                        order_method,
                                                        quantity: qty,
                                                        quote_order_qty: if !is_limit { Some(qty * sig.entry_price) } else { None },
                                                        limit_price: limit_px,
                                                        take_profit_price: if self.cfg.features.take_profit_ladder {
                                                            Some(plan.take_profit_2)
                                                        } else {
                                                            None
                                                        },
                                                        stop_loss_price: Some(plan.initial_stop_loss),
                                                        time_in_force: self.cfg.automation.time_in_force.clone(),
                                                        reduce_only: false,
                                                    };
                                                    match self.gateway.execute_live_order(&req).await {
                                                        Ok(ack) => {
                                                            let entry_fee_bps = self.effective_fee_bps(order_method == OrderExecutionMethod::LimitMaker);
                                                            let status_upper = ack.status.to_uppercase();
                                                            let is_terminal_unfilled = matches!(
                                                                status_upper.as_str(),
                                                                "EXPIRED" | "EXPIRED_IN_MATCH" | "CANCELED" | "CANCELLED" | "REJECTED"
                                                            ) && ack.executed_qty <= 0.0;
                                                            if is_terminal_unfilled {
                                                                warn!(symbol = %sig.symbol, status = %status_upper, "Live auto entry ended terminal unfilled");
                                                            } else if !ack.filled && ack.executed_qty <= 0.0 {
                                                                let pend_px = limit_px.unwrap_or(sig.entry_price);
                                                                let oid = ack.order_id.clone().unwrap_or_else(|| format!("pend-{}-{}", sig.symbol, ev.received_at.timestamp_millis()));
                                                                let pend_pos = Position {
                                                                    id: oid.clone(),
                                                                    symbol: sig.symbol.clone(),
                                                                    side: sig.side,
                                                                    entry_price: pend_px,
                                                                    quantity: qty,
                                                                    remaining_quantity: qty,
                                                                    unrealized_pnl_usdt: 0.0,
                                                                    realized_pnl_usdt: 0.0,
                                                                    highest_favorable_price: pend_px,
                                                                    exit_plan: plan.clone(),
                                                                    opened_at: ev.received_at,
                                                                };
                                                                self.persist_entry_execution(&pend_pos, order_method, Some(&ack), entry_fee_bps, &sig.rationale, Some("NEW")).await;
                                                                pending_orders.insert(sig.symbol.clone(), PendingOrderState {
                                                                    order_id: oid,
                                                                    symbol: sig.symbol.clone(),
                                                                    side: sig.side,
                                                                    order_method,
                                                                    quantity: qty,
                                                                    limit_price: pend_px,
                                                                    take_profit_price: req.take_profit_price,
                                                                    stop_loss_price: req.stop_loss_price,
                                                                    reduce_only: false,
                                                                    atr: sig.atr,
                                                                    exit_plan: plan,
                                                                    rationale: sig.rationale.clone(),
                                                                    bar_idx: current_bar,
                                                                    is_live: true,
                                                                    is_manual: false,
                                                                    created_at: ev.received_at,
                                                                });
                                                                info!(symbol = %sig.symbol, adx = ?sig.adx, rsi = ?sig.rsi, signal_ts = %sig.timestamp, "Live resting limit order placed");
                                                            } else {
                                                                let actual_entry = if ack.avg_price > 0.0 {
                                                                    plan = build_exit_plan_with_features(sig.side, ack.avg_price, sig.atr, &self.cfg.exits, &self.cfg.features);
                                                                    ack.avg_price
                                                                } else {
                                                                    sig.entry_price
                                                                };
                                                                if ack.executed_qty > 0.0 { qty = ack.executed_qty; }
                                                                if let Some(warning) = ack.bracket_warning.as_deref() {
                                                                    warn!(symbol = %sig.symbol, warning, "Live entry filled with bracket warning");
                                                                }
                                                                last_entry_bar.insert(sig.symbol.clone(), current_bar);
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
                                                                self.persist_entry_execution(&pos, order_method, Some(&ack), entry_fee_bps, &sig.rationale, None).await;
                                                                open_meta.insert(sig.symbol.clone(), OpenPositionMeta {
                                                                    order_list_id: ack.order_list_id,
                                                                    algo_order_ids: ack.algo_order_ids.clone(),
                                                                    entry_fee_bps,
                                                                });
                                                                info!(symbol = %pos.symbol, side = ?pos.side, entry = pos.entry_price, adx = ?sig.adx, rsi = ?sig.rsi, signal_ts = %sig.timestamp, rationale = %sig.rationale, "Opened live position");
                                                                open_positions.insert(sig.symbol, pos);
                                                            }
                                                        }
                                                        Err(err) => {
                                                            warn!(symbol = %sig.symbol, %err, "Live entry rejected");
                                                        }
                                                    }
                                                } else {
                                                    let crosses_book = is_limit
                                                        && limit_px.is_some_and(|lp| match sig.side {
                                                            Side::Long => lp >= sig.entry_price,
                                                            Side::Short => lp <= sig.entry_price,
                                                        });
                                                    let tif_upper = self.cfg.automation.time_in_force.to_uppercase();
                                                    if order_method == OrderExecutionMethod::LimitMaker && crosses_book {
                                                        warn!(symbol = %sig.symbol, "Paper auto LIMIT_MAKER rejected: would cross book");
                                                    } else if !crosses_book
                                                        && order_method == OrderExecutionMethod::Limit
                                                        && matches!(tif_upper.as_str(), "IOC" | "FOK")
                                                    {
                                                        warn!(symbol = %sig.symbol, tif = %tif_upper, "Paper auto LIMIT order expired unfilled");
                                                    } else if is_limit && !crosses_book {
                                                        if let Some(lp) = limit_px {
                                                            let oid = format!("paper-lim-{}-{}", sig.symbol, ev.received_at.timestamp_millis());
                                                            let entry_fee_bps = self.effective_fee_bps(order_method == OrderExecutionMethod::LimitMaker);
                                                            let pend_pos = Position {
                                                                id: oid.clone(),
                                                                symbol: sig.symbol.clone(),
                                                                side: sig.side,
                                                                entry_price: lp,
                                                                quantity: qty,
                                                                remaining_quantity: qty,
                                                                unrealized_pnl_usdt: 0.0,
                                                                realized_pnl_usdt: 0.0,
                                                                highest_favorable_price: lp,
                                                                exit_plan: plan.clone(),
                                                                opened_at: ev.received_at,
                                                            };
                                                            self.persist_entry_execution(&pend_pos, order_method, None, entry_fee_bps, &sig.rationale, Some("NEW")).await;
                                                            pending_orders.insert(sig.symbol.clone(), PendingOrderState {
                                                                order_id: oid,
                                                                symbol: sig.symbol.clone(),
                                                                side: sig.side,
                                                                order_method,
                                                                quantity: qty,
                                                                limit_price: lp,
                                                                take_profit_price: if self.cfg.features.take_profit_ladder { Some(plan.take_profit_2) } else { None },
                                                                stop_loss_price: Some(plan.initial_stop_loss),
                                                                reduce_only: false,
                                                                atr: sig.atr,
                                                                exit_plan: plan,
                                                                rationale: sig.rationale.clone(),
                                                                bar_idx: current_bar,
                                                                is_live: false,
                                                                is_manual: false,
                                                                created_at: ev.received_at,
                                                            });
                                                            info!(symbol = %sig.symbol, limit = lp, adx = ?sig.adx, rsi = ?sig.rsi, signal_ts = %sig.timestamp, "Placed paper resting limit order");
                                                        }
                                                    } else {
                                                        let entry_fee_bps = self.effective_fee_bps(false);
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
                                                        self.persist_entry_execution(&pos, order_method, None, entry_fee_bps, &sig.rationale, None).await;
                                                        open_meta.insert(sig.symbol.clone(), OpenPositionMeta {
                                                            order_list_id: None,
                                                            algo_order_ids: Vec::new(),
                                                            entry_fee_bps,
                                                        });
                                                        info!(symbol = %pos.symbol, side = ?pos.side, entry = pos.entry_price, adx = ?sig.adx, rsi = ?sig.rsi, signal_ts = %sig.timestamp, rationale = %sig.rationale, "Opened position");
                                                        open_positions.insert(sig.symbol, pos);
                                                    }
                                                }
                                            } else {
                                                warn!(symbol = %sig.symbol, "Entry blocked by negative Kelly or <$10 notional filter");
                                            }
                                        }
                                        Err(err) => warn!(symbol = %sig.symbol, %err, "Entry blocked by risk manager"),
                                    }
                                }
                            }
                        }
                    }

                    recent_trades.truncate(100);
                    self.publish_snapshot(running, &risk, &last_prices, &pipelines, &open_positions, &pending_orders, &bar_index, &recent_trades, &recent_volatility_alerts).await;
                }
                else => break,
            }
        }
        Ok(())
    }

    fn calc_net_pnl_with_fees(
        side: Side,
        entry: f64,
        exit: f64,
        qty: f64,
        entry_fee_bps: f64,
        exit_fee_bps: f64,
    ) -> f64 {
        let gross = match side {
            Side::Long => (exit - entry) * qty,
            Side::Short => (entry - exit) * qty,
        };
        let entry_fee = entry * qty * (entry_fee_bps.max(0.0) / 10_000.0);
        let exit_fee = exit * qty * (exit_fee_bps.max(0.0) / 10_000.0);
        gross - entry_fee - exit_fee
    }

    async fn flatten_all_positions(
        &self,
        open_positions: &mut HashMap<String, Position>,
        open_meta: &mut HashMap<String, OpenPositionMeta>,
        pending_orders: &mut HashMap<String, PendingOrderState>,
        last_prices: &HashMap<String, f64>,
        recent_trades: &mut Vec<ClosedTrade>,
        risk: &mut RiskManager,
    ) -> usize {
        let now = Utc::now();
        let mut closed_count = 0usize;
        for (sym, pend) in pending_orders.drain() {
            let mut promoted_fill: Option<(f64, f64)> = None;
            if self.is_live_armed() && pend.is_live {
                if let Ok(oid_num) = pend.order_id.parse::<i64>() {
                    match self.gateway.cancel_single_order(&sym, oid_num).await {
                        Ok(CancelOrderOutcome::AlreadyFilled(st)) => {
                            let qty = if st.executed_qty > 0.0 { st.executed_qty } else { pend.quantity };
                            let px = if st.avg_price > 0.0 { st.avg_price } else { pend.limit_price };
                            promoted_fill = Some((qty, px));
                        }
                        Ok(CancelOrderOutcome::Canceled) => {}
                        Err(err) => {
                            warn!(symbol = %sym, %err, "Flatten single pending cancel failed; falling back to cancel_open_orders");
                            let _ = self.gateway.cancel_open_orders(&sym).await;
                        }
                    }
                } else {
                    let _ = self.gateway.cancel_open_orders(&sym).await;
                }
            }
            if let Some((fill_qty, fill_px)) = promoted_fill {
                if pend.reduce_only {
                    if let Some(pos) = open_positions.get_mut(&sym) {
                        let closed_qty = fill_qty.min(pos.remaining_quantity);
                        let entry_fee_bps = open_meta
                            .get(&sym)
                            .map(|m| m.entry_fee_bps)
                            .unwrap_or_else(|| self.effective_fee_bps(false));
                        let exit_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                        let pnl = Self::calc_net_pnl_with_fees(
                            pos.side,
                            pos.entry_price,
                            fill_px,
                            closed_qty,
                            entry_fee_bps,
                            exit_fee_bps,
                        );
                        let r_mult = pnl / (pos.exit_plan.risk_distance_r * closed_qty).max(1e-9);
                        risk.record_realized_pnl(&sym, pnl, now);
                        let closed_part = ClosedTrade {
                            id: format!("{}-flat-red", pos.id),
                            symbol: sym.clone(),
                            side: pos.side,
                            entry_price: pos.entry_price,
                            exit_price: fill_px,
                            quantity: closed_qty,
                            pnl_usdt: pnl,
                            r_multiple: r_mult,
                            reason: ExitReason::ManualClose,
                            closed_at: now,
                        };
                        self.persist_trade_execution(
                            &closed_part,
                            exit_fee_bps,
                            Some(&pend.order_id),
                            None,
                            None,
                            pend.order_method == OrderExecutionMethod::LimitMaker,
                        )
                        .await;
                        recent_trades.insert(0, closed_part);
                        pos.remaining_quantity = (pos.remaining_quantity - closed_qty).max(0.0);
                        pos.realized_pnl_usdt += pnl;
                        if pos.remaining_quantity <= 1e-8 {
                            open_positions.remove(&sym);
                            open_meta.remove(&sym);
                            closed_count += 1;
                        }
                    }
                } else if let std::collections::hash_map::Entry::Vacant(slot) = open_positions.entry(sym) {
                    let sym_key = slot.key().clone();
                    let entry_fee_bps = self.effective_fee_bps(pend.order_method == OrderExecutionMethod::LimitMaker);
                    let pos = Position {
                        id: format!("{}-flat-prom-{}", sym_key, now.timestamp_millis()),
                        symbol: sym_key.clone(),
                        side: pend.side,
                        entry_price: fill_px,
                        quantity: fill_qty,
                        remaining_quantity: fill_qty,
                        unrealized_pnl_usdt: 0.0,
                        realized_pnl_usdt: 0.0,
                        highest_favorable_price: fill_px,
                        exit_plan: pend.exit_plan.clone(),
                        opened_at: now,
                    };
                    open_meta.insert(
                        sym_key,
                        OpenPositionMeta {
                            order_list_id: None,
                            algo_order_ids: Vec::new(),
                            entry_fee_bps,
                        },
                    );
                    slot.insert(pos);
                }
            } else {
                self.mark_pending_order_canceled_async(&sym, &pend.order_id, "CircuitBreaker FlattenAll canceled pending limit").await;
            }
        }
        let drained: Vec<(String, Position)> = open_positions.drain().collect();
        for (sym, pos) in drained {
            let meta = open_meta.remove(&sym);
            let mut px = last_prices.get(&sym).copied().unwrap_or(pos.entry_price);
            let qty = pos.remaining_quantity;
            let mut close_oid: Option<String> = None;
            let mut close_aid: Option<i64> = None;
            if self.is_live_armed() {
                if let Some((reconciled_px, aid)) = self
                    .detect_exchange_already_closed(&sym, &pos, meta.as_ref(), px)
                    .await
                {
                    px = reconciled_px;
                    close_aid = aid;
                } else {
                    let _ = self
                        .gateway
                        .cancel_open_brackets(&sym, meta.as_ref().and_then(|m| m.order_list_id))
                        .await;
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
                    match self.gateway.execute_live_order(&req).await {
                        Ok(ack) => {
                            if ack.avg_price > 0.0 {
                                px = ack.avg_price;
                            }
                            close_oid = ack.order_id;
                        }
                        Err(err) => {
                            warn!(symbol = %sym, %err, "Flatten live close failed; retaining position in local map");
                            if let Some(m) = meta {
                                open_meta.insert(sym.clone(), m);
                            }
                            open_positions.insert(sym, pos);
                            continue;
                        }
                    }
                }
            }
            let entry_fee_bps = meta
                .as_ref()
                .map(|m| m.entry_fee_bps)
                .unwrap_or_else(|| self.effective_fee_bps(false));
            let exit_fee_bps = self.effective_fee_bps(false);
            let pnl = Self::calc_net_pnl_with_fees(
                pos.side,
                pos.entry_price,
                px,
                qty,
                entry_fee_bps,
                exit_fee_bps,
            );
            let r_mult = pnl / (pos.exit_plan.risk_distance_r * qty).max(1e-9);
            risk.record_realized_pnl(&sym, pnl, now);
            let closed_flat = ClosedTrade {
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
            };
            self.persist_trade_execution(
                &closed_flat,
                exit_fee_bps,
                close_oid.as_deref(),
                close_aid,
                None,
                false,
            )
            .await;
            recent_trades.insert(0, closed_flat);
            closed_count += 1;
        }
        closed_count
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

        // Adding a partial "-tp1" winner must not pollute full-trade Kelly win-rate when full trades are negative EV.
        let mut with_tp1_partials = losing_trades;
        for idx in 1..=3 {
            with_tp1_partials.push(ClosedTrade {
                id: format!("pos-{idx}-tp1"),
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                entry_price: 100.0,
                exit_price: 103.0,
                quantity: 0.5,
                pnl_usdt: 1.5,
                r_multiple: 1.5,
                reason: ExitReason::TakeProfit1,
                closed_at: Utc::now(),
            });
        }
        assert!(engine.compute_position_quantity(&with_tp1_partials, 10_000.0, 100.0, 98.0, 1.0).is_none());
    }

    #[test]
    fn futures_fee_scaling_and_diversification_match_frontend() {
        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.exchange.venue = ExchangeVenue::Futures;
        cfg.trading.taker_fee_bps = 10.0;
        let engine = TradingEngine::new(cfg).unwrap();
        assert!((engine.effective_fee_bps(false) - 4.0).abs() < 1e-9);
        assert!((engine.effective_fee_bps(true) - 2.0).abs() < 1e-9);

        let mut hist = HashMap::new();
        let make_c = |t: i64, p: f64| Candle {
            open_time_ms: t,
            open: p,
            high: p,
            low: p,
            close: p,
            volume: 100.0,
            is_closed: true,
        };
        hist.insert(
            "BTCUSDT".into(),
            vec![make_c(1, 100.0), make_c(2, 102.0), make_c(3, 105.0), make_c(4, 107.0)],
        );
        hist.insert(
            "ETHUSDT".into(),
            vec![make_c(1, 50.0), make_c(2, 51.0), make_c(3, 52.5), make_c(4, 53.5)],
        );
        let div = TradingEngine::compute_portfolio_diversification_multiplier(
            &hist,
            &["BTCUSDT".into(), "ETHUSDT".into()],
        );
        assert!(div > 0.49 && div < 0.6, "correlated assets should scale Kelly ~0.5: {div}");
    }

    #[test]
    fn position_side_str_honors_futures_hedge_mode_vs_one_way() {
        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.exchange.venue = ExchangeVenue::Futures;
        let engine = TradingEngine::new(cfg).unwrap();
        assert_eq!(engine.position_side_str(Side::Long), "BOTH");
        assert_eq!(engine.position_side_str(Side::Short), "BOTH");

        engine.futures_hedge_mode.store(true, Ordering::Relaxed);
        assert_eq!(engine.position_side_str(Side::Long), "LONG");
        assert_eq!(engine.position_side_str(Side::Short), "SHORT");
    }

    #[tokio::test]
    async fn manual_paper_limit_resting_post_only_and_reduce_only_lifecycle() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mock_srv = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let body = if req.contains("/klines") {
                        r#"[[1763280000000,"50000.0","50100.0","49900.0","50000.0","100.0",1763280299999,"5000000.0",10,"50.0","2500000.0","0"]]"#
                    } else if req.contains("/ticker/price") {
                        r#"{"symbol":"BTCUSDT","price":"50000.0"}"#
                    } else {
                        "{}"
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });

        let tmp_db = std::env::temp_dir().join("apexrust-engine-manual-lifecycle-test.sqlite");
        let _ = std::fs::remove_file(&tmp_db);
        std::env::set_var("APEXRUST_ORDER_DB_PATH", &tmp_db);

        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.exchange.venue = ExchangeVenue::Futures;
        cfg.exchange.rest_base_url = format!("http://{addr}");
        cfg.trading.pairs = vec!["BTCUSDT".into()];
        cfg.trading.pair_selection_mode = PairSelectionMode::Static;
        cfg.features.ws_primary_feed = false;
        cfg.features.rest_fallback = false;
        cfg.automation.enabled = false;

        let engine = Arc::new(TradingEngine::new(cfg).unwrap());
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let eng_task = tokio::spawn({
            let eng = Arc::clone(&engine);
            async move { eng.run(cmd_rx).await }
        });

        // 1. Passive LIMIT Long below market ($48,000 vs $50,000) must rest as NEW (not fill immediately!)
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ManualOrder {
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                notional_usdt: 500.0,
                order_method: OrderExecutionMethod::Limit,
                limit_price: Some(48_000.0),
                take_profit_price: None,
                stop_loss_price: None,
                reduce_only: false,
                reply: Some(rtx),
            })
            .await
            .unwrap();
        let lim_res = rrx.await.unwrap().unwrap();
        assert_eq!(lim_res["status"], serde_json::json!("NEW"));
        assert_eq!(engine.latest_snapshot_handle().read().await.pending_orders.len(), 1);

        // 2. Cancel resting pending order via ClosePosition
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ClosePosition {
                symbol: "BTCUSDT".into(),
                reply: Some(rtx),
            })
            .await
            .unwrap();
        let cancel_res = rrx.await.unwrap().unwrap();
        assert_eq!(cancel_res["canceledPending"], serde_json::json!("BTCUSDT"));
        assert!(engine.latest_snapshot_handle().read().await.pending_orders.is_empty());

        // 3. Crossing LIMIT_MAKER Long ($51,000 >= $50,000) must be rejected
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ManualOrder {
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                notional_usdt: 500.0,
                order_method: OrderExecutionMethod::LimitMaker,
                limit_price: Some(51_000.0),
                take_profit_price: None,
                stop_loss_price: None,
                reduce_only: false,
                reply: Some(rtx),
            })
            .await
            .unwrap();
        assert!(rrx.await.unwrap().is_err(), "Crossing LIMIT_MAKER must be rejected");

        // 4. Open MARKET Long ($1000) and verify reduce_only partial & full close update snapshot immediately
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ManualOrder {
                symbol: "BTCUSDT".into(),
                side: Side::Long,
                notional_usdt: 1000.0,
                order_method: OrderExecutionMethod::Market,
                limit_price: None,
                take_profit_price: None,
                stop_loss_price: None,
                reduce_only: false,
                reply: Some(rtx),
            })
            .await
            .unwrap();
        assert_eq!(rrx.await.unwrap().unwrap()["status"], serde_json::json!("FILLED"));
        let qty_open = engine
            .latest_snapshot_handle()
            .read()
            .await
            .pairs
            .iter()
            .find(|p| p.symbol == "BTCUSDT")
            .and_then(|p| p.open_position.as_ref())
            .unwrap()
            .remaining_quantity;
        assert!((qty_open - 0.02).abs() < 1e-6);

        // Partial reduce_only ($400 of $1000)
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ManualOrder {
                symbol: "BTCUSDT".into(),
                side: Side::Short,
                notional_usdt: 400.0,
                order_method: OrderExecutionMethod::Market,
                limit_price: None,
                take_profit_price: None,
                stop_loss_price: None,
                reduce_only: true,
                reply: Some(rtx),
            })
            .await
            .unwrap();
        let partial_res = rrx.await.unwrap().unwrap();
        assert_eq!(partial_res["status"], serde_json::json!("FILLED"));
        assert_eq!(partial_res["reduceOnly"], serde_json::json!(true));
        let qty_after = engine
            .latest_snapshot_handle()
            .read()
            .await
            .pairs
            .iter()
            .find(|p| p.symbol == "BTCUSDT")
            .and_then(|p| p.open_position.as_ref())
            .unwrap()
            .remaining_quantity;
        assert!((qty_after - 0.012).abs() < 1e-6);

        // Full reduce_only close remaining
        let (rtx, rrx) = oneshot::channel();
        cmd_tx
            .send(EngineCommand::ManualOrder {
                symbol: "BTCUSDT".into(),
                side: Side::Short,
                notional_usdt: 1000.0,
                order_method: OrderExecutionMethod::Market,
                limit_price: None,
                take_profit_price: None,
                stop_loss_price: None,
                reduce_only: true,
                reply: Some(rtx),
            })
            .await
            .unwrap();
        let full_res = rrx.await.unwrap().unwrap();
        assert_eq!(full_res["status"], serde_json::json!("FILLED"));
        assert_eq!(full_res["reduceOnly"], serde_json::json!(true));
        let closed_pos = engine
            .latest_snapshot_handle()
            .read()
            .await
            .pairs
            .iter()
            .find(|p| p.symbol == "BTCUSDT")
            .and_then(|p| p.open_position.clone());
        assert!(closed_pos.is_none());
        assert_eq!(engine.latest_snapshot_handle().read().await.recent_trades.len(), 2);

        let _ = cmd_tx.send(EngineCommand::Shutdown).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), eng_task).await;
        mock_srv.abort();
        let _ = std::fs::remove_file(&tmp_db);
    }
}
