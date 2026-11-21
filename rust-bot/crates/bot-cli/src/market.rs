//! Public market data (no credentials) used by `screen`, `indicators` and `signal`.

use anyhow::{anyhow, Context};
use bot_core::{BotConfig, Candle, ExchangeVenue, MarketTicker24h};
use serde_json::Value;
use std::time::Duration;

pub struct MarketClient {
    base: String,
    venue: ExchangeVenue,
    http: reqwest::Client,
}

impl MarketClient {
    pub fn new(base: &str, venue: ExchangeVenue) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .context("Failed to build HTTP client")?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            venue,
            http,
        })
    }

    pub fn from_config(config: &BotConfig) -> anyhow::Result<Self> {
        Self::new(
            &crate::config_path::market_base(config),
            config.exchange.venue,
        )
    }

    fn prefix(&self) -> &'static str {
        match self.venue {
            ExchangeVenue::Spot => "/api/v3",
            ExchangeVenue::Futures => "/fapi/v1",
        }
    }

    pub async fn klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<Candle>> {
        let url = format!("{}{}/klines", self.base, self.prefix());
        let resp = self
            .http
            .get(&url)
            .query(&[
                ("symbol", symbol.trim().to_ascii_uppercase()),
                ("interval", interval.to_string()),
                ("limit", limit.clamp(1, 1500).to_string()),
            ])
            .send()
            .await
            .with_context(|| format!("Failed to reach {url}"))?;
        let status = resp.status();
        let payload: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(anyhow!(
                "Binance menolak klines {} (HTTP {}): {}",
                symbol,
                status.as_u16(),
                describe(&payload)
            ));
        }
        let rows = payload
            .as_array()
            .ok_or_else(|| anyhow!("Unexpected klines payload for {symbol}"))?;
        rows.iter()
            .map(parse_kline)
            .collect::<anyhow::Result<Vec<_>>>()
    }

    pub async fn tickers_24h(&self) -> anyhow::Result<Vec<MarketTicker24h>> {
        let url = format!("{}{}/ticker/24hr", self.base, self.prefix());
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("Failed to reach {url}"))?;
        let status = resp.status();
        let payload: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(anyhow!(
                "Binance menolak ticker 24h (HTTP {}): {}",
                status.as_u16(),
                describe(&payload)
            ));
        }
        let rows = payload
            .as_array()
            .ok_or_else(|| anyhow!("Unexpected 24h ticker payload"))?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        rows.iter()
            .map(|row| parse_ticker(row, self.venue, now_ms))
            .collect::<anyhow::Result<Vec<_>>>()
    }
}

fn describe(payload: &Value) -> String {
    payload
        .get("msg")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| payload.to_string().chars().take(160).collect())
}

fn as_f64(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn as_i64(value: &Value) -> i64 {
    match value {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// Parses one Binance kline row: `[openTime, open, high, low, close, volume, closeTime, ...]`.
pub fn parse_kline(row: &Value) -> anyhow::Result<Candle> {
    let items = row
        .as_array()
        .ok_or_else(|| anyhow!("Kline row is not an array"))?;
    if items.len() < 6 {
        return Err(anyhow!(
            "Kline row has {} fields, expected >= 6",
            items.len()
        ));
    }
    Ok(Candle {
        open_time_ms: as_i64(&items[0]),
        open: as_f64(&items[1]),
        high: as_f64(&items[2]),
        low: as_f64(&items[3]),
        close: as_f64(&items[4]),
        volume: as_f64(&items[5]),
        is_closed: true,
    })
}

/// Parses one `/ticker/24hr` object into the shared `MarketTicker24h` model.
pub fn parse_ticker(
    row: &Value,
    venue: ExchangeVenue,
    now_ms: i64,
) -> anyhow::Result<MarketTicker24h> {
    let symbol = row
        .get("symbol")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Ticker row without symbol"))?
        .to_string();
    let last_price = as_f64(row.get("lastPrice").unwrap_or(&Value::Null));
    let open_price = as_f64(row.get("openPrice").unwrap_or(&Value::Null));
    let high = as_f64(row.get("highPrice").unwrap_or(&Value::Null));
    let low = as_f64(row.get("lowPrice").unwrap_or(&Value::Null));
    let range_pct = if low > 0.0 {
        ((high - low) / low) * 100.0
    } else {
        0.0
    };
    Ok(MarketTicker24h {
        symbol,
        venue,
        last_price,
        open_price_24h: open_price,
        high_price_24h: high,
        low_price_24h: low,
        price_change_percent: as_f64(row.get("priceChangePercent").unwrap_or(&Value::Null)),
        base_volume: as_f64(row.get("volume").unwrap_or(&Value::Null)),
        quote_volume: as_f64(row.get("quoteVolume").unwrap_or(&Value::Null)),
        range_pct_24h: range_pct,
        tradable_on_active_env: true,
        in_watchlist: false,
        source_tag: None,
        updated_at_ms: now_ms,
        rvol_1h: None,
        momentum_1h_pct: None,
        cts_score: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_binance_kline_row() {
        let row = json!([
            1_700_000_000_000_i64,
            "100.5",
            "101.0",
            "99.5",
            "100.8",
            "12.345",
            1_700_000_299_999_i64,
            "1240.0",
            42,
            "6.1",
            "620.0",
            "0"
        ]);
        let candle = parse_kline(&row).expect("valid kline");
        assert_eq!(candle.open_time_ms, 1_700_000_000_000);
        assert!((candle.open - 100.5).abs() < 1e-9);
        assert!((candle.high - 101.0).abs() < 1e-9);
        assert!((candle.close - 100.8).abs() < 1e-9);
        assert!((candle.volume - 12.345).abs() < 1e-9);
    }

    #[test]
    fn rejects_short_kline_rows() {
        assert!(parse_kline(&json!([1, "2", "3"])).is_err());
        assert!(parse_kline(&json!("nope")).is_err());
    }

    #[test]
    fn parses_ticker_with_range_and_volume() {
        let row = json!({
            "symbol": "BTCUSDT",
            "lastPrice": "58000.10",
            "openPrice": "57000.00",
            "highPrice": "59000.00",
            "lowPrice": "56000.00",
            "priceChangePercent": "1.754",
            "volume": "12345.6",
            "quoteVolume": "710000000.0"
        });
        let ticker = parse_ticker(&row, ExchangeVenue::Spot, 42).unwrap();
        assert_eq!(ticker.symbol, "BTCUSDT");
        assert!((ticker.last_price - 58_000.10).abs() < 1e-6);
        assert!((ticker.range_pct_24h - (3_000.0 / 56_000.0 * 100.0)).abs() < 1e-9);
        assert_eq!(ticker.updated_at_ms, 42);
    }
}
