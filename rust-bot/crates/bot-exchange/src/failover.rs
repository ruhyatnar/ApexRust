use crate::{
    BinanceFuturesClient, BinanceRestClient, BinanceWsDriver, CancelOrderOutcome,
    ExchangeOpenPosition, ExchangeOrderStatus, LiveOrderAck, LiveOrderRequest, RestRateBudget,
    WsApiClient, WsStreamEvent,
};
use bot_core::{
    Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent, MarketTicker24h,
    Result, TransportMode, TrendingRankingSource,
};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, RwLock};
use tracing::{error, info, warn};

const EXCHANGE_INFO_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

fn parse_ws_api_ack(result: &serde_json::Value, req: &LiveOrderRequest) -> LiveOrderAck {
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("NEW")
        .to_string();
    let parse_num = |key: &str| -> f64 {
        result
            .get(key)
            .and_then(|v| v.as_str().map(str::to_string).or_else(|| Some(v.to_string())))
            .and_then(|s| s.trim_matches('"').parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let executed_qty = parse_num("executedQty");
    let avg_price = {
        let reported = parse_num("avgPrice");
        if reported > 0.0 {
            reported
        } else {
            req.limit_price.unwrap_or(0.0)
        }
    };
    LiveOrderAck {
        order_id: result.get("orderId").map(|v| v.to_string()),
        order_list_id: result.get("orderListId").and_then(|v| v.as_i64()),
        algo_order_ids: Vec::new(),
        bracket_warning: None,
        filled: status == "FILLED",
        executed_qty: if executed_qty > 0.0 { executed_qty } else { req.quantity },
        avg_price,
        status,
    }
}

#[derive(Debug, Clone)]
pub struct FailoverHealth {
    pub mode: TransportMode,
    pub failover_count: u64,
    pub last_ws_age_ms: u64,
}

/// Coordinates primary WebSocket streaming, live `SUBSCRIBE`/`UNSUBSCRIBE` watchlist diffs,
/// seamless adaptive REST polling fallback, and authenticated Spot/Futures order dispatch.
type TradableSymbolsCache = Arc<RwLock<Option<(HashSet<String>, Instant)>>>;

pub struct FailoverGateway {
    cfg: ExchangeConfig,
    pairs: Arc<RwLock<Vec<String>>>,
    pairs_tx: watch::Sender<Vec<String>>,
    timeframe: String,
    ws_primary_enabled: bool,
    rest_fallback_enabled: bool,
    rest: Arc<BinanceRestClient>,
    futures: Arc<BinanceFuturesClient>,
    rate_budget: Arc<RestRateBudget>,
    tradable_cache: TradableSymbolsCache,
    mode: Arc<RwLock<TransportMode>>,
    failover_count: Arc<AtomicU64>,
    last_ws_epoch_ms: Arc<AtomicU64>,
    screener_stream_connected: Arc<AtomicBool>,
    ws_api: Option<Arc<WsApiClient>>,
}

impl FailoverGateway {
    pub fn new_with_toggles(
        cfg: ExchangeConfig,
        pairs: Vec<String>,
        timeframe: String,
        ws_primary_enabled: bool,
        rest_fallback_enabled: bool,
    ) -> Result<Self> {
        let rate_budget = Arc::new(RestRateBudget::default());
        let rest = Arc::new(BinanceRestClient::new_with_budget(
            cfg.clone(),
            Arc::clone(&rate_budget),
        )?);
        let futures = Arc::new(BinanceFuturesClient::new_with_budget(
            cfg.clone(),
            Arc::clone(&rate_budget),
        )?);
        let initial_mode = if ws_primary_enabled {
            TransportMode::WsPrimary
        } else if rest_fallback_enabled {
            TransportMode::RestFallback
        } else {
            TransportMode::Reconnecting
        };
        let ws_api = WsApiClient::from_config(&cfg)?.map(Arc::new);
        let norm_pairs: Vec<String> = pairs
            .into_iter()
            .map(|p| p.trim().to_uppercase())
            .filter(|p| !p.is_empty())
            .collect();
        let (pairs_tx, _pairs_rx) = watch::channel(norm_pairs.clone());
        Ok(Self {
            cfg,
            pairs: Arc::new(RwLock::new(norm_pairs)),
            pairs_tx,
            timeframe,
            ws_primary_enabled,
            rest_fallback_enabled,
            rest,
            futures,
            rate_budget,
            tradable_cache: Arc::new(RwLock::new(None)),
            mode: Arc::new(RwLock::new(initial_mode)),
            failover_count: Arc::new(AtomicU64::new(0)),
            last_ws_epoch_ms: Arc::new(AtomicU64::new(0)),
            screener_stream_connected: Arc::new(AtomicBool::new(false)),
            ws_api,
        })
    }

    pub async fn update_watchlist(&self, new_pairs: Vec<String>) {
        let mut seen = HashSet::new();
        let clean: Vec<String> = new_pairs
            .into_iter()
            .map(|p| p.trim().to_uppercase())
            .filter(|p| !p.is_empty() && seen.insert(p.clone()))
            .collect();
        *self.pairs.write().await = clean.clone();
        let _ = self.pairs_tx.send(clean);
    }

    pub fn used_weight_1m(&self) -> u64 {
        self.rate_budget.used_weight()
    }

    pub fn is_rate_constrained(&self) -> bool {
        self.rate_budget.is_constrained(self.cfg.venue)
    }

    pub fn is_screener_connected(&self) -> bool {
        self.screener_stream_connected.load(Ordering::Relaxed)
    }

    pub async fn fetch_klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
    ) -> Result<Vec<Candle>> {
        match self.cfg.venue {
            ExchangeVenue::Futures => {
                self.futures.fetch_futures_klines(symbol, interval, limit).await
            }
            ExchangeVenue::Spot => self.rest.fetch_klines(symbol, interval, limit).await,
        }
    }

    pub async fn poll_latest_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        match self.cfg.venue {
            ExchangeVenue::Futures => {
                self.futures.poll_latest_futures_bar(symbol, interval).await
            }
            ExchangeVenue::Spot => self.rest.poll_latest_bar(symbol, interval).await,
        }
    }

    pub async fn execute_live_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
        let ref_px = if let Some(px) = req.limit_price.filter(|&p| p.is_finite() && p > 0.0) {
            px
        } else if let Some(q) = req
            .quote_order_qty
            .filter(|&q| q.is_finite() && q > 0.0 && req.quantity > 0.0)
        {
            q / req.quantity
        } else {
            self.fetch_ticker_price(&req.symbol).await.unwrap_or(0.0)
        };
        crate::validate_live_safety(&self.cfg, self.cfg.venue, req, ref_px)?;

        // WebSocket API entry path: only bare entries without bracket legs or
        // preflight test-order requirement, so protective SL/TP or preflight is never bypassed.
        let require_preflight = self
            .cfg
            .credentials
            .as_ref()
            .is_some_and(|c| c.require_preflight_test_order);
        if let Some(ws_api) = self.ws_api.as_ref() {
            if !require_preflight
                && !req.reduce_only
                && req.take_profit_price.is_none()
                && req.stop_loss_price.is_none()
            {
                let params = match self.cfg.venue {
                    ExchangeVenue::Futures => self.futures.build_ws_order_params(req).await,
                    ExchangeVenue::Spot => self.rest.build_ws_order_params(req).await,
                };
                match params {
                    Ok(params) => match ws_api.place_order(params).await {
                        Ok(result) => {
                            info!(symbol = %req.symbol, "Order placed via Binance WebSocket API");
                            return Ok(parse_ws_api_ack(&result, req));
                        }
                        Err(err) => {
                            warn!(symbol = %req.symbol, %err, "WS API order failed; falling back to REST");
                        }
                    },
                    Err(err) => {
                        warn!(symbol = %req.symbol, %err, "WS API param build failed; using REST");
                    }
                }
            }
        }
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.execute_futures_order(req).await,
            ExchangeVenue::Spot => self.rest.execute_spot_order(req).await,
        }
    }

    pub async fn cancel_open_brackets(
        &self,
        symbol: &str,
        order_list_id: Option<i64>,
    ) -> Result<()> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.cancel_futures_algo_orders(symbol).await,
            ExchangeVenue::Spot => {
                if let Some(list_id) = order_list_id {
                    self.rest.cancel_spot_oco(symbol, list_id).await
                } else {
                    Ok(())
                }
            }
        }
    }

    pub async fn cancel_open_orders(&self, symbol: &str) -> Result<()> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.cancel_futures_open_orders(symbol).await,
            ExchangeVenue::Spot => self.rest.cancel_spot_open_orders(symbol).await,
        }
    }

    pub async fn cancel_single_order(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<CancelOrderOutcome> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.cancel_futures_order(symbol, order_id).await,
            ExchangeVenue::Spot => self.rest.cancel_spot_order(symbol, order_id).await,
        }
    }

    pub async fn is_futures_hedge_mode(&self) -> bool {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.is_hedge_mode().await,
            ExchangeVenue::Spot => false,
        }
    }

    pub async fn fetch_tradable_symbols(&self) -> Result<HashSet<String>> {
        {
            let guard = self.tradable_cache.read().await;
            if let Some((ref set, fetched_at)) = *guard {
                if fetched_at.elapsed() < EXCHANGE_INFO_CACHE_TTL && !set.is_empty() {
                    return Ok(set.clone());
                }
            }
        }
        if self.is_rate_constrained() {
            if let Some((ref set, _)) = *self.tradable_cache.read().await {
                return Ok(set.clone());
            }
        }
        let fetched = match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.fetch_futures_tradable_symbols().await?,
            ExchangeVenue::Spot => self.rest.fetch_spot_tradable_symbols().await?,
        };
        if !fetched.is_empty() {
            *self.tradable_cache.write().await = Some((fetched.clone(), Instant::now()));
        }
        Ok(fetched)
    }

    pub async fn fetch_ticker_24h_seed_once(
        &self,
        prod_ranking: bool,
    ) -> Result<Vec<MarketTicker24h>> {
        let custom_base = match (self.cfg.venue, prod_ranking) {
            (ExchangeVenue::Futures, true) => Some("https://fapi.binance.com"),
            (ExchangeVenue::Spot, true) => Some("https://api.binance.com"),
            _ => None,
        };
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.fetch_futures_ticker_24h_all(custom_base).await,
            ExchangeVenue::Spot => self.rest.fetch_spot_ticker_24h_all(custom_base).await,
        }
    }

    pub async fn fetch_ticker_price(&self, symbol: &str) -> Result<f64> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.fetch_futures_ticker_price(symbol).await,
            ExchangeVenue::Spot => self.rest.fetch_spot_ticker_price(symbol).await,
        }
    }

    pub async fn query_order_status(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<ExchangeOrderStatus> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.query_futures_order_status(symbol, order_id).await,
            ExchangeVenue::Spot => self.rest.query_spot_order_status(symbol, order_id).await,
        }
    }

    pub async fn query_futures_algo_order_status(
        &self,
        algo_id: i64,
    ) -> Result<ExchangeOrderStatus> {
        self.futures.query_futures_algo_order_status(algo_id).await
    }

    pub async fn get_spot_open_orders(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<ExchangeOrderStatus>> {
        self.rest.get_spot_open_orders(symbol).await
    }

    pub async fn get_spot_free_balance(&self, asset: &str) -> Result<f64> {
        self.rest.get_spot_free_balance(asset).await
    }

    pub async fn get_futures_positions(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<ExchangeOpenPosition>> {
        self.futures.get_futures_positions(symbol).await
    }

    pub async fn get_futures_open_algo_orders(&self, symbol: Option<&str>) -> Result<Vec<i64>> {
        self.futures.get_futures_open_algo_orders(symbol).await
    }

    pub async fn health(&self) -> FailoverHealth {
        let mode = *self.mode.read().await;
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let last = self.last_ws_epoch_ms.load(Ordering::Relaxed);
        let age = if last == 0 {
            0
        } else {
            now_ms.saturating_sub(last)
        };
        FailoverHealth {
            mode,
            failover_count: self.failover_count.load(Ordering::Relaxed),
            last_ws_age_ms: age,
        }
    }

    /// Spawns reactive combined WS (`@kline_<tf>`, `@bookTicker`, `!miniTicker@arr`),
    /// optional Production `!miniTicker@arr` screener stream on Testnet, and adaptive REST fallback.
    pub fn spawn_with_events(
        self: Arc<Self>,
        tx: mpsc::Sender<WsStreamEvent>,
        ranking_source: TrendingRankingSource,
    ) {
        let use_prod_screener = matches!(
            ranking_source,
            TrendingRankingSource::Auto | TrendingRankingSource::Production
        ) && self.cfg.environment == ExchangeEnvironment::Testnet;

        if self.ws_primary_enabled {
            let ws_tx = tx.clone();
            let gw_ws = Arc::clone(&self);
            tokio::spawn(async move {
                let mut pairs_rx = gw_ws.pairs_tx.subscribe();
                let mut backoff_ms = gw_ws.cfg.ws_reconnect_initial_ms;
                let (inner_tx, mut inner_rx) = mpsc::channel::<WsStreamEvent>(1024);

                let gw_fwd = Arc::clone(&gw_ws);
                let fwd_tx = ws_tx.clone();
                tokio::spawn(async move {
                    while let Some(ev) = inner_rx.recv().await {
                        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                        gw_fwd.last_ws_epoch_ms.store(now_ms, Ordering::Relaxed);
                        {
                            let mut m = gw_fwd.mode.write().await;
                            if *m != TransportMode::WsPrimary {
                                info!("WebSocket recovered; promoting transport back to WsPrimary");
                                *m = TransportMode::WsPrimary;
                            }
                        }
                        if matches!(ev, WsStreamEvent::MiniTickerAll(_)) {
                            gw_fwd.screener_stream_connected.store(true, Ordering::Relaxed);
                        }
                        if fwd_tx.send(ev).await.is_err() {
                            break;
                        }
                    }
                });

                loop {
                    gw_ws.last_ws_epoch_ms.store(0, Ordering::Relaxed);
                    let started = Instant::now();
                    let driver = BinanceWsDriver::new(gw_ws.cfg.clone(), gw_ws.timeframe.clone());
                    let tx_copy = inner_tx.clone();
                    let mut rx_clone = pairs_rx.clone();
                    let include_mini_main = !use_prod_screener;

                    let mut ws_task = tokio::spawn(async move {
                        driver
                            .run_reactive_once(&mut rx_clone, &tx_copy, include_mini_main)
                            .await
                    });

                    let heartbeat_timeout =
                        Duration::from_millis(gw_ws.cfg.ws_heartbeat_timeout_ms.max(1000));
                    let mut watchdog = tokio::time::interval(Duration::from_millis(1000));
                    watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

                    let run_res = loop {
                        tokio::select! {
                            res = &mut ws_task => {
                                break res.unwrap_or_else(|e| Err(bot_core::BotError::WebSocket(format!("WS task aborted: {e}"))));
                            }
                            _ = watchdog.tick() => {
                                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                                let last = gw_ws.last_ws_epoch_ms.load(Ordering::Relaxed);
                                let stalled = if last == 0 {
                                    started.elapsed() > heartbeat_timeout
                                } else {
                                    now_ms.saturating_sub(last) > heartbeat_timeout.as_millis() as u64
                                };
                                if stalled {
                                    warn!("WebSocket heartbeat stalled; aborting socket for reconnect");
                                    ws_task.abort();
                                    break Err(bot_core::BotError::WebSocket("Heartbeat stalled".into()));
                                }
                            }
                        }
                    };

                    // Advance watch version in case pairs changed while reconnecting
                    let _ = pairs_rx.borrow_and_update();

                    match run_res {
                        Ok(()) => {
                            backoff_ms = gw_ws.cfg.ws_reconnect_initial_ms;
                        }
                        Err(e) => {
                            warn!(error = %e, "WebSocket disconnected; engaging REST fallback");
                            if !use_prod_screener {
                                gw_ws.screener_stream_connected.store(false, Ordering::Relaxed);
                            }
                            gw_ws.engage_rest_fallback().await;
                            if started.elapsed() > Duration::from_secs(60) {
                                backoff_ms = gw_ws.cfg.ws_reconnect_initial_ms;
                            }
                            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                            backoff_ms = (backoff_ms * 2).min(gw_ws.cfg.ws_reconnect_max_ms);
                        }
                    }
                }
            });

            if use_prod_screener {
                let gw_sc = Arc::clone(&self);
                let sc_tx = tx.clone();
                let (prod_tx, mut prod_rx) = mpsc::channel::<WsStreamEvent>(256);
                let gw_sc_flag = Arc::clone(&self);
                tokio::spawn(async move {
                    while let Some(ev) = prod_rx.recv().await {
                        if matches!(ev, WsStreamEvent::MiniTickerAll(_)) {
                            gw_sc_flag
                                .screener_stream_connected
                                .store(true, Ordering::Relaxed);
                        }
                        if sc_tx.send(ev).await.is_err() {
                            break;
                        }
                    }
                });
                tokio::spawn(async move {
                    let mut backoff = Duration::from_secs(1);
                    loop {
                        match BinanceWsDriver::run_mini_ticker_once(
                            gw_sc.cfg.venue,
                            ExchangeEnvironment::Production,
                            &prod_tx,
                        )
                        .await
                        {
                            Ok(()) => {
                                backoff = Duration::from_secs(1);
                            }
                            Err(_) => {
                                gw_sc
                                    .screener_stream_connected
                                    .store(false, Ordering::Relaxed);
                                tokio::time::sleep(backoff).await;
                                backoff = (backoff * 2).min(Duration::from_secs(30));
                            }
                        }
                    }
                });
            }
        }

        if self.rest_fallback_enabled {
            let gw_rest = Arc::clone(&self);
            tokio::spawn(async move {
                let mut consecutive_failures: u32 = 0;

                loop {
                    let active_pairs = gw_rest.pairs.read().await.clone();
                    let count_factor = ((active_pairs.len().max(1) as f64) / 6.0).max(1.0);
                    let weight_factor = if gw_rest.is_rate_constrained() {
                        3.0
                    } else {
                        1.0
                    };
                    let poll_ms = ((gw_rest.cfg.rest_poll_interval_ms.max(250) as f64)
                        * count_factor
                        * weight_factor) as u64;
                    tokio::time::sleep(Duration::from_millis(poll_ms.clamp(1000, 30_000))).await;

                    if gw_rest.ws_primary_enabled {
                        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                        let last = gw_rest.last_ws_epoch_ms.load(Ordering::Relaxed);
                        let stale = last > 0
                            && now_ms.saturating_sub(last) > gw_rest.cfg.ws_heartbeat_timeout_ms;
                        if stale {
                            gw_rest.engage_rest_fallback().await;
                        }
                    } else {
                        let mut guard = gw_rest.mode.write().await;
                        if *guard == TransportMode::WsPrimary {
                            *guard = TransportMode::RestFallback;
                        }
                    }

                    let current_mode = *gw_rest.mode.read().await;
                    if matches!(
                        current_mode,
                        TransportMode::RestFallback | TransportMode::Reconnecting
                    ) {
                        let mut batch_ok = false;
                        for pair in &active_pairs {
                            if gw_rest.is_rate_constrained() {
                                break;
                            }
                            match gw_rest.poll_latest_bar(pair, &gw_rest.timeframe).await {
                                Ok(ev) => {
                                    batch_ok = true;
                                    if tx.send(WsStreamEvent::Candle(ev)).await.is_err() {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    error!(%pair, error = %e, "REST fallback poll failed");
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(120)).await;
                        }
                        if batch_ok {
                            consecutive_failures = 0;
                            let mut guard = gw_rest.mode.write().await;
                            if *guard == TransportMode::Reconnecting {
                                *guard = TransportMode::RestFallback;
                            }
                        } else {
                            consecutive_failures = consecutive_failures.saturating_add(1);
                            if gw_rest.cfg.max_consecutive_rest_failures > 0
                                && consecutive_failures >= gw_rest.cfg.max_consecutive_rest_failures
                            {
                                *gw_rest.mode.write().await = TransportMode::Reconnecting;
                            }
                        }
                    }
                }
            });
        }
    }

    async fn engage_rest_fallback(&self) {
        let mut guard = self.mode.write().await;
        if *guard == TransportMode::WsPrimary {
            *guard = TransportMode::RestFallback;
            self.failover_count.fetch_add(1, Ordering::Relaxed);
        }
    }
}
