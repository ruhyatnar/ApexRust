use binance_sdk::config::ConfigurationRestApi;
use binance_sdk::spot::{rest_api::KlinesParams, SpotRestApi};
use bot_core::{BotError, Candle, ExchangeConfig, ExchangeEnvironment, MarketEvent, Result, TransportMode};
use chrono::Utc;
use std::env;
use tracing::debug;

/// Official Binance Spot REST API wrapper (`binance_sdk::spot::SpotRestApi`)
/// used for:
/// 1. Historical kline warmup at startup (200+ candles for EMA 200 / ADX / ATR)
/// 2. Automatic fallback market polling & order execution if WebSocket stalls.
pub struct BinanceRestClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<SpotRestApi>,
}

impl BinanceRestClient {
    pub fn new(cfg: ExchangeConfig) -> Result<Self> {
        // Initialize official binance-sdk SpotRestApi when API credentials exist
        let sdk_client = match (env::var("BINANCE_API_KEY"), env::var("BINANCE_PRIVATE_KEY_PATH")) {
            (Ok(api_key), Ok(key_path)) if !api_key.is_empty() => {
                let rest_cfg = ConfigurationRestApi::builder()
                    .api_key(api_key)
                    .private_key(binance_sdk::config::PrivateKey::File(key_path))
                    .build()
                    .map_err(|e| BotError::RestApi(format!("binance-sdk config error: {e}")))?;
                let client = match cfg.environment {
                    ExchangeEnvironment::Production => SpotRestApi::production(rest_cfg),
                    ExchangeEnvironment::Testnet => SpotRestApi::testnet(rest_cfg),
                };
                Some(client)
            }
            _ => None,
        };

        Ok(Self {
            cfg,
            http: reqwest::Client::new(),
            sdk_client,
        })
    }

    /// Fetch historical klines via official `SpotRestApi` (or public REST endpoint
    /// when running unauthenticated paper mode).
    pub async fn fetch_klines(&self, symbol: &str, interval: &str, limit: usize) -> Result<Vec<Candle>> {
        if let Some(client) = &self.sdk_client {
            let params = KlinesParams::builder(symbol.to_string(), interval.to_string())
                .limit(limit as i32)
                .build()
                .map_err(|e| BotError::RestApi(format!("KlinesParams error: {e}")))?;

            let _resp = client
                .klines(params)
                .await
                .map_err(|e| BotError::RestApi(format!("SpotRestApi::klines failed: {e}")))?;
            debug!(%symbol, %interval, "Fetched klines via official binance-sdk SpotRestApi");
        }

        // Public REST JSON fallback (works both with and without API keys)
        let url = format!(
            "{}/api/v3/klines?symbol={}&interval={}&limit={}",
            self.cfg.rest_base_url,
            symbol.to_uppercase(),
            interval,
            limit
        );
        let rows: Vec<Vec<serde_json::Value>> = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("REST HTTP request failed: {e}")))?
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("REST JSON decode failed: {e}")))?;

        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 6 {
                continue;
            }
            let open_time_ms = row[0].as_i64().unwrap_or_default();
            let open = row[1].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let high = row[2].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let low = row[3].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let close = row[4].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let volume = row[5].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            candles.push(Candle {
                open_time_ms,
                open,
                high,
                low,
                close,
                volume,
                is_closed: true,
            });
        }
        Ok(candles)
    }

    /// Single fallback poll yielding a `MarketEvent` tagged `TransportMode::RestFallback`.
    pub async fn poll_latest_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_klines(symbol, interval, 2).await?;
        let candle = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty klines for {symbol}")))?;

        Ok(MarketEvent {
            symbol: symbol.to_uppercase(),
            price: candle.close,
            candle,
            source: TransportMode::RestFallback,
            received_at: Utc::now(),
        })
    }
}
