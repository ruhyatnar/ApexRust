//! Exchange gateway built around the official Binance Rust Connector SDK
//! (`binance-sdk`), prioritizing WebSocket Streams & WebSocket API with
//! transparent REST API fallback.
//!
//! Reference: https://developers.binance.com/en/docs/sdks-tools/connectors/rust

pub mod binance_futures;
pub mod binance_rest;
pub mod binance_ws;
pub mod failover;

pub use binance_futures::BinanceFuturesClient;
pub use binance_rest::BinanceRestClient;
pub use binance_ws::BinanceWsDriver;
pub use failover::{FailoverGateway, FailoverHealth};

use binance_sdk::config::{ConfigurationRestApi, PrivateKey};
use bot_core::{
    AuthMethod, BotError, ExchangeConfig, ExchangeVenue, OrderExecutionMethod, Result, Side,
};
use rust_decimal::Decimal;
use std::env;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct LiveOrderRequest {
    pub symbol: String,
    pub side: Side,
    pub order_method: OrderExecutionMethod,
    pub quantity: f64,
    pub quote_order_qty: Option<f64>,
    pub limit_price: Option<f64>,
    pub take_profit_price: Option<f64>,
    pub stop_loss_price: Option<f64>,
    pub time_in_force: String,
    pub reduce_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LiveOrderAck {
    pub order_id: Option<String>,
    pub order_list_id: Option<i64>,
    pub algo_order_ids: Vec<i64>,
    pub executed_qty: f64,
    pub avg_price: f64,
}

/// Build an authenticated `binance-sdk` `ConfigurationRestApi` from `ExchangeConfig`
/// supporting both `HMAC-SHA256` (`api_secret`) and `Ed25519` (`PrivateKey::File` / inline PEM).
pub fn build_sdk_rest_config(cfg: &ExchangeConfig) -> Result<Option<ConfigurationRestApi>> {
    let creds = cfg.credentials.as_ref();
    let key_env = creds
        .map(|c| c.api_key_env.as_str())
        .unwrap_or("BINANCE_API_KEY");
    let secret_env = creds
        .map(|c| c.api_secret_env.as_str())
        .unwrap_or("BINANCE_API_SECRET");

    let Ok(api_key) = env::var(key_env) else {
        return Ok(None);
    };
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Ok(None);
    }

    let use_ed25519 = creds.is_some_and(|c| c.auth_method == AuthMethod::Ed25519);
    let key_path = creds
        .and_then(|c| c.ed25519_key_path.clone())
        .or_else(|| env::var("BINANCE_PRIVATE_KEY_PATH").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut builder = ConfigurationRestApi::builder().api_key(api_key);

    if use_ed25519 || key_path.is_some() {
        if let Some(path) = key_path {
            builder = builder.private_key(PrivateKey::File(path));
        } else if let Ok(inline_pem) = env::var("BINANCE_ED25519_PRIVATE_KEY") {
            let trimmed = inline_pem.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            builder = builder.private_key(PrivateKey::Raw(trimmed.as_bytes().to_vec()));
        } else {
            return Ok(None);
        }
    } else if let Ok(secret) = env::var(secret_env) {
        let trimmed = secret.trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }
        builder = builder.api_secret(trimmed);
    } else {
        return Ok(None);
    }

    let rest_cfg = builder
        .build()
        .map_err(|e| BotError::RestApi(format!("binance-sdk config error: {e}")))?;
    Ok(Some(rest_cfg))
}

pub(crate) fn to_binance_decimal(val: f64, decimals: u32) -> Result<Decimal> {
    if !val.is_finite() || val <= 0.0 {
        return Err(BotError::RestApi("Decimal quantity/price must be positive".into()));
    }
    let formatted = format!("{val:.prec$}", prec = decimals as usize);
    Decimal::from_str(&formatted)
        .map_err(|e| BotError::RestApi(format!("Invalid decimal '{formatted}': {e}")))
}

pub(crate) fn validate_live_safety(cfg: &ExchangeConfig, venue: ExchangeVenue, req: &LiveOrderRequest) -> Result<()> {
    if cfg.paper_trading {
        return Err(BotError::RestApi("Live order blocked: exchange.paper_trading = true".into()));
    }
    let creds = cfg
        .credentials
        .as_ref()
        .ok_or_else(|| BotError::RestApi("Live credentials config missing".into()))?;
    if !creds.armed_for_live_orders {
        return Err(BotError::RestApi("Live order blocked: armed_for_live_orders = false".into()));
    }
    if venue == ExchangeVenue::Spot && req.side == Side::Short && !req.reduce_only {
        return Err(BotError::RestApi("Spot venue cannot open Short positions".into()));
    }
    let est_notional = req.quote_order_qty.unwrap_or_else(|| {
        req.quantity * req.limit_price.unwrap_or(0.0)
    });
    if !req.reduce_only && est_notional > creds.max_order_notional_usdt {
        return Err(BotError::RestApi(format!(
            "Order notional ${est_notional:.2} exceeds max_order_notional_usdt (${:.2})",
            creds.max_order_notional_usdt
        )));
    }
    Ok(())
}
