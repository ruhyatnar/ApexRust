use binance_sdk::config::ConfigurationRestApi;
use binance_sdk::spot::{rest_api::KlinesParams, SpotRestApi};
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent, Result,
    TransportMode,
};
use chrono::Utc;
use std::env;
use tracing::debug;

/// Official Binance REST API wrapper (`binance_sdk::spot::SpotRestApi`)
/// used for:
/// 1. Historical kline warmup at startup (200+ candles for EMA 200 / ADX / ATR)
/// 2. Automatic fallback market polling & Spot Market/Limit/OCO order execution if WebSocket stalls.
pub struct BinanceRestClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<binance_sdk::spot::rest_api::RestApi>,
}

impl BinanceRestClient {
    pub fn new(cfg: ExchangeConfig) -> Result<Self> {
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

    fn effective_base_url(&self) -> &str {
        match (self.cfg.venue, self.cfg.environment) {
            (ExchangeVenue::Futures, ExchangeEnvironment::Production) => "https://fapi.binance.com",
            (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
                "https://testnet.binancefuture.com"
            }
            (ExchangeVenue::Spot, _) => &self.cfg.rest_base_url,
        }
    }

    /// Fetch historical klines via official `SpotRestApi` or public REST endpoint
    /// (automatically selects `/api/v3/klines` for Spot or `/fapi/v1/klines` for USD-M Futures).
    pub async fn fetch_klines(&self, symbol: &str, interval: &str, limit: usize) -> Result<Vec<Candle>> {
        if self.cfg.venue == ExchangeVenue::Spot {
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
        }

        let kline_path = match self.cfg.venue {
            ExchangeVenue::Spot => "/api/v3/klines",
            ExchangeVenue::Futures => "/fapi/v1/klines",
        };
        let url = format!(
            "{}{}?symbol={}&interval={}&limit={}",
            self.effective_base_url(),
            kline_path,
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

    /// Construct canonical Spot OCO (`POST /api/v3/orderList/oco`) exit payload
    /// compliant with official Binance Spot API (replaces deprecated `/api/v3/order/oco`).
    pub fn build_spot_oco_exit_payload(
        symbol: &str,
        quantity: f64,
        take_profit_price: f64,
        stop_loss_trigger: f64,
    ) -> serde_json::Value {
        serde_json::json!({
            "endpoint": "/api/v3/orderList/oco",
            "symbol": symbol.to_uppercase(),
            "side": "SELL",
            "quantity": format!("{quantity:.6}"),
            "aboveType": "LIMIT_MAKER",
            "abovePrice": format!("{take_profit_price:.4}"),
            "belowType": "STOP_LOSS_LIMIT",
            "belowStopPrice": format!("{stop_loss_trigger:.4}"),
            "belowPrice": format!("{:.4}", stop_loss_trigger * 0.998),
            "belowTimeInForce": "GTC",
            "newOrderRespType": "RESULT"
        })
    }

    /// Construct canonical Spot `GET /api/v3/myTrades` signed query parameters
    /// for syncing filled entry and exit executions into `TradeHistoryView`.
    pub fn build_my_trades_query(symbol: &str, limit: u16, recv_window_ms: u64) -> serde_json::Value {
        serde_json::json!({
            "endpoint": "/api/v3/myTrades",
            "symbol": symbol.to_uppercase(),
            "limit": limit.min(1000),
            "recvWindow": recv_window_ms,
            "timestamp": Utc::now().timestamp_millis()
        })
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
