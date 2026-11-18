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
use std::collections::HashMap;
use std::env;
use std::str::FromStr;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub(crate) struct SymbolFilters {
    pub tick_size: f64,
    pub tick_decimals: u32,
    pub step_size: f64,
    pub step_decimals: u32,
    pub market_step_size: f64,
    pub market_step_decimals: u32,
    pub fetched_at_ms: i64,
}

impl SymbolFilters {
    pub(crate) fn fallback(venue: ExchangeVenue, ref_price: f64) -> Self {
        let tick_decimals = if ref_price >= 100.0 { 2 } else { 4 };
        let tick_size = 10f64.powi(-(tick_decimals as i32));
        let (step_size, step_decimals) = match venue {
            ExchangeVenue::Futures => (0.001, 3),
            ExchangeVenue::Spot => (0.00001, 5),
        };
        Self {
            tick_size,
            tick_decimals,
            step_size,
            step_decimals,
            market_step_size: step_size,
            market_step_decimals: step_decimals,
            fetched_at_ms: 0,
        }
    }
}

pub(crate) fn count_step_decimals(step_str: &str) -> u32 {
    let trimmed = step_str.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Some((mantissa, exp)) = trimmed.split_once(['e', 'E']) {
        let exp_val = exp.trim_start_matches('-').parse::<u32>().unwrap_or(0);
        let frac = mantissa
            .split_once('.')
            .map(|(_, f)| f.trim_end_matches('0').len() as u32)
            .unwrap_or(0);
        return if exp.starts_with('-') { exp_val + frac } else { 0 };
    }
    if let Some((_, frac)) = trimmed.split_once('.') {
        frac.trim_end_matches('0').len() as u32
    } else {
        0
    }
}

pub(crate) async fn get_or_fetch_symbol_filters(
    http: &reqwest::Client,
    cache: &RwLock<HashMap<String, SymbolFilters>>,
    base_url: &str,
    venue: ExchangeVenue,
    symbol: &str,
    ref_price: f64,
) -> SymbolFilters {
    let key = format!("{:?}:{}", venue, symbol.to_uppercase());
    let now_ms = chrono::Utc::now().timestamp_millis();
    {
        let guard = cache.read().await;
        if let Some(cached) = guard.get(&key) {
            if now_ms - cached.fetched_at_ms < 600_000 {
                return cached.clone();
            }
        }
    }

    let sym = symbol.to_uppercase();
    let info_url = match venue {
        ExchangeVenue::Futures => format!("{base_url}/fapi/v1/exchangeInfo"),
        ExchangeVenue::Spot => format!("{base_url}/api/v3/exchangeInfo?symbol={sym}"),
    };
    if let Ok(resp) = http.get(&info_url).send().await {
        if let Ok(ok_resp) = resp.error_for_status() {
            if let Ok(json) = ok_resp.json::<serde_json::Value>().await {
                if let Some(sym_entry) = json
                    .get("symbols")
                    .and_then(|s| s.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find(|item| item.get("symbol").and_then(|v| v.as_str()) == Some(sym.as_str()))
                    })
                {
                    let filters = sym_entry
                        .get("filters")
                        .and_then(|f| f.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let find_str = |ft: &str, field: &str| -> Option<String> {
                        filters
                            .iter()
                            .find(|f| f.get("filterType").and_then(|v| v.as_str()) == Some(ft))
                            .and_then(|f| f.get(field))
                            .and_then(|v| v.as_str())
                            .map(ToOwned::to_owned)
                    };
                    let fb = SymbolFilters::fallback(venue, ref_price);
                    let tick_str = find_str("PRICE_FILTER", "tickSize");
                    let step_str = find_str("LOT_SIZE", "stepSize");
                    let mkt_step_str = find_str("MARKET_LOT_SIZE", "stepSize").or_else(|| step_str.clone());

                    let tick_size = tick_str
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|&v| v > 0.0)
                        .unwrap_or(fb.tick_size);
                    let tick_decimals = tick_str
                        .as_deref()
                        .map(count_step_decimals)
                        .unwrap_or(fb.tick_decimals);

                    let step_size = step_str
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|&v| v > 0.0)
                        .unwrap_or(fb.step_size);
                    let step_decimals = step_str
                        .as_deref()
                        .map(count_step_decimals)
                        .unwrap_or(fb.step_decimals);

                    let market_step_size = mkt_step_str
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|&v| v > 0.0)
                        .unwrap_or(step_size);
                    let market_step_decimals = mkt_step_str
                        .as_deref()
                        .map(count_step_decimals)
                        .unwrap_or(step_decimals);

                    let resolved = SymbolFilters {
                        tick_size,
                        tick_decimals,
                        step_size,
                        step_decimals,
                        market_step_size,
                        market_step_decimals,
                        fetched_at_ms: now_ms,
                    };
                    cache.write().await.insert(key, resolved.clone());
                    return resolved;
                }
            }
        }
    }
    SymbolFilters::fallback(venue, ref_price)
}

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
    pub bracket_warning: Option<String>,
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

    if use_ed25519 {
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

pub(crate) fn to_binance_step_decimal(val: f64, step: f64, decimals: u32) -> Result<Decimal> {
    if !val.is_finite() || val <= 0.0 {
        return Err(BotError::RestApi("Decimal quantity/price must be positive".into()));
    }
    let floored = if step > 0.0 {
        let steps = ((val + step * 1e-9) / step).floor();
        steps * step
    } else {
        val
    };
    if !floored.is_finite() || floored <= 0.0 {
        return Err(BotError::RestApi("Floored quantity/price underflowed step size".into()));
    }
    let formatted = format!("{floored:.prec$}", prec = decimals as usize);
    Decimal::from_str(&formatted)
        .map_err(|e| BotError::RestApi(format!("Invalid decimal '{formatted}': {e}")))
}

pub(crate) fn validate_live_safety(
    cfg: &ExchangeConfig,
    venue: ExchangeVenue,
    req: &LiveOrderRequest,
    ref_price: f64,
) -> Result<()> {
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
        let px = req
            .limit_price
            .filter(|&p| p > 0.0)
            .unwrap_or_else(|| ref_price.max(0.0));
        req.quantity * px
    });
    if !req.reduce_only && est_notional > creds.max_order_notional_usdt {
        return Err(BotError::RestApi(format!(
            "Order notional ${est_notional:.2} exceeds max_order_notional_usdt (${:.2})",
            creds.max_order_notional_usdt
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_decimals_handles_trailing_zeros_and_scientific_notation() {
        assert_eq!(count_step_decimals("1.0"), 0);
        assert_eq!(count_step_decimals("0.00100000"), 3);
        assert_eq!(count_step_decimals("1e-8"), 8);
        assert_eq!(count_step_decimals("2.5e-4"), 5);
        assert_eq!(count_step_decimals("0.010"), 2);
    }
}
