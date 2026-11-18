use crate::{BinanceFuturesClient, BinanceRestClient, BinanceWsDriver, LiveOrderAck, LiveOrderRequest};
use bot_core::{Candle, ExchangeConfig, ExchangeVenue, MarketEvent, Result, TransportMode};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct FailoverHealth {
    pub mode: TransportMode,
    pub failover_count: u64,
    pub last_ws_age_ms: u64,
}

/// Coordinates primary WebSocket streaming, seamless REST polling fallback,
/// and authenticated Spot/Futures order dispatch via `binance-sdk`.
pub struct FailoverGateway {
    cfg: ExchangeConfig,
    pairs: Vec<String>,
    timeframe: String,
    ws_primary_enabled: bool,
    rest_fallback_enabled: bool,
    rest: Arc<BinanceRestClient>,
    futures: Arc<BinanceFuturesClient>,
    mode: Arc<RwLock<TransportMode>>,
    failover_count: Arc<AtomicU64>,
    last_ws_epoch_ms: Arc<AtomicU64>,
}

impl FailoverGateway {
    pub fn new_with_toggles(
        cfg: ExchangeConfig,
        pairs: Vec<String>,
        timeframe: String,
        ws_primary_enabled: bool,
        rest_fallback_enabled: bool,
    ) -> Result<Self> {
        let rest = Arc::new(BinanceRestClient::new(cfg.clone())?);
        let futures = Arc::new(BinanceFuturesClient::new(cfg.clone())?);
        let initial_mode = if ws_primary_enabled {
            TransportMode::WsPrimary
        } else if rest_fallback_enabled {
            TransportMode::RestFallback
        } else {
            TransportMode::Reconnecting
        };
        Ok(Self {
            cfg,
            pairs,
            timeframe,
            ws_primary_enabled,
            rest_fallback_enabled,
            rest,
            futures,
            mode: Arc::new(RwLock::new(initial_mode)),
            failover_count: Arc::new(AtomicU64::new(0)),
            last_ws_epoch_ms: Arc::new(AtomicU64::new(0)),
        })
    }

    pub async fn fetch_klines(&self, symbol: &str, interval: &str, limit: usize) -> Result<Vec<Candle>> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.fetch_futures_klines(symbol, interval, limit).await,
            ExchangeVenue::Spot => self.rest.fetch_klines(symbol, interval, limit).await,
        }
    }

    pub async fn poll_latest_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        match self.cfg.venue {
            ExchangeVenue::Futures => self.futures.poll_latest_futures_bar(symbol, interval).await,
            ExchangeVenue::Spot => self.rest.poll_latest_bar(symbol, interval).await,
        }
    }

    pub async fn execute_live_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
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

    pub async fn health(&self) -> FailoverHealth {
        let mode = *self.mode.read().await;
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let last = self.last_ws_epoch_ms.load(Ordering::Relaxed);
        let age = if last == 0 { 0 } else { now_ms.saturating_sub(last) };
        FailoverHealth {
            mode,
            failover_count: self.failover_count.load(Ordering::Relaxed),
            last_ws_age_ms: age,
        }
    }

    /// Spawn the WebSocket primary loop + Watchdog + REST fallback poller.
    pub fn spawn(self: Arc<Self>, tx: mpsc::Sender<MarketEvent>) {
        if self.ws_primary_enabled {
            let ws_tx = tx.clone();
            let gw_ws = Arc::clone(&self);
            tokio::spawn(async move {
                let driver = Arc::new(BinanceWsDriver::new(
                    gw_ws.cfg.clone(),
                    gw_ws.pairs.clone(),
                    gw_ws.timeframe.clone(),
                ));
                let mut backoff_ms = gw_ws.cfg.ws_reconnect_initial_ms;
                let (inner_tx, mut inner_rx) = mpsc::channel::<MarketEvent>(512);

                let gw_fwd = Arc::clone(&gw_ws);
                let fwd_tx = ws_tx.clone();
                tokio::spawn(async move {
                    while let Some(ev) = inner_rx.recv().await {
                        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                        gw_fwd.last_ws_epoch_ms.store(now_ms, Ordering::Relaxed);
                        let mut m = gw_fwd.mode.write().await;
                        if *m != TransportMode::WsPrimary {
                            info!("WebSocket recovered; promoting transport back to WsPrimary");
                            *m = TransportMode::WsPrimary;
                        }
                        drop(m);
                        if fwd_tx.send(ev).await.is_err() {
                            break;
                        }
                    }
                });

                loop {
                    let started = Instant::now();
                    let d = Arc::clone(&driver);
                    let tx_copy = inner_tx.clone();
                    let mut ws_task = tokio::spawn(async move { d.run_once(&tx_copy).await });
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

                    match run_res {
                        Ok(()) => break,
                        Err(e) => {
                            warn!(error = %e, "WebSocket disconnected; engaging REST fallback");
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
        }

        if self.rest_fallback_enabled {
            let gw_rest = Arc::clone(&self);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(
                    gw_rest.cfg.rest_poll_interval_ms.max(250),
                ));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut consecutive_failures: u32 = 0;

                loop {
                    tick.tick().await;
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
                    if matches!(current_mode, TransportMode::RestFallback | TransportMode::Reconnecting) {
                        let mut batch_ok = false;
                        for pair in &gw_rest.pairs {
                            match gw_rest.poll_latest_bar(pair, &gw_rest.timeframe).await {
                                Ok(ev) => {
                                    batch_ok = true;
                                    if tx.send(ev).await.is_err() {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    error!(%pair, error = %e, "REST fallback poll failed");
                                }
                            }
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
