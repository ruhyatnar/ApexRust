//! Binance user data stream (account/order push events).
//!
//! Binance pushes fills, cancels and rejections over a per-account WebSocket
//! keyed by a `listenKey`:
//!
//! - Spot: `POST /api/v3/userDataStream` -> `wss://stream.binance.com:9443/ws/<key>`
//! - USD-M Futures: `POST /fapi/v1/listenKey` -> `wss://fstream.binance.com/ws/<key>`
//!
//! Listen key creation/keepalive only needs the `X-MBX-APIKEY` header (no
//! signature), and the key expires after 60 minutes of inactivity, so we ping
//! every 30 minutes. The socket is re-established on close or key expiry.
//!
//! The engine uses these events to reconcile pending orders immediately instead
//! of waiting for the next REST polling tick.

use bot_core::{BotError, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, Result, Side};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

/// Binance expires listen keys after 60 idle minutes; ping well before that.
pub const LISTEN_KEY_KEEPALIVE: Duration = Duration::from_secs(30 * 60);
const KEEPALIVE_RETRY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub struct OrderUpdate {
    pub symbol: String,
    pub order_id: i64,
    pub client_order_id: Option<String>,
    pub status: String,
    pub executed_qty: f64,
    pub avg_price: f64,
    pub side: Side,
    pub reduce_only: bool,
    pub event_time_ms: i64,
}

impl OrderUpdate {
    /// Terminal statuses after which the engine must reconcile the order slot.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "FILLED" | "CANCELED" | "CANCELLED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED"
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum UserStreamEvent {
    OrderUpdate(OrderUpdate),
    AccountUpdate,
    ListenKeyExpired,
    Other,
}

fn parse_side(raw: &str) -> Side {
    if raw.eq_ignore_ascii_case("SELL") {
        Side::Short
    } else {
        Side::Long
    }
}

fn f64_field(obj: &Value, key: &str) -> f64 {
    obj.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| obj.get(key).and_then(|v| v.as_f64()))
        .unwrap_or(0.0)
}

fn i64_field(obj: &Value, key: &str) -> i64 {
    obj.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Spot sends `executionReport`; USD-M Futures nests the payload under `o` in
/// `ORDER_TRADE_UPDATE`. Unknown/irrelevant events are reported as `Other` so
/// the driver keeps the connection without acting on them.
pub fn parse_user_stream_event(raw: &str) -> Option<UserStreamEvent> {
    let value: Value = serde_json::from_str(raw).ok()?;
    match value.get("e").and_then(|v| v.as_str()).unwrap_or_default() {
        "listenKeyExpired" => Some(UserStreamEvent::ListenKeyExpired),
        "ACCOUNT_UPDATE" | "ACCOUNT_CONFIG_UPDATE" => Some(UserStreamEvent::AccountUpdate),
        "MARGIN_CALL" => Some(UserStreamEvent::AccountUpdate),
        "executionReport" => Some(UserStreamEvent::OrderUpdate(OrderUpdate {
            symbol: value
                .get("s")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            order_id: i64_field(&value, "i"),
            client_order_id: value
                .get("c")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            status: value
                .get("X")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            executed_qty: f64_field(&value, "z"),
            // Spot reports the last fill price as `L`; cumulative quote `Z` is
            // used only when `L` is missing.
            avg_price: {
                let last = f64_field(&value, "L");
                if last > 0.0 {
                    last
                } else {
                    let cum_quote = f64_field(&value, "Z");
                    let cum_qty = f64_field(&value, "z");
                    if cum_qty > 0.0 {
                        cum_quote / cum_qty
                    } else {
                        0.0
                    }
                }
            },
            side: parse_side(value.get("S").and_then(|v| v.as_str()).unwrap_or_default()),
            // Spot execution reports do not carry a reduce-only flag.
            reduce_only: value.get("R").and_then(|v| v.as_bool()).unwrap_or(false),
            event_time_ms: i64_field(&value, "E"),
        })),
        "ORDER_TRADE_UPDATE" => {
            let order = value.get("o")?;
            Some(UserStreamEvent::OrderUpdate(OrderUpdate {
                symbol: order
                    .get("s")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                order_id: i64_field(order, "i"),
                client_order_id: order
                    .get("c")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                status: order
                    .get("X")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                executed_qty: f64_field(order, "z"),
                avg_price: f64_field(order, "ap"),
                side: parse_side(order.get("S").and_then(|v| v.as_str()).unwrap_or_default()),
                reduce_only: order.get("R").and_then(|v| v.as_bool()).unwrap_or(false),
                event_time_ms: i64_field(&value, "E"),
            }))
        }
        _ => Some(UserStreamEvent::Other),
    }
}

fn resolve_rest_base(cfg: &ExchangeConfig) -> &str {
    let trimmed = cfg.rest_base_url.trim();
    match (cfg.venue, cfg.environment) {
        (ExchangeVenue::Futures, ExchangeEnvironment::Production) => {
            if trimmed.is_empty() || trimmed.contains("testnet") || trimmed.contains("demo") {
                "https://fapi.binance.com"
            } else {
                trimmed
            }
        }
        (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
            if trimmed.is_empty() || trimmed.contains("fapi.binance.com") {
                "https://testnet.binancefuture.com"
            } else {
                trimmed
            }
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
            if trimmed.is_empty() || trimmed.contains("testnet") || trimmed.contains("demo") {
                "https://api.binance.com"
            } else {
                trimmed
            }
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
            if trimmed.is_empty() || trimmed.contains("api.binance.com") {
                "https://testnet.binance.vision"
            } else {
                trimmed
            }
        }
    }
}

fn resolve_ws_base(cfg: &ExchangeConfig) -> &'static str {
    match (cfg.venue, cfg.environment) {
        (ExchangeVenue::Futures, ExchangeEnvironment::Production) => "wss://fstream.binance.com",
        (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
            "wss://stream.binancefuture.com"
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
            "wss://stream.binance.com:9443"
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
            "wss://stream.testnet.binance.vision"
        }
    }
}

fn listen_key_path(venue: ExchangeVenue) -> &'static str {
    match venue {
        ExchangeVenue::Futures => "/fapi/v1/listenKey",
        ExchangeVenue::Spot => "/api/v3/userDataStream",
    }
}

pub struct UserDataStream {
    cfg: ExchangeConfig,
    http: reqwest::Client,
}

impl UserDataStream {
    pub fn new(cfg: ExchangeConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    fn api_key(&self) -> Option<String> {
        let env_name = self
            .cfg
            .credentials
            .as_ref()
            .map(|c| c.api_key_env.clone())
            .unwrap_or_else(|| "BINANCE_API_KEY".to_string());
        std::env::var(env_name)
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
    }

    pub fn is_enabled(&self) -> bool {
        self.api_key().is_some()
    }

    fn endpoint(&self) -> String {
        format!("{}{}", resolve_rest_base(&self.cfg), listen_key_path(self.cfg.venue))
    }

    /// Open a new listen key (weight 1, API-key auth only).
    pub async fn create_listen_key(&self) -> Result<String> {
        let api_key = self
            .api_key()
            .ok_or_else(|| BotError::RestApi("user data stream requires BINANCE_API_KEY".into()))?;
        let resp = self
            .http
            .post(self.endpoint())
            .header("X-MBX-APIKEY", api_key)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("listenKey create failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(BotError::RestApi(format!(
                "listenKey create rejected ({status}): {}",
                body.trim()
            )));
        }
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("listenKey response parse failed: {e}")))?;
        payload
            .get("listenKey")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| BotError::RestApi("listenKey missing from Binance response".into()))
    }

    /// Extend the key's 60-minute lifetime. Keys can disappear between ticks,
    /// which callers treat as a signal to recreate the stream.
    pub async fn keepalive_listen_key(&self, listen_key: &str) -> Result<()> {
        let api_key = self
            .api_key()
            .ok_or_else(|| BotError::RestApi("user data stream requires BINANCE_API_KEY".into()))?;
        let resp = self
            .http
            .put(self.endpoint())
            .query(&[("listenKey", listen_key)])
            .header("X-MBX-APIKEY", api_key)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("listenKey keepalive failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(BotError::RestApi(format!(
                "listenKey keepalive rejected ({status}): {}",
                body.trim()
            )));
        }
        Ok(())
    }

    pub fn ws_url(&self, listen_key: &str) -> String {
        format!("{}/ws/{}", resolve_ws_base(&self.cfg), listen_key)
    }

    /// Run the stream forever in the background, forwarding parsed events.
    pub fn spawn(self, tx: mpsc::Sender<UserStreamEvent>) {
        if !self.is_enabled() {
            info!("User data stream disabled: no Binance API key configured");
            return;
        }
        tokio::spawn(async move {
            let initial = Duration::from_millis(self.cfg.ws_reconnect_initial_ms.max(500));
            let max = Duration::from_millis(self.cfg.ws_reconnect_max_ms.max(1_000));
            let mut backoff = initial;
            loop {
                match self.run_session(&tx).await {
                    Ok(()) => {
                        debug!("User data stream session ended; reconnecting");
                        backoff = initial;
                    }
                    Err(err) => {
                        warn!(%err, "User data stream session failed");
                        backoff = (backoff * 2).min(max);
                    }
                }
                if tx.is_closed() {
                    return;
                }
                tokio::time::sleep(backoff).await;
            }
        });
    }

    async fn run_session(&self, tx: &mpsc::Sender<UserStreamEvent>) -> Result<()> {
        let listen_key = self.create_listen_key().await?;
        let url = self.ws_url(&listen_key);
        info!(venue = ?self.cfg.venue, "Connecting Binance user data stream");
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| BotError::WebSocket(format!("user data stream connect failed: {e}")))?;

        let mut keepalive = tokio::time::interval(LISTEN_KEY_KEEPALIVE);
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the immediate first tick: the key was just created.
        keepalive.tick().await;

        loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    if let Err(err) = self.keepalive_listen_key(&listen_key).await {
                        warn!(%err, "listenKey keepalive failed; recreating stream");
                        tokio::time::sleep(KEEPALIVE_RETRY).await;
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                }
                msg = socket.next() => {
                    let Some(msg) = msg else {
                        return Ok(());
                    };
                    let msg = msg.map_err(|e| BotError::WebSocket(format!("user data stream read failed: {e}")))?;
                    let text = match msg {
                        Message::Text(text) => text.to_string(),
                        Message::Binary(buf) => String::from_utf8_lossy(&buf).to_string(),
                        Message::Ping(payload) => {
                            socket.send(Message::Pong(payload)).await.ok();
                            continue;
                        }
                        Message::Close(_) => return Ok(()),
                        _ => continue,
                    };
                    match parse_user_stream_event(&text) {
                        Some(UserStreamEvent::ListenKeyExpired) => {
                            warn!("Binance listenKey expired; reconnecting user data stream");
                            let _ = tx.send(UserStreamEvent::ListenKeyExpired).await;
                            return Ok(());
                        }
                        Some(ev) => {
                            if tx.send(ev).await.is_err() {
                                return Ok(());
                            }
                        }
                        None => debug!(payload = %text, "Ignoring unparsable user data stream frame"),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_futures_order_trade_update() {
        let raw = r#"{"e":"ORDER_TRADE_UPDATE","E":1700000000123,"T":1700000000100,"o":{"s":"BTCUSDT","c":"apex-1","S":"BUY","o":"LIMIT","f":"GTC","q":"0.010","p":"42000","X":"FILLED","i":123456,"z":"0.010","L":"42010","ap":"42010","R":false}}"#;
        let ev = parse_user_stream_event(raw).expect("event");
        match ev {
            UserStreamEvent::OrderUpdate(update) => {
                assert_eq!(update.symbol, "BTCUSDT");
                assert_eq!(update.order_id, 123456);
                assert_eq!(update.status, "FILLED");
                assert!((update.executed_qty - 0.010).abs() < 1e-12);
                assert!((update.avg_price - 42010.0).abs() < 1e-9);
                assert_eq!(update.side, Side::Long);
                assert!(!update.reduce_only);
                assert!(update.is_terminal());
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_spot_execution_report_and_marks_reduce_only_false() {
        let raw = r#"{"e":"executionReport","E":1700000000456,"s":"ETHUSDT","c":"apex-2","S":"SELL","o":"LIMIT","f":"GTC","q":"1.5","p":"2000","X":"PARTIALLY_FILLED","i":987,"z":"0.5","Z":"1000","L":"2000","R":true}"#;
        let ev = parse_user_stream_event(raw).expect("event");
        match ev {
            UserStreamEvent::OrderUpdate(update) => {
                assert_eq!(update.symbol, "ETHUSDT");
                assert_eq!(update.status, "PARTIALLY_FILLED");
                assert_eq!(update.side, Side::Short);
                assert_eq!(update.executed_qty, 0.5);
                assert_eq!(update.avg_price, 2000.0);
                assert!(!update.is_terminal());
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn detects_listen_key_expiry_and_ignores_unknown_frames() {
        assert_eq!(
            parse_user_stream_event(r#"{"e":"listenKeyExpired","E":1700000000}"#),
            Some(UserStreamEvent::ListenKeyExpired)
        );
        assert_eq!(
            parse_user_stream_event(r#"{"result":null,"id":1}"#),
            Some(UserStreamEvent::Other)
        );
        assert_eq!(parse_user_stream_event("not-json"), None);
    }
}
