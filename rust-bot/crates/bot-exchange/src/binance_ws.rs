use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent, Result,
    TransportMode,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

/// Binance combined WebSocket stream wrapper (`<symbol>@kline_<tf>`) for Spot and USD-M Futures.
/// Designed to interoperate with `binance-sdk` SpotWsStreams & DerivativesTradingUsdsFuturesWsStreams.
pub struct BinanceWsDriver {
    cfg: ExchangeConfig,
    pairs: Vec<String>,
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

impl BinanceWsDriver {
    pub fn new(cfg: ExchangeConfig, pairs: Vec<String>, timeframe: String) -> Self {
        Self {
            cfg,
            pairs,
            timeframe,
        }
    }

    pub fn build_combined_stream_url(&self) -> String {
        let trimmed = self.cfg.ws_stream_url.trim().trim_end_matches('/');
        let base = match (self.cfg.venue, self.cfg.environment) {
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
        let streams = self
            .pairs
            .iter()
            .map(|p| format!("{}@kline_{}", p.to_lowercase(), self.timeframe))
            .collect::<Vec<_>>()
            .join("/");
        format!("{}?streams={}", base.trim_end_matches('/'), streams)
    }

    /// Connect to Binance WebSocket Streams and forward parsed `MarketEvent`s
    /// until the socket terminates or a heartbeat error occurs.
    pub async fn run_once(&self, tx: &mpsc::Sender<MarketEvent>) -> Result<()> {
        let url = self.build_combined_stream_url();
        info!(%url, "Connecting to Binance WebSocket primary stream");

        let (mut ws, _) = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            connect_async(&url),
        )
        .await
        .map_err(|_| BotError::WebSocket("WebSocket connect timed out (15s)".into()))?
        .map_err(|e| BotError::WebSocket(format!("Connect failed: {e}")))?;

        let read_timeout = std::time::Duration::from_millis((self.cfg.ws_heartbeat_timeout_ms * 2).max(5000));
        loop {
            let frame_opt = tokio::time::timeout(read_timeout, ws.next())
                .await
                .map_err(|_| BotError::WebSocket("WebSocket stream heartbeat timeout".into()))?;
            let Some(frame) = frame_opt else {
                break;
            };
            match frame {
                Ok(Message::Text(txt)) => {
                    if let Some(ev) = Self::parse_combined_event(&txt) {
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

        Err(BotError::WebSocket("WebSocket stream ended unexpectedly".into()))
    }

    fn parse_combined_event(raw: &str) -> Option<MarketEvent> {
        let env: CombinedStreamEnvelope = serde_json::from_str(raw).ok()?;
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

        Some(MarketEvent {
            symbol: payload.symbol,
            price: close,
            candle,
            source: TransportMode::WsPrimary,
            received_at: Utc::now(),
        })
    }
}
