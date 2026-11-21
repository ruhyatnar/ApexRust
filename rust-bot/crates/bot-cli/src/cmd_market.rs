//! Public-data commands: `screen`, `indicators` and the `signal` dry-run.

use crate::config_path::load;
use crate::market::MarketClient;
use crate::ui::{compact, num, pct, Ui};
use anyhow::anyhow;
use bot_core::{BotConfig, Candle, IndicatorSnapshot, TrendingCategory};
use bot_indicators::IndicatorPipeline;
use bot_strategy::evaluate_entry_signal_with_options;
use serde_json::Value;
use std::path::Path;

fn parse_category(raw: &str) -> anyhow::Result<TrendingCategory> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "hot" | "volume" | "hot_volume" => Ok(TrendingCategory::HotVolume),
        "gainers" | "top_gainers" => Ok(TrendingCategory::TopGainers),
        "losers" | "top_losers" => Ok(TrendingCategory::TopLosers),
        "volatility" | "volatility_leaders" => Ok(TrendingCategory::VolatilityLeaders),
        "cts" | "cts_momentum" => Ok(TrendingCategory::CtsMomentum),
        other => Err(anyhow!(
            "Kategori tidak dikenal: {other} (pilih hot_volume|top_gainers|top_losers|volatility_leaders|cts_momentum)"
        )),
    }
}

/// Options gathered by the `screen` subcommand.
#[derive(Debug, Clone, Default)]
pub struct ScreenOptions<'a> {
    pub category: &'a str,
    pub limit: usize,
    pub min_quote_volume: Option<f64>,
    pub quote: Option<&'a str>,
    pub search: Option<&'a str>,
    pub json_out: bool,
}

fn category_label(category: TrendingCategory) -> &'static str {
    match category {
        TrendingCategory::HotVolume => "Hot volume",
        TrendingCategory::TopGainers => "Top gainers",
        TrendingCategory::TopLosers => "Top losers",
        TrendingCategory::VolatilityLeaders => "Volatility leaders",
        TrendingCategory::CtsMomentum => "CTS momentum",
    }
}

pub async fn screen(ui: Ui, config_path: &Path, options: ScreenOptions<'_>) -> anyhow::Result<()> {
    let ScreenOptions {
        category,
        limit,
        min_quote_volume,
        quote,
        search,
        json_out,
    } = options;
    let category = parse_category(category)?;
    let limit = if limit == 0 { 10 } else { limit };
    let config = load(config_path)?;
    let min_volume = min_quote_volume.unwrap_or(config.trading.trending_min_quote_volume_usdt);
    let quote_asset = quote.unwrap_or(&config.trading.quote_asset);
    let client = MarketClient::from_config(&config)?;

    let tickers = client.tickers_24h().await?;
    let ranked = bot_core::watchlist::rank_screener_tickers(
        &tickers,
        category,
        quote_asset,
        min_volume,
        false,
        limit,
        search,
    );

    if json_out {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "category": category,
                "quote": quote_asset,
                "min_quote_volume": min_volume,
                "count": ranked.len(),
                "tickers": ranked,
            })
        );
        return Ok(());
    }

    ui.title(&format!(
        "Screener — {} ({} quote, min {} volume)",
        category_label(category),
        quote_asset,
        compact(min_volume)
    ));
    let rows = ranked
        .iter()
        .enumerate()
        .map(|(idx, ticker)| {
            vec![
                (idx + 1).to_string(),
                ticker.symbol.clone(),
                num(ticker.last_price, 4),
                pct(ticker.price_change_percent, 2),
                format!("{:.2}%", ticker.range_pct_24h),
                compact(ticker.quote_volume),
            ]
        })
        .collect::<Vec<_>>();
    ui.table(
        &["#", "Symbol", "Price", "24h", "Range", "Quote Vol"],
        &rows,
    );
    if category == TrendingCategory::CtsMomentum && ranked.is_empty() {
        ui.warn("CTS butuh skor RVOL/momentum yang hanya dihitung daemon dari kandil 1 jam.");
        ui.hint("Jalankan daemon lalu pakai `apexrust snapshot`, atau pilih kategori lain.");
    } else if ranked.is_empty() {
        ui.warn(
            "Tidak ada pair yang lolos filter. Turunkan --min-quote-volume atau ganti kategori.",
        );
    }
    Ok(())
}

fn build_pipeline(config: &BotConfig) -> IndicatorPipeline {
    IndicatorPipeline::new(&config.indicators)
}

async fn load_candles(
    config: &BotConfig,
    symbol: &str,
    timeframe: &str,
    limit: usize,
) -> anyhow::Result<Vec<Candle>> {
    let client = MarketClient::from_config(config)?;
    let needed = limit.max(config.indicators.min_warmup_bars.saturating_add(10));
    client.klines(symbol, timeframe, needed).await
}

fn fmt_opt(value: Option<f64>, decimals: usize) -> String {
    value
        .map(|v| num(v, decimals))
        .unwrap_or_else(|| "-".into())
}

pub async fn indicators(
    ui: Ui,
    config_path: &Path,
    symbol: &str,
    timeframe: Option<&str>,
    limit: usize,
    json_out: bool,
) -> anyhow::Result<()> {
    let config = load(config_path)?;
    let timeframe = timeframe.unwrap_or(&config.trading.timeframe);
    let symbol = symbol.trim().to_ascii_uppercase();
    let candles = load_candles(&config, &symbol, timeframe, limit).await?;
    if candles.is_empty() {
        return Err(anyhow!("Binance tidak mengembalikan kandil untuk {symbol}"));
    }

    let mut pipeline = build_pipeline(&config);
    let mut latest = pipeline.snapshot();
    for candle in &candles {
        latest = pipeline.update(candle);
    }

    if json_out {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": candles.len(),
                "last_close": candles.last().map(|c| c.close),
                "indicators": latest,
            })
        );
        return Ok(());
    }

    ui.title(&format!(
        "Indicators — {symbol} {timeframe} ({} candles)",
        candles.len()
    ));
    if let Some(last) = candles.last() {
        ui.kv("Last close", &num(last.close, 6));
    }
    ui.kv(
        "EMA 9/21/50",
        &format!(
            "{} / {} / {}",
            fmt_opt(latest.ema_fast, 4),
            fmt_opt(latest.ema_mid, 4),
            fmt_opt(latest.ema_slow, 4)
        ),
    );
    ui.kv("EMA macro", &fmt_opt(latest.ema_macro, 4));
    ui.kv(
        "RSI",
        &format!(
            "{} (prev {})",
            fmt_opt(latest.rsi, 2),
            fmt_opt(latest.prev_rsi, 2)
        ),
    );
    ui.kv(
        "ADX / DI",
        &format!(
            "{} (+{} / -{})",
            fmt_opt(latest.adx, 2),
            fmt_opt(latest.plus_di, 2),
            fmt_opt(latest.minus_di, 2)
        ),
    );
    ui.kv("ATR", &fmt_opt(latest.atr, 4));
    ui.kv("ATR SMA50", &fmt_opt(latest.atr_sma_50, 4));
    ui.kv("VWAP", &fmt_opt(latest.vwap, 4));
    ui.kv(
        "Volume",
        &format!(
            "{} (ratio {})",
            fmt_opt(latest.avg_volume_20, 2),
            fmt_opt(latest.volume_ratio, 2)
        ),
    );
    if latest.htf_close.is_some() {
        ui.kv(
            "HTF 1h",
            &format!(
                "{} vs EMA {}",
                fmt_opt(latest.htf_close, 4),
                fmt_opt(latest.htf_ema_macro, 4)
            ),
        );
    }
    if latest.obi.is_some() {
        ui.kv("OBI", &fmt_opt(latest.obi, 3));
    }

    ui.section("Gate checks");
    let rows = gate_rows(&latest, &config);
    ui.table(
        &["Gate", "Value", "Required", "Status"],
        &rows
            .into_iter()
            .map(|(gate, value, required, pass)| {
                vec![
                    gate,
                    value,
                    required,
                    if pass {
                        "pass".into()
                    } else {
                        "blocked".into()
                    },
                ]
            })
            .collect::<Vec<_>>(),
    );
    if latest.warmup_bars_count < config.indicators.min_warmup_bars {
        ui.warn(&format!(
            "Baru {} dari {} bar warmup; sinyal belum boleh dipakai.",
            latest.warmup_bars_count, config.indicators.min_warmup_bars
        ));
    }
    Ok(())
}

fn gate_rows(
    snapshot: &IndicatorSnapshot,
    config: &BotConfig,
) -> Vec<(String, String, String, bool)> {
    let ind = &config.indicators;
    let mut rows = Vec::new();

    let trend_ok = match (snapshot.ema_fast, snapshot.ema_mid, snapshot.ema_slow) {
        (Some(fast), Some(mid), Some(slow)) => fast > mid && mid > slow,
        _ => false,
    };
    rows.push((
        "EMA 9 > 21 > 50".to_string(),
        format!(
            "{} / {} / {}",
            fmt_opt(snapshot.ema_fast, 2),
            fmt_opt(snapshot.ema_mid, 2),
            fmt_opt(snapshot.ema_slow, 2)
        ),
        "bullish stack".to_string(),
        trend_ok,
    ));

    let macro_ok = match (snapshot.ema_macro, snapshot.ema_mid) {
        (Some(macro_ema), Some(mid)) => mid > macro_ema,
        _ => !ind.require_macro_ema_in_scalping,
    };
    rows.push((
        "Macro EMA 200".to_string(),
        fmt_opt(snapshot.ema_macro, 2),
        if ind.require_macro_ema_in_scalping {
            "mid above macro".to_string()
        } else {
            "not required".to_string()
        },
        macro_ok,
    ));

    let rsi_ok = snapshot
        .rsi
        .map(|rsi| rsi >= ind.rsi_long_pullback_min && rsi <= ind.rsi_long_pullback_max)
        .unwrap_or(false);
    rows.push((
        "RSI pullback band".to_string(),
        fmt_opt(snapshot.rsi, 2),
        format!(
            "{}–{}",
            ind.rsi_long_pullback_min, ind.rsi_long_pullback_max
        ),
        rsi_ok,
    ));

    let adx_ok = snapshot
        .adx
        .map(|adx| adx >= ind.adx_min_trend)
        .unwrap_or(false)
        && snapshot
            .prev_adx
            .zip(snapshot.adx)
            .map(|(prev, cur)| !ind.require_rising_adx || cur >= prev)
            .unwrap_or(true);
    rows.push((
        "ADX strength".to_string(),
        fmt_opt(snapshot.adx, 2),
        format!(
            ">= {} (rising: {})",
            ind.adx_min_trend, ind.require_rising_adx
        ),
        adx_ok,
    ));

    let di_ok = match (snapshot.plus_di, snapshot.minus_di) {
        (Some(plus), Some(minus)) => plus - minus >= ind.min_di_spread,
        _ => false,
    };
    rows.push((
        "DI spread".to_string(),
        format!(
            "{} - {}",
            fmt_opt(snapshot.plus_di, 2),
            fmt_opt(snapshot.minus_di, 2)
        ),
        format!(">= {}", ind.min_di_spread),
        di_ok,
    ));

    let vwap_ok = match (snapshot.vwap, snapshot.ema_mid) {
        (Some(vwap), Some(mid)) => !ind.require_vwap_alignment || mid >= vwap,
        _ => !ind.require_vwap_alignment,
    };
    rows.push((
        "VWAP alignment".to_string(),
        fmt_opt(snapshot.vwap, 2),
        if ind.require_vwap_alignment {
            "price above VWAP".to_string()
        } else {
            "not required".to_string()
        },
        vwap_ok,
    ));

    let volume_ok = snapshot
        .volume_ratio
        .map(|ratio| ratio >= ind.min_volume_expansion_mult)
        .unwrap_or(false);
    rows.push((
        "Volume expansion".to_string(),
        fmt_opt(snapshot.volume_ratio, 2),
        format!(">= {}", ind.min_volume_expansion_mult),
        volume_ok,
    ));

    let warmup_ok = snapshot.warmup_bars_count >= ind.min_warmup_bars;
    rows.push((
        "Warmup bars".to_string(),
        snapshot.warmup_bars_count.to_string(),
        format!(">= {}", ind.min_warmup_bars),
        warmup_ok,
    ));

    if ind.atr_expansion_filter_enabled {
        let ratio = match (snapshot.atr, snapshot.atr_sma_50) {
            (Some(atr), Some(sma)) if sma > 0.0 => Some(atr / sma),
            _ => None,
        };
        rows.push((
            "ATR expansion".to_string(),
            ratio.map(|r| num(r, 2)).unwrap_or_else(|| "-".into()),
            format!(">= {}", ind.atr_expansion_min_ratio),
            ratio
                .map(|r| r >= ind.atr_expansion_min_ratio)
                .unwrap_or(false),
        ));
    }

    rows
}

pub async fn signal(
    ui: Ui,
    config_path: &Path,
    symbol: &str,
    timeframe: Option<&str>,
    limit: usize,
    json_out: bool,
) -> anyhow::Result<()> {
    let mut config = load(config_path)?;
    let timeframe = timeframe.unwrap_or(&config.trading.timeframe).to_string();
    let symbol = symbol.trim().to_ascii_uppercase();
    let candles = load_candles(&config, &symbol, &timeframe, limit).await?;
    if candles.len() < config.indicators.min_warmup_bars {
        ui.warn(&format!(
            "Hanya {} kandil tersedia; butuh minimal {} untuk warmup.",
            candles.len(),
            config.indicators.min_warmup_bars
        ));
    }
    let mut pipeline = build_pipeline(&config);
    let mut latest = pipeline.snapshot();
    for candle in &candles {
        latest = pipeline.update(candle);
    }
    let Some(last_candle) = candles.last().cloned() else {
        return Err(anyhow!("Binance tidak mengembalikan kandil untuk {symbol}"));
    };

    if !config.features.signal_generator {
        config.features.signal_generator = true;
        if !json_out {
            ui.warn("signal_generator dimatikan di config; diaktifkan sementara untuk diagnosa.");
        }
    }

    let recent = candles
        .iter()
        .rev()
        .take(60)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let signal = evaluate_entry_signal_with_options(
        &symbol,
        &last_candle,
        &latest,
        &config,
        &recent,
        chrono::Utc::now(),
        None,
        None,
        true,
    );

    if json_out {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "symbol": symbol,
                "timeframe": timeframe,
                "signal": signal,
                "indicators": latest,
            })
        );
        return Ok(());
    }

    ui.title(&format!("Signal dry-run — {symbol} {timeframe}"));
    match signal {
        Some(signal) => {
            ui.ok("Sinyal entry terdeteksi.");
            ui.kv("Side", &format!("{:?}", signal.side).to_lowercase());
            ui.kv("Entry", &num(signal.entry_price, 6));
            ui.kv("ATR", &num(signal.atr, 4));
            ui.kv(
                "ADX / RSI",
                &format!("{} / {}", num(signal.adx, 2), num(signal.rsi, 2)),
            );
            ui.kv("Rationale", &signal.rationale);
            ui.hint("Tidak ada order dikirim; ini hanya evaluasi strategi.");
        }
        None => {
            ui.warn("Tidak ada sinyal pada kandil terakhir.");
            let rows = gate_rows(&latest, &config);
            let blocked = rows
                .into_iter()
                .filter(|(_, _, _, pass)| !pass)
                .map(|(gate, value, required, _)| vec![gate, value, required])
                .collect::<Vec<_>>();
            if blocked.is_empty() {
                ui.hint(
                    "Semua gate lolos; sinyal bisa tertahan oleh filter kualitas candle/spread.",
                );
            } else {
                ui.section("Gate yang menahan");
                ui.table(&["Gate", "Value", "Required"], &blocked);
            }
        }
    }
    Ok(())
}

/// Unused helper kept for JSON diagnostics in future commands.
#[allow(dead_code)]
fn describe_value(value: &Value) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_category_aliases() {
        assert!(matches!(
            parse_category("cts").unwrap(),
            TrendingCategory::CtsMomentum
        ));
        assert!(matches!(
            parse_category("HOT_VOLUME").unwrap(),
            TrendingCategory::HotVolume
        ));
        assert!(parse_category("nope").is_err());
    }

    #[test]
    fn gate_rows_cover_core_filters() {
        let config =
            load(&crate::config_path::repo_root().join("rust-bot/config/bot.example.toml"))
                .unwrap();
        let snapshot = IndicatorSnapshot {
            ema_fast: Some(110.0),
            ema_mid: Some(105.0),
            ema_slow: Some(100.0),
            ema_macro: Some(90.0),
            prev_ema_mid: Some(104.0),
            rsi: Some(50.0),
            prev_rsi: Some(48.0),
            adx: Some(30.0),
            prev_adx: Some(28.0),
            plus_di: Some(30.0),
            minus_di: Some(20.0),
            atr: Some(1.5),
            prev_atr: Some(1.4),
            vwap: Some(104.0),
            avg_volume_20: Some(100.0),
            volume_ratio: Some(2.0),
            atr_sma_50: Some(1.0),
            htf_close: None,
            htf_ema_macro: None,
            obi: None,
            warmup_bars_count: 200,
            has_bar_gap: false,
        };
        let rows = gate_rows(&snapshot, &config);
        assert!(rows.iter().any(|(gate, ..)| gate.contains("EMA")));
        assert!(rows.iter().any(|(gate, ..)| gate.contains("RSI")));
        assert!(rows.iter().all(|(_, value, ..)| !value.is_empty()));
    }
}
