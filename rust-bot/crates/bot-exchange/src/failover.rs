use crate::{BinanceRestClient, BinanceWsDriver};
use bot_core::{ExchangeConfig, MarketEvent, Result, TransportMode};
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

/// Coordinates primary WebSocket streaming and seamless REST polling fallback
/// whenever WebSocket heartbeats exceed `ws_heartbeat_timeout_ms`.
pub struct FailoverGateway {
    cfg: ExchangeConfig,
    pairs: Vec<String>,
    timeframe: String,
    rest: Arc<BinanceRestClient>,
    mode: Arc<RwLock<TransportMode>>,
    failover_count: Arc<AtomicU64>,
    last_ws_epoch_ms: Arc<AtomicU64>,
}

impl FailoverGateway {
    pub fn new(cfg: ExchangeConfig, pairs: Vec<String>, timeframe: String) -> Result<Self> {
        let rest = Arc::new(BinanceRestClient::new(cfg.clone())?);
        Ok(Self {
            cfg,
            pairs,
            timeframe,
            rest,
            mode: Arc::new(RwLock::new(TransportMode::WsPrimary)),
            failover_count: Arc::new(AtomicU64::new(0)),
            last_ws_epoch_ms: Arc::new(AtomicU64::new(0)),
        })
    }

    pub fn rest_client(&self) -> Arc<BinanceRestClient> {
        Arc::clone(&self.rest)
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
        let ws_tx = tx.clone();
        let gw_ws = Arc::clone(&self);

        // Task 1: Primary WebSocket loop with exponential backoff reconnect
        tokio::spawn(async move {
            let driver = BinanceWsDriver::new(
                gw_ws.cfg.clone(),
                gw_ws.pairs.clone(),
                gw_ws.timeframe.clone(),
            );
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
                match driver.run_once(&inner_tx).await {
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

        // Task 2: Heartbeat Watchdog & REST Fallback Poller
        let gw_rest = Arc::clone(&self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(gw_rest.cfg.rest_poll_interval_ms));
            loop {
                tick.tick().await;
                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                let last = gw_rest.last_ws_epoch_ms.load(Ordering::Relaxed);
                let stale = last > 0 && now_ms.saturating_sub(last) > gw_rest.cfg.ws_heartbeat_timeout_ms;

                if stale {
                    gw_rest.engage_rest_fallback().await;
                }

                if *gw_rest.mode.read().await == TransportMode::RestFallback {
                    for pair in &gw_rest.pairs {
                        match gw_rest.rest.poll_latest_bar(pair, &gw_rest.timeframe).await {
                            Ok(ev) => {
                                if tx.send(ev).await.is_err() {
                                    return;
                                }
                            }
                            Err(e) => {
                                error!(%pair, error = %e, "REST fallback poll failed");
                            }
                        }
                    }
                }
            }
        });
    }

    async fn engage_rest_fallback(&self) {
        let mut guard = self.mode.write().await;
        if *guard != TransportMode::RestFallback {
            *guard = TransportMode::RestFallback;
            self.failover_count.fetch_add(1, Ordering::Relaxed);
        }
    }
}
