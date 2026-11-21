//! Exchange gateway built around the official Binance Rust Connector SDK
//! (`binance-sdk`), prioritizing WebSocket Streams & WebSocket API with
//! transparent REST API fallback.
//!
//! Reference: https://developers.binance.com/en/docs/sdks-tools/connectors/rust

pub mod binance_futures;
pub mod binance_rest;
pub mod binance_ws;
pub mod failover;
pub mod user_stream;
pub mod ws_api;

pub use binance_futures::BinanceFuturesClient;
pub use binance_rest::BinanceRestClient;
pub use binance_ws::{BinanceWsDriver, WsStreamEvent};
pub use user_stream::{OrderUpdate, UserDataStream, UserStreamEvent};
pub use failover::{FailoverGateway, FailoverHealth};
pub use ws_api::{WsApiClient, WsApiCredentials};

use binance_sdk::config::{ConfigurationRestApi, PrivateKey};
use bot_core::{
    AuthMethod, BotError, ExchangeConfig, ExchangeVenue, MarketTicker24h, OrderExecutionMethod,
    Result, Side,
};
use chrono::Utc;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::env;
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub(crate) struct SymbolFilters {
    pub base_asset: Option<String>,
    pub tick_size: f64,
    pub tick_decimals: u32,
    pub min_price: f64,
    pub max_price: f64,
    pub step_size: f64,
    pub step_decimals: u32,
    pub min_qty: f64,
    pub max_qty: f64,
    pub market_step_size: f64,
    pub market_step_decimals: u32,
    pub market_min_qty: f64,
    pub market_max_qty: f64,
    pub min_notional: f64,
    pub max_notional: f64,
    pub quote_decimals: u32,
    pub fetched_at_ms: i64,
}

impl SymbolFilters {
    pub(crate) fn fallback(venue: ExchangeVenue, ref_price: f64) -> Self {
        let tick_decimals = if ref_price >= 100.0 {
            2
        } else if ref_price >= 1.0 {
            4
        } else if ref_price >= 0.01 {
            6
        } else {
            8
        };
        let tick_size = 10f64.powi(-(tick_decimals as i32));
        let (step_size, step_decimals) = match venue {
            ExchangeVenue::Futures => (0.001, 3),
            ExchangeVenue::Spot => (0.00001, 5),
        };
        Self {
            base_asset: None,
            tick_size,
            tick_decimals,
            min_price: 0.0,
            max_price: 0.0,
            step_size,
            step_decimals,
            min_qty: step_size,
            max_qty: 0.0,
            market_step_size: step_size,
            market_step_decimals: step_decimals,
            market_min_qty: step_size,
            market_max_qty: 0.0,
            min_notional: 5.0,
            max_notional: 0.0,
            quote_decimals: 2,
            fetched_at_ms: 0,
        }
    }
}

const KNOWN_QUOTES: &[&str] = &[
    "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "TRY", "JPY", "BRL", "AUD", "GBP", "BNB", "ETH", "BTC",
];

pub(crate) fn extract_base_asset(symbol: &str, filters: &SymbolFilters) -> String {
    if let Some(ref b) = filters.base_asset {
        if !b.trim().is_empty() {
            return b.trim().to_uppercase();
        }
    }
    let upper = symbol.trim().to_uppercase();
    for q in KNOWN_QUOTES {
        if upper.len() > q.len() && upper.ends_with(q) {
            return upper[..upper.len() - q.len()].to_string();
        }
    }
    upper
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
    rate_budget: &RestRateBudget,
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
        rate_budget.report_response(resp.status(), resp.headers());
        if let Ok(ok_resp) = resp.error_for_status() {
            if let Ok(json) = ok_resp.json::<serde_json::Value>().await {
                if let Some(arr) = json.get("symbols").and_then(|s| s.as_array()) {
                    let mut write_cache = cache.write().await;
                    for sym_entry in arr {
                        let Some(entry_sym) = sym_entry.get("symbol").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        let entry_upper = entry_sym.to_uppercase();
                        let entry_key = format!("{:?}:{}", venue, entry_upper);
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
                        let mkt_step_str =
                            find_str("MARKET_LOT_SIZE", "stepSize").or_else(|| step_str.clone());
                        let tick_size = tick_str
                            .as_deref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .filter(|&v| v > 0.0)
                            .unwrap_or(fb.tick_size);
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
                        let min_qty = find_str("LOT_SIZE", "minQty")
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let max_qty = find_str("LOT_SIZE", "maxQty")
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let market_min_qty = find_str("MARKET_LOT_SIZE", "minQty")
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(min_qty);
                        let market_max_qty = find_str("MARKET_LOT_SIZE", "maxQty")
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(max_qty);
                        let min_notional = find_str("NOTIONAL", "minNotional")
                            .or_else(|| find_str("MIN_NOTIONAL", "minNotional"))
                            .or_else(|| find_str("MIN_NOTIONAL", "notional"))
                            .and_then(|s| s.parse::<f64>().ok())
                            .filter(|&v| v > 0.0)
                            .unwrap_or(5.0);
                        let max_notional = find_str("NOTIONAL", "maxNotional")
                            .or_else(|| find_str("MIN_NOTIONAL", "maxNotional"))
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let quote_decimals = sym_entry
                            .get("quoteAssetPrecision")
                            .or_else(|| sym_entry.get("quotePrecision"))
                            .and_then(|v| v.as_u64())
                            .map(|p| (p as u32).clamp(2, 8))
                            .unwrap_or(2);
                        let resolved = SymbolFilters {
                            base_asset: sym_entry
                                .get("baseAsset")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_uppercase()),
                            tick_size,
                            tick_decimals: tick_str
                                .as_deref()
                                .map(count_step_decimals)
                                .unwrap_or(fb.tick_decimals),
                            min_price: find_str("PRICE_FILTER", "minPrice")
                                .and_then(|s| s.parse::<f64>().ok())
                                .unwrap_or(0.0),
                            max_price: find_str("PRICE_FILTER", "maxPrice")
                                .and_then(|s| s.parse::<f64>().ok())
                                .unwrap_or(0.0),
                            step_size,
                            step_decimals,
                            min_qty,
                            max_qty,
                            market_step_size,
                            market_step_decimals: mkt_step_str
                                .as_deref()
                                .map(count_step_decimals)
                                .unwrap_or(step_decimals),
                            market_min_qty,
                            market_max_qty,
                            min_notional,
                            max_notional,
                            quote_decimals,
                            fetched_at_ms: now_ms,
                        };
                        write_cache.insert(entry_key, resolved);
                    }
                    if let Some(matched) = write_cache.get(&key) {
                        return matched.clone();
                    }
                }
            }
        }
    }
    SymbolFilters::fallback(venue, ref_price)
}

#[derive(Debug, Clone)]
pub struct ExchangeOrderStatus {
    pub order_id: String,
    pub status: String,
    pub executed_qty: f64,
    pub avg_price: f64,
}

#[derive(Debug, Clone)]
pub enum CancelOrderOutcome {
    Canceled,
    AlreadyFilled(ExchangeOrderStatus),
}

#[derive(Debug, Default)]
pub struct RestRateBudget {
    used_weight_1m: AtomicU64,
    updated_at_ms: AtomicI64,
    blocked_until_ms: AtomicI64,
}

impl RestRateBudget {
    pub fn report_response(
        &self,
        status: reqwest::StatusCode,
        headers: &reqwest::header::HeaderMap,
    ) {
        let now_ms = Utc::now().timestamp_millis();
        if let Some(w) = headers
            .get("x-mbx-used-weight-1m")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            self.used_weight_1m.store(w, Ordering::Relaxed);
            self.updated_at_ms.store(now_ms, Ordering::Relaxed);
        }
        let code = status.as_u16();
        if code == 429 || code == 418 {
            let retry_sec = headers
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<i64>().ok())
                .filter(|&s| s > 0)
                .unwrap_or(if code == 418 { 120 } else { 15 });
            let until = now_ms + retry_sec * 1000;
            let _ = self.blocked_until_ms.fetch_max(until, Ordering::Relaxed);
        }
    }

    pub fn used_weight(&self) -> u64 {
        let now_ms = Utc::now().timestamp_millis();
        let last = self.updated_at_ms.load(Ordering::Relaxed);
        if last == 0 || now_ms.saturating_sub(last) > 65_000 {
            0
        } else {
            self.used_weight_1m.load(Ordering::Relaxed)
        }
    }

    pub fn is_constrained(&self, venue: ExchangeVenue) -> bool {
        let now_ms = Utc::now().timestamp_millis();
        if self.blocked_until_ms.load(Ordering::Relaxed) > now_ms {
            return true;
        }
        let limit = match venue {
            ExchangeVenue::Futures => 2400,
            ExchangeVenue::Spot => 6000,
        };
        self.used_weight() >= (limit * 7) / 10
    }
}

pub(crate) fn parse_tradable_symbols_from_exchange_info(
    venue: ExchangeVenue,
    val: &serde_json::Value,
) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(list) = val.get("symbols").and_then(|s| s.as_array()) else {
        return out;
    };
    for s in list {
        let Some(sym) = s.get("symbol").and_then(|v| v.as_str()) else {
            continue;
        };
        let status = s
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_uppercase();
        if status != "TRADING" {
            continue;
        }
        match venue {
            ExchangeVenue::Futures => {
                if s.get("contractType")
                    .and_then(|v| v.as_str())
                    .is_some_and(|ct| !ct.eq_ignore_ascii_case("PERPETUAL"))
                {
                    continue;
                }
            }
            ExchangeVenue::Spot => {
                if s.get("isSpotTradingAllowed")
                    .and_then(|v| v.as_bool())
                    == Some(false)
                {
                    continue;
                }
            }
        }
        out.insert(sym.trim().to_uppercase());
    }
    out
}

pub(crate) fn parse_ticker_24h_array(
    venue: ExchangeVenue,
    rows: &[serde_json::Value],
) -> Vec<MarketTicker24h> {
    let now_ms = Utc::now().timestamp_millis();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Some(sym) = r.get("symbol").and_then(|v| v.as_str()) else {
            continue;
        };
        let parse_f = |k: &str| -> f64 {
            r.get(k)
                .and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64()))
                .unwrap_or(0.0)
        };
        let last_price = parse_f("lastPrice");
        if !last_price.is_finite() || last_price <= 0.0 {
            continue;
        }
        let open_price = parse_f("openPrice");
        let high_price = parse_f("highPrice");
        let low_price = parse_f("lowPrice");
        let base_volume = parse_f("volume");
        let quote_volume = parse_f("quoteVolume");
        let price_change_percent = parse_f("priceChangePercent");
        let range_pct_24h = if low_price > 0.0 && high_price >= low_price {
            ((high_price - low_price) / low_price.max(1e-12)) * 100.0
        } else {
            0.0
        };
        out.push(MarketTicker24h {
            symbol: sym.trim().to_uppercase(),
            venue,
            last_price,
            open_price_24h: if open_price > 0.0 { open_price } else { last_price },
            high_price_24h: if high_price > 0.0 { high_price } else { last_price },
            low_price_24h: if low_price > 0.0 { low_price } else { last_price },
            price_change_percent,
            base_volume,
            quote_volume,
            range_pct_24h,
            tradable_on_active_env: true,
            in_watchlist: false,
            source_tag: None,
            updated_at_ms: r.get("closeTime").and_then(|v| v.as_i64()).unwrap_or(now_ms),
            rvol_1h: None,
            momentum_1h_pct: None,
            cts_score: None,
        });
    }
    out
}

#[derive(Debug, Clone)]
pub struct ExchangeOpenPosition {
    pub symbol: String,
    pub position_amt: f64,
    pub unrealized_pnl: f64,
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
    pub status: String,
    pub filled: bool,
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
        } else if let Ok(inline_pem) = env::var("BINANCE_ED25519_PRIVATE_KEY").or_else(|_| env::var(secret_env)) {
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
    if !req.reduce_only && req.quote_order_qty.is_none() && req.limit_price.is_none() && ref_price <= 0.0 {
        return Err(BotError::RestApi(
            "Unable to determine live reference price for order notional safety check".into(),
        ));
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

pub(crate) fn validate_exchange_filters(
    symbol: &str,
    filters: &SymbolFilters,
    price_num: Option<f64>,
    qty_num: Option<f64>,
    est_notional: f64,
    is_market: bool,
    reduce_only: bool,
) -> Result<()> {
    if let Some(px) = price_num {
        if filters.min_price > 0.0 && px < filters.min_price {
            return Err(BotError::RestApi(format!(
                "Price {px} below Binance minPrice ({}) for {symbol}",
                filters.min_price
            )));
        }
        if filters.max_price > 0.0 && px > filters.max_price {
            return Err(BotError::RestApi(format!(
                "Price {px} exceeds Binance maxPrice ({}) for {symbol}",
                filters.max_price
            )));
        }
    }
    if let Some(qty) = qty_num {
        let min_q = if is_market { filters.market_min_qty } else { filters.min_qty };
        let max_q = if is_market { filters.market_max_qty } else { filters.max_qty };
        if min_q > 0.0 && qty < min_q {
            return Err(BotError::RestApi(format!(
                "Quantity {qty} below Binance minQty ({min_q}) for {symbol}"
            )));
        }
        if max_q > 0.0 && qty > max_q {
            return Err(BotError::RestApi(format!(
                "Quantity {qty} exceeds Binance maxQty ({max_q}) for {symbol}"
            )));
        }
    }
    if !reduce_only && est_notional > 0.0 {
        if filters.min_notional > 0.0 && est_notional < filters.min_notional {
            return Err(BotError::RestApi(format!(
                "Order notional ${est_notional:.2} below Binance MIN_NOTIONAL (${:.2}) for {symbol}",
                filters.min_notional
            )));
        }
        if filters.max_notional > 0.0 && est_notional > filters.max_notional {
            return Err(BotError::RestApi(format!(
                "Order notional ${est_notional:.2} exceeds Binance maxNotional (${:.2}) for {symbol}",
                filters.max_notional
            )));
        }
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

    #[test]
    fn fallback_filters_preserve_sub_cent_precision() {
        let btc = SymbolFilters::fallback(ExchangeVenue::Spot, 65_000.0);
        assert_eq!(btc.tick_decimals, 2);
        let sol = SymbolFilters::fallback(ExchangeVenue::Spot, 12.5);
        assert_eq!(sol.tick_decimals, 4);
        let doge = SymbolFilters::fallback(ExchangeVenue::Futures, 0.085);
        assert_eq!(doge.tick_decimals, 6);
        let pepe = SymbolFilters::fallback(ExchangeVenue::Spot, 0.00001234);
        assert_eq!(pepe.tick_decimals, 8);
        assert!((pepe.tick_size - 1e-8).abs() < 1e-12);
    }
}
