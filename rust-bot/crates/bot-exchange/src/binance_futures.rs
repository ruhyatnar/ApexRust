use binance_sdk::config::ConfigurationRestApi;
use binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, MarginType, MarketEvent, Result, Side,
    TransportMode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::env;
use tracing::debug;

/// Official Binance USD-M Futures client built on top of
/// `binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi`
/// (https://developers.binance.com/en/docs/sdks-tools/connectors/rust).
///
/// Supports:
/// - USD-M Futures Testnet (`https://testnet.binancefuture.com`, `wss://stream.binancefuture.com/stream`)
/// - USD-M Futures Production (`https://fapi.binance.com`, `wss://fstream.binance.com/stream`)
/// - Two-sided Long & Short execution with Isolated/Crossed margin & configurable leverage
/// - Market, Limit (`GTC`/`IOC`/`FOK`), Post-Only (`GTX`), and TP/SL Bracket (`TAKE_PROFIT_MARKET` + `STOP_MARKET`)
pub struct BinanceFuturesClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<binance_sdk::derivatives_trading_usds_futures::rest_api::RestApi>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuturesOrderTicket {
    pub symbol: String,
    pub side: Side,
    pub quantity: f64,
    pub entry_price: Option<f64>,
    pub stop_loss_price: Option<f64>,
    pub take_profit_price: Option<f64>,
    pub post_only: bool,
    pub leverage: u8,
    pub margin_type: MarginType,
}

impl BinanceFuturesClient {
    pub fn new(cfg: ExchangeConfig) -> Result<Self> {
        let sdk_client = match (env::var("BINANCE_API_KEY"), env::var("BINANCE_PRIVATE_KEY_PATH")) {
            (Ok(api_key), Ok(key_path)) if !api_key.is_empty() => {
                let rest_cfg = ConfigurationRestApi::builder()
                    .api_key(api_key)
                    .private_key(binance_sdk::config::PrivateKey::File(key_path))
                    .build()
                    .map_err(|e| BotError::RestApi(format!("binance-sdk futures config error: {e}")))?;
                let client = match cfg.environment {
                    ExchangeEnvironment::Production => {
                        DerivativesTradingUsdsFuturesRestApi::production(rest_cfg)
                    }
                    ExchangeEnvironment::Testnet => {
                        DerivativesTradingUsdsFuturesRestApi::testnet(rest_cfg)
                    }
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

    pub fn rest_base_url(&self) -> &'static str {
        match self.cfg.environment {
            ExchangeEnvironment::Production => "https://fapi.binance.com",
            ExchangeEnvironment::Testnet => "https://testnet.binancefuture.com",
        }
    }

    pub fn ws_stream_url(&self) -> &'static str {
        match self.cfg.environment {
            ExchangeEnvironment::Production => "wss://fstream.binance.com/stream",
            ExchangeEnvironment::Testnet => "wss://stream.binancefuture.com/stream",
        }
    }

    pub fn has_authenticated_sdk(&self) -> bool {
        self.sdk_client.is_some()
    }

    /// Fetch USD-M Futures klines (`/fapi/v1/klines`) for warmup or REST fallback.
    pub async fn fetch_futures_klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
    ) -> Result<Vec<Candle>> {
        let url = format!(
            "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
            self.rest_base_url(),
            symbol.to_uppercase(),
            interval,
            limit
        );
        debug!(%url, "Fetching USD-M Futures klines");

        let rows: Vec<Vec<serde_json::Value>> = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures REST request failed: {e}")))?
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures JSON decode failed: {e}")))?;

        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 6 {
                continue;
            }
            candles.push(Candle {
                open_time_ms: row[0].as_i64().unwrap_or_default(),
                open: row[1].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                high: row[2].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                low: row[3].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                close: row[4].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                volume: row[5].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                is_closed: true,
            });
        }
        Ok(candles)
    }

    pub async fn poll_latest_futures_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_futures_klines(symbol, interval, 2).await?;
        let candle = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty Futures klines for {symbol}")))?;
        Ok(MarketEvent {
            symbol: symbol.to_uppercase(),
            price: candle.close,
            candle,
            source: TransportMode::RestFallback,
            received_at: Utc::now(),
        })
    }

    /// Translate a `FuturesOrderTicket` into canonical `/fapi/v1/order` JSON payloads
    /// including Post-Only (`GTX`) and `TAKE_PROFIT_MARKET` + `STOP_MARKET` OCO brackets.
    pub fn build_bracket_payloads(ticket: &FuturesOrderTicket) -> Vec<serde_json::Value> {
        let entry_side = match ticket.side {
            Side::Long => "BUY",
            Side::Short => "SELL",
        };
        let exit_side = match ticket.side {
            Side::Long => "SELL",
            Side::Short => "BUY",
        };

        let mut payloads = Vec::new();
        if let Some(limit_px) = ticket.entry_price {
            payloads.push(serde_json::json!({
                "endpoint": "/fapi/v1/order",
                "symbol": ticket.symbol.to_uppercase(),
                "side": entry_side,
                "type": "LIMIT",
                "timeInForce": if ticket.post_only { "GTX" } else { "GTC" },
                "quantity": format!("{:.6}", ticket.quantity),
                "price": format!("{:.4}", limit_px),
                "leverage": ticket.leverage,
                "marginType": match ticket.margin_type {
                    MarginType::Isolated => "ISOLATED",
                    MarginType::Crossed => "CROSSED",
                }
            }));
        } else {
            payloads.push(serde_json::json!({
                "endpoint": "/fapi/v1/order",
                "symbol": ticket.symbol.to_uppercase(),
                "side": entry_side,
                "type": "MARKET",
                "quantity": format!("{:.6}", ticket.quantity),
                "leverage": ticket.leverage
            }));
        }

        if let Some(tp_px) = ticket.take_profit_price {
            payloads.push(serde_json::json!({
                "endpoint": "/fapi/v1/order",
                "symbol": ticket.symbol.to_uppercase(),
                "side": exit_side,
                "type": "TAKE_PROFIT_MARKET",
                "stopPrice": format!("{:.4}", tp_px),
                "closePosition": true,
                "workingType": "MARK_PRICE",
                "priceProtect": "TRUE",
                "newOrderRespType": "RESULT"
            }));
        }

        if let Some(sl_px) = ticket.stop_loss_price {
            payloads.push(serde_json::json!({
                "endpoint": "/fapi/v1/order",
                "symbol": ticket.symbol.to_uppercase(),
                "side": exit_side,
                "type": "STOP_MARKET",
                "stopPrice": format!("{:.4}", sl_px),
                "closePosition": true,
                "workingType": "MARK_PRICE",
                "priceProtect": "TRUE",
                "newOrderRespType": "RESULT"
            }));
        }

        payloads
    }

    /// Construct canonical USD-M Futures `GET /fapi/v1/userTrades` signed query parameters
    /// for syncing filled entry and exit executions into `TradeHistoryView`.
    pub fn build_user_trades_query(symbol: &str, limit: u16, recv_window_ms: u64) -> serde_json::Value {
        serde_json::json!({
            "endpoint": "/fapi/v1/userTrades",
            "symbol": symbol.to_uppercase(),
            "limit": limit.min(1000),
            "recvWindow": recv_window_ms,
            "timestamp": Utc::now().timestamp_millis()
        })
    }
}
