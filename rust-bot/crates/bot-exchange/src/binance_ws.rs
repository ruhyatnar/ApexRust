use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent,
    MarketTicker24h, Result, TransportMode,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

const MAX_COMBINED_STREAMS_PER_CONN: usize = 1024;
const WS_PROACTIVE_ROTATE_SECS: u64 = 23 * 3600;

/// Binance Spot disconnects a connection that sends more than 5 messages per second
/// (Futures allows 10). Keep a conservative shared budget for `SUBSCRIBE` /
/// `UNSUBSCRIBE` so a large watchlist diff can never exceed the limit.
const WS_MAX_MSGS_PER_SEC: f64 = 4.0;
/// Streams per `SUBSCRIBE` / `UNSUBSCRIBE` frame (well inside Binance's 1024 cap).
const WS_BATCH_STREAMS: usize = 20;

/// Token bucket enforcing the inbound WebSocket message rate.
struct MessageRateLimiter {
    tokens: f64,
    last: Instant,
}

impl MessageRateLimiter {
    fn new() -> Self {
        Self {
            tokens: WS_MAX_MSGS_PER_SEC,
            last: Instant::now(),
        }
    }

    /// Refill up to `now` and consume one token when available.
    fn try_consume_at(&mut self, now: Instant) -> Option<Duration> {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * WS_MAX_MSGS_PER_SEC).min(WS_MAX_MSGS_PER_SEC);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return None;
        }
        let wait_secs = (1.0 - self.tokens) / WS_MAX_MSGS_PER_SEC;
        Some(Duration::from_secs_f64(wait_secs.max(0.0)))
    }

    async fn acquire(&mut self) {
        while let Some(wait) = self.try_consume_at(Instant::now()) {
            tokio::time::sleep(wait).await;
        }
    }
}

async fn send_stream_batches<S>(
    ws: &mut S,
    method: &str,
    streams: &[String],
    msg_id: &mut u64,
    limiter: &mut MessageRateLimiter,
) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    for chunk in streams.chunks(WS_BATCH_STREAMS) {
        limiter.acquire().await;
        let payload = serde_json::json!({
            "method": method,
            "params": chunk,
            "id": *msg_id,
        });
        *msg_id += 1;
        ws.send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|e| BotError::WebSocket(format!("Failed to send {method}: {e}")))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub enum WsStreamEvent {
    Candle(MarketEvent),
    BookTicker {
        symbol: String,
        best_bid: f64,
        best_ask: f64,
    },
    MiniTickerAll(Vec<MarketTicker24h>),
    /// Top N partial book levels (`@depthN@100ms`); no snapshot sequencing needed.
    DepthBook {
        symbol: String,
        bids: Vec<(f64, f64)>,
        asks: Vec<(f64, f64)>,
    },
}

/// Streams per pair in the combined connection (kline + bookTicker [+ depth]).
fn streams_per_pair(include_depth: bool) -> usize {
    if include_depth {
        3
    } else {
        2
    }
}

fn pair_subscriptions(symbol_lower: &str, timeframe: &str, include_depth: bool) -> Vec<String> {
    let mut out = vec![
        format!("{symbol_lower}@kline_{timeframe}"),
        format!("{symbol_lower}@bookTicker"),
    ];
    if include_depth {
        out.push(format!("{symbol_lower}@depth10@100ms"));
    }
    out
}

/// Binance combined WebSocket stream wrapper (`<symbol>@kline_<tf>`, `<symbol>@bookTicker`,
/// `!miniTicker@arr`) for Spot and USD-M Futures with live `SUBSCRIBE`/`UNSUBSCRIBE` diffs
/// and proactive `< 23h` connection rotation.
pub struct BinanceWsDriver {
    cfg: ExchangeConfig,
    timeframe: String,
}

#[derive(Debug, Deserialize)]
struct CombinedStreamEnvelope {
    stream: String,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct KlineEventPayload {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "k")]
    kline: KlineBarPayload,
}

#[derive(Debug, Deserialize)]
struct KlineBarPayload {
    #[serde(rename = "t")]
    open_time_ms: i64,
    #[serde(rename = "o")]
    open: String,
    #[serde(rename = "h")]
    high: String,
    #[serde(rename = "l")]
    low: String,
    #[serde(rename = "c")]
    close: String,
    #[serde(rename = "v")]
    volume: String,
    #[serde(rename = "x")]
    is_closed: bool,
}

#[derive(Debug, Deserialize)]
struct BookTickerPayload {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "b")]
    best_bid: String,
    #[serde(rename = "a")]
    best_ask: String,
}

#[derive(Debug, Deserialize)]
struct MiniTickerRaw {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "c")]
    close: String,
    #[serde(rename = "o")]
    open: String,
    #[serde(rename = "h")]
    high: String,
    #[serde(rename = "l")]
    low: String,
    #[serde(rename = "v")]
    base_volume: String,
    #[serde(rename = "q")]
    quote_volume: String,
    #[serde(rename = "E", default)]
    event_time_ms: i64,
}

impl BinanceWsDriver {
    pub fn new(cfg: ExchangeConfig, timeframe: String) -> Self {
        Self { cfg, timeframe }
    }

    pub fn resolve_stream_base(cfg: &ExchangeConfig) -> String {
        let trimmed = cfg.ws_stream_url.trim().trim_end_matches('/');
        let raw = match (cfg.venue, cfg.environment) {
            (ExchangeVenue::Futures, ExchangeEnvironment::Production) => {
                if !trimmed.is_empty()
                    && (trimmed.contains("fstream.binance.com")
                        || (!trimmed.contains("testnet")
                            && !trimmed.contains("demo")
                            && !trimmed.contains("binancefuture")
                            && !trimmed.contains("stream.binance.com")))
                {
                    trimmed
                } else {
                    "wss://fstream.binance.com/stream"
                }
            }
            (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
                if !trimmed.is_empty()
                    && (trimmed.contains("binancefuture") || trimmed.contains("demo-fstream"))
                {
                    trimmed
                } else {
                    "wss://stream.binancefuture.com/stream"
                }
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
                if !trimmed.is_empty()
                    && !trimmed.contains("testnet")
                    && !trimmed.contains("demo")
                    && !trimmed.contains("fstream")
                    && !trimmed.contains("binancefuture")
                {
                    trimmed
                } else {
                    "wss://stream.binance.com:9443/stream"
                }
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
                if !trimmed.is_empty()
                    && (trimmed.contains("testnet.binance.vision")
                        || trimmed.contains("demo-stream.binance.com"))
                {
                    trimmed
                } else {
                    "wss://stream.testnet.binance.vision/stream"
                }
            }
        };
        if let Some(prefix) = raw.strip_suffix("/ws") {
            format!("{prefix}/stream")
        } else if raw.ends_with("/stream") {
            raw.to_string()
        } else {
            format!("{raw}/stream")
        }
    }

    pub fn build_mini_ticker_ws_url(
        venue: ExchangeVenue,
        environment: ExchangeEnvironment,
    ) -> &'static str {
        match (venue, environment) {
            (ExchangeVenue::Futures, ExchangeEnvironment::Production) => {
                "wss://fstream.binance.com/ws/!miniTicker@arr"
            }
            (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
                "wss://stream.binancefuture.com/ws/!miniTicker@arr"
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
                "wss://stream.binance.com:9443/ws/!miniTicker@arr"
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
                "wss://stream.testnet.binance.vision/ws/!miniTicker@arr"
            }
        }
    }

    fn build_combined_url_for_pairs(
        base: &str,
        pairs: &[String],
        timeframe: &str,
        include_mini_ticker: bool,
        include_depth: bool,
    ) -> String {
        let mut streams = Vec::with_capacity(pairs.len() * 3 + 1);
        if include_mini_ticker {
            streams.push("!miniTicker@arr".to_string());
        }
        let per_pair = streams_per_pair(include_depth);
        for p in pairs {
            if streams.len() + per_pair > MAX_COMBINED_STREAMS_PER_CONN {
                break;
            }
            let lower = p.trim().to_lowercase();
            if lower.is_empty() {
                continue;
            }
            streams.extend(pair_subscriptions(&lower, timeframe, include_depth));
        }
        if streams.is_empty() {
            streams.push("!miniTicker@arr".to_string());
        }
        format!("{}?streams={}", base.trim_end_matches('/'), streams.join("/"))
    }

    /// Connects combined `<sym>@kline_<tf>` + `<sym>@bookTicker` (+ optional `!miniTicker@arr`),
    /// honors live `watch::Receiver<Vec<String>>` changes via debounced in-place `SUBSCRIBE`/`UNSUBSCRIBE`,
    /// and rotates cleanly before Binance's 24h connection limit.
    pub async fn run_reactive_once(
        &self,
        pairs_rx: &mut watch::Receiver<Vec<String>>,
        tx: &mpsc::Sender<WsStreamEvent>,
        include_mini_ticker: bool,
    ) -> Result<()> {
        let include_depth = self.cfg.depth_stream_enabled;
        let max_pairs = (MAX_COMBINED_STREAMS_PER_CONN - usize::from(include_mini_ticker))
            / streams_per_pair(include_depth);
        let initial_pairs: Vec<String> = pairs_rx
            .borrow_and_update()
            .iter()
            .map(|p| p.trim().to_uppercase())
            .filter(|p| !p.is_empty())
            .take(max_pairs)
            .collect();
        let base = Self::resolve_stream_base(&self.cfg);
        let url = Self::build_combined_url_for_pairs(
            &base,
            &initial_pairs,
            &self.timeframe,
            include_mini_ticker,
            include_depth,
        );
        info!(%url, count = initial_pairs.len(), "Connecting to Binance reactive combined WebSocket");

        let (mut ws, _) = tokio::time::timeout(Duration::from_secs(15), connect_async(&url))
            .await
            .map_err(|_| BotError::WebSocket("WebSocket connect timed out (15s)".into()))?
            .map_err(|e| BotError::WebSocket(format!("Connect failed: {e}")))?;

        let mut active_pairs: HashSet<String> = initial_pairs.into_iter().collect();
        let mut msg_id: u64 = 1;
        let mut limiter = MessageRateLimiter::new();
        let read_timeout = Duration::from_millis((self.cfg.ws_heartbeat_timeout_ms * 2).max(5000));
        let rotate_sleep = tokio::time::sleep(Duration::from_secs(WS_PROACTIVE_ROTATE_SECS));
        tokio::pin!(rotate_sleep);

        loop {
            let timeout_sleep = tokio::time::sleep(read_timeout);
            tokio::pin!(timeout_sleep);

            tokio::select! {
                _ = &mut rotate_sleep => {
                    info!("Proactively rotating Binance WebSocket stream before 24h limit");
                    let _ = ws.close(None).await;
                    return Ok(());
                }
                _ = &mut timeout_sleep => {
                    return Err(BotError::WebSocket("WebSocket stream heartbeat timeout".into()));
                }
                Ok(()) = pairs_rx.changed() => {
                    // Debounce burst watchlist mutations cleanly
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    let target_vec: Vec<String> = pairs_rx
                        .borrow_and_update()
                        .iter()
                        .map(|p| p.trim().to_uppercase())
                        .filter(|p| !p.is_empty())
                        .take(max_pairs)
                        .collect();
                    let target_set: HashSet<String> = target_vec.into_iter().collect();
                    let to_add: Vec<String> = target_set.difference(&active_pairs).cloned().collect();
                    let to_remove: Vec<String> = active_pairs.difference(&target_set).cloned().collect();

                    if !to_remove.is_empty() {
                        let mut streams = Vec::with_capacity(to_remove.len() * 3);
                        for sym in &to_remove {
                            let l = sym.to_lowercase();
                            streams.extend(pair_subscriptions(&l, &self.timeframe, include_depth));
                        }
                        send_stream_batches(
                            &mut ws,
                            "UNSUBSCRIBE",
                            &streams,
                            &mut msg_id,
                            &mut limiter,
                        )
                        .await?;
                    }

                    if !to_add.is_empty() {
                        let mut streams = Vec::with_capacity(to_add.len() * 3);
                        for sym in &to_add {
                            let l = sym.to_lowercase();
                            streams.extend(pair_subscriptions(&l, &self.timeframe, include_depth));
                        }
                        send_stream_batches(
                            &mut ws,
                            "SUBSCRIBE",
                            &streams,
                            &mut msg_id,
                            &mut limiter,
                        )
                        .await?;
                    }
                    active_pairs = target_set;
                }
                frame_opt = ws.next() => {
                    let Some(frame) = frame_opt else {
                        break;
                    };
                    match frame {
                        Ok(Message::Text(txt)) => {
                            if let Some(ev) = Self::parse_combined_event_ex(self.cfg.venue, &txt) {
                                if tx.send(ev).await.is_err() {
                                    return Ok(());
                                }
                            }
                        }
                        Ok(Message::Ping(payload)) => {
                            ws.send(Message::Pong(payload))
                                .await
                                .map_err(|e| BotError::WebSocket(format!("Pong send failed: {e}")))?;
                        }
                        Ok(Message::Close(frame)) => {
                            warn!(?frame, "Binance WebSocket closed by remote");
                            return Err(BotError::WebSocket("Remote closed WebSocket".into()));
                        }
                        Err(e) => {
                            return Err(BotError::WebSocket(format!("Stream read error: {e}")));
                        }
                        _ => {}
                    }
                }
            }
        }

        Err(BotError::WebSocket("WebSocket stream ended unexpectedly".into()))
    }

    pub async fn run_mini_ticker_once(
        venue: ExchangeVenue,
        environment: ExchangeEnvironment,
        tx: &mpsc::Sender<WsStreamEvent>,
    ) -> Result<()> {
        let url = Self::build_mini_ticker_ws_url(venue, environment);
        let (mut ws, _) = tokio::time::timeout(Duration::from_secs(15), connect_async(url))
            .await
            .map_err(|_| BotError::WebSocket("MiniTicker WS connect timed out".into()))?
            .map_err(|e| BotError::WebSocket(format!("MiniTicker WS connect failed: {e}")))?;
        let rotate_sleep = tokio::time::sleep(Duration::from_secs(WS_PROACTIVE_ROTATE_SECS));
        tokio::pin!(rotate_sleep);

        loop {
            let timeout_sleep = tokio::time::sleep(Duration::from_secs(60));
            tokio::pin!(timeout_sleep);
            tokio::select! {
                _ = &mut rotate_sleep => {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
                _ = &mut timeout_sleep => {
                    return Err(BotError::WebSocket("MiniTicker WS heartbeat timeout".into()));
                }
                frame_opt = ws.next() => {
                    let Some(frame) = frame_opt else {
                        break;
                    };
                    match frame {
                        Ok(Message::Text(txt)) => {
                            if let Some(ev) = Self::parse_combined_event_ex(venue, &txt) {
                                if tx.send(ev).await.is_err() {
                                    return Ok(());
                                }
                            }
                        }
                        Ok(Message::Ping(payload)) => {
                            let _ = ws.send(Message::Pong(payload)).await;
                        }
                        Ok(Message::Close(_)) => break,
                        Err(e) => return Err(BotError::WebSocket(format!("MiniTicker WS read error: {e}"))),
                        _ => {}
                    }
                }
            }
        }
        Err(BotError::WebSocket("MiniTicker WS stream ended".into()))
    }

    pub fn parse_combined_event_ex(venue: ExchangeVenue, raw: &str) -> Option<WsStreamEvent> {
        let val: serde_json::Value = serde_json::from_str(raw).ok()?;
        if val.is_array() {
            let items: Vec<MiniTickerRaw> = serde_json::from_value(val).ok()?;
            return Some(WsStreamEvent::MiniTickerAll(Self::convert_mini_tickers(venue, items)));
        }

        let env: CombinedStreamEnvelope = serde_json::from_value(val).ok()?;
        if env.stream == "!miniTicker@arr" {
            let items: Vec<MiniTickerRaw> = serde_json::from_value(env.data).ok()?;
            return Some(WsStreamEvent::MiniTickerAll(Self::convert_mini_tickers(venue, items)));
        }
        if env.stream.contains("@depth") {
            let symbol_from_stream = env
                .stream
                .split('@')
                .next()
                .unwrap_or_default()
                .to_uppercase();
            let (symbol, raw_bids, raw_asks) = if let Some(s) = env
                .data
                .get("s")
                .and_then(|v| v.as_str())
            {
                (
                    s.to_uppercase(),
                    env.data.get("b").cloned().unwrap_or_default(),
                    env.data.get("a").cloned().unwrap_or_default(),
                )
            } else {
                (
                    symbol_from_stream,
                    env.data
                        .get("bids")
                        .cloned()
                        .or_else(|| env.data.get("b").cloned())
                        .unwrap_or_default(),
                    env.data
                        .get("asks")
                        .cloned()
                        .or_else(|| env.data.get("a").cloned())
                        .unwrap_or_default(),
                )
            };
            if symbol.is_empty() {
                return None;
            }
            let parse_levels = |value: serde_json::Value| -> Vec<(f64, f64)> {
                value
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|row| {
                                let pair = row.as_array()?;
                                let price = pair.first()?.as_str()?.parse::<f64>().ok()?;
                                let qty = pair.get(1)?.as_str()?.parse::<f64>().ok()?;
                                (price > 0.0 && qty.is_finite()).then_some((price, qty))
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let bids = parse_levels(raw_bids);
            let asks = parse_levels(raw_asks);
            if bids.is_empty() && asks.is_empty() {
                return None;
            }
            return Some(WsStreamEvent::DepthBook {
                symbol,
                bids,
                asks,
            });
        }
        if env.stream.ends_with("@bookTicker") {
            let payload: BookTickerPayload = serde_json::from_value(env.data).ok()?;
            let best_bid = payload.best_bid.parse::<f64>().ok()?;
            let best_ask = payload.best_ask.parse::<f64>().ok()?;
            if best_bid > 0.0 && best_ask > 0.0 {
                return Some(WsStreamEvent::BookTicker {
                    symbol: payload.symbol.to_uppercase(),
                    best_bid,
                    best_ask,
                });
            }
            return None;
        }
        if !env.stream.contains("@kline_") {
            return None;
        }
        let payload: KlineEventPayload = serde_json::from_value(env.data).ok()?;
        let close = payload.kline.close.parse::<f64>().ok()?;
        let candle = Candle {
            open_time_ms: payload.kline.open_time_ms,
            open: payload.kline.open.parse::<f64>().ok()?,
            high: payload.kline.high.parse::<f64>().ok()?,
            low: payload.kline.low.parse::<f64>().ok()?,
            close,
            volume: payload.kline.volume.parse::<f64>().ok()?,
            is_closed: payload.kline.is_closed,
        };

        Some(WsStreamEvent::Candle(MarketEvent {
            symbol: payload.symbol.to_uppercase(),
            price: close,
            candle,
            source: TransportMode::WsPrimary,
            received_at: Utc::now(),
        }))
    }

    fn convert_mini_tickers(venue: ExchangeVenue, items: Vec<MiniTickerRaw>) -> Vec<MarketTicker24h> {
        let fallback_now = Utc::now().timestamp_millis();
        items
            .into_iter()
            .filter_map(|item| {
                let last_price = item.close.parse::<f64>().ok()?;
                if !last_price.is_finite() || last_price <= 0.0 {
                    return None;
                }
                let open_price = item.open.parse::<f64>().ok().filter(|&p| p > 0.0).unwrap_or(last_price);
                let high_price = item.high.parse::<f64>().ok().filter(|&p| p > 0.0).unwrap_or(last_price);
                let low_price = item.low.parse::<f64>().ok().filter(|&p| p > 0.0).unwrap_or(last_price);
                let base_volume = item.base_volume.parse::<f64>().unwrap_or(0.0);
                let quote_volume = item.quote_volume.parse::<f64>().unwrap_or(0.0);
                let price_change_percent = ((last_price - open_price) / open_price) * 100.0;
                let range_pct_24h = if low_price > 0.0 && high_price >= low_price {
                    ((high_price - low_price) / low_price.max(1e-12)) * 100.0
                } else {
                    0.0
                };
                Some(MarketTicker24h {
                    symbol: item.symbol.to_uppercase(),
                    venue,
                    last_price,
                    open_price_24h: open_price,
                    high_price_24h: high_price,
                    low_price_24h: low_price,
                    price_change_percent,
                    base_volume,
                    quote_volume,
                    range_pct_24h,
                    tradable_on_active_env: true,
                    in_watchlist: false,
                    source_tag: None,
                    updated_at_ms: if item.event_time_ms > 0 { item.event_time_ms } else { fallback_now },
                    rvol_1h: None,
                    momentum_1h_pct: None,
                    cts_score: None,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bot_core::MarginType;

    fn sample_exchange_cfg(
        venue: ExchangeVenue,
        environment: ExchangeEnvironment,
        ws_stream_url: &str,
    ) -> ExchangeConfig {
        ExchangeConfig {
            environment,
            venue,
            leverage: 3,
            margin_type: MarginType::Isolated,
            paper_trading: true,
            credentials: None,
            ws_stream_url: ws_stream_url.into(),
            rest_base_url: String::new(),
            ws_heartbeat_timeout_ms: 15_000,
            rest_poll_interval_ms: 3_000,
            ws_reconnect_initial_ms: 1_000,
            ws_reconnect_max_ms: 30_000,
            max_consecutive_rest_failures: 5,
            max_leverage: 3,
            ws_api_url: String::new(),
            use_ws_api_orders: false,
            depth_stream_enabled: false,
        }
    }

    #[test]
    fn depth_partial_book_parses_futures_and_spot_shapes() {
        let futures_frame = serde_json::json!({
            "stream": "btcusdt@depth10@100ms",
            "data": {
                "e": "depthUpdate",
                "s": "BTCUSDT",
                "b": [["100.0", "2.5"], ["99.5", "1.0"]],
                "a": [["100.5", "1.0"]]
            }
        })
        .to_string();
        match BinanceWsDriver::parse_combined_event_ex(ExchangeVenue::Futures, &futures_frame) {
            Some(WsStreamEvent::DepthBook { symbol, bids, asks }) => {
                assert_eq!(symbol, "BTCUSDT");
                assert_eq!(bids.len(), 2);
                assert_eq!(asks.len(), 1);
            }
            other => panic!("unexpected depth parse: {other:?}"),
        }

        let spot_frame = serde_json::json!({
            "stream": "ethusdt@depth10@100ms",
            "data": {
                "lastUpdateId": 160,
                "bids": [["10.0", "3.0"]],
                "asks": [["10.1", "1.0"]]
            }
        })
        .to_string();
        match BinanceWsDriver::parse_combined_event_ex(ExchangeVenue::Spot, &spot_frame) {
            Some(WsStreamEvent::DepthBook { symbol, bids, asks }) => {
                assert_eq!(symbol, "ETHUSDT");
                assert_eq!(bids[0], (10.0, 3.0));
                assert_eq!(asks[0], (10.1, 1.0));
            }
            other => panic!("unexpected spot depth parse: {other:?}"),
        }
    }

    #[test]
    fn message_rate_limiter_enforces_four_messages_per_second() {
        let mut limiter = MessageRateLimiter::new();
        let start = Instant::now();
        for _ in 0..4 {
            assert!(limiter.try_consume_at(start).is_none());
        }
        let wait = limiter
            .try_consume_at(start)
            .expect("fifth message in the same instant must wait");
        assert!(wait >= Duration::from_millis(240) && wait <= Duration::from_millis(260));
        assert!(limiter
            .try_consume_at(start + Duration::from_millis(250))
            .is_none());
        assert_eq!(WS_BATCH_STREAMS, 20);
    }

    #[test]
    fn resolve_stream_base_normalizes_ws_and_bare_host_to_stream() {
        let spot_ws = sample_exchange_cfg(
            ExchangeVenue::Spot,
            ExchangeEnvironment::Production,
            "wss://stream.binance.com:9443/ws/",
        );
        assert_eq!(
            BinanceWsDriver::resolve_stream_base(&spot_ws),
            "wss://stream.binance.com:9443/stream"
        );

        let futures_bare = sample_exchange_cfg(
            ExchangeVenue::Futures,
            ExchangeEnvironment::Production,
            "wss://fstream.binance.com",
        );
        assert_eq!(
            BinanceWsDriver::resolve_stream_base(&futures_bare),
            "wss://fstream.binance.com/stream"
        );

        let futures_ws = sample_exchange_cfg(
            ExchangeVenue::Futures,
            ExchangeEnvironment::Testnet,
            "wss://stream.binancefuture.com/ws",
        );
        assert_eq!(
            BinanceWsDriver::resolve_stream_base(&futures_ws),
            "wss://stream.binancefuture.com/stream"
        );
    }
}
