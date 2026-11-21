use crate::{
    MarketTicker24h, PairSelectionMode, PairSourceTag, TradingConfig, TrendingCategory,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const MAX_WATCHLIST_HARD_CAP: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWatchlistEntry {
    pub symbol: String,
    pub source_tag: PairSourceTag,
}

#[derive(Debug, Clone, Default)]
pub struct WatchlistDwellState {
    pub entered_at_ms: HashMap<String, i64>,
}

pub fn sanitize_trading_symbol(raw: &str) -> String {
    raw.trim()
        .to_ascii_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

pub fn normalize_symbol_list(raw: &[String], fallback: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in raw {
        let sym = sanitize_trading_symbol(item);
        if sym.len() >= 4 && seen.insert(sym.clone()) {
            out.push(sym);
        }
    }
    if out.is_empty() {
        fallback.to_vec()
    } else {
        out
    }
}

pub fn timeframe_to_ms(tf: &str) -> i64 {
    match tf.trim() {
        "1m" => 60_000,
        "3m" => 180_000,
        "5m" => 300_000,
        "15m" => 900_000,
        "30m" => 1_800_000,
        "1h" => 3_600_000,
        "2h" => 7_200_000,
        "4h" => 14_400_000,
        "6h" => 21_600_000,
        "8h" => 28_800_000,
        "12h" => 43_200_000,
        "1d" => 86_400_000,
        _ => 300_000,
    }
}

/// Returns true if consecutive closed candles skipped >= 1 bar (> 1.5x timeframe).
pub fn has_candle_sequence_gap(prev_open_time_ms: Option<i64>, next_open_time_ms: i64, tf: &str) -> bool {
    let Some(prev) = prev_open_time_ms else {
        return false;
    };
    if prev <= 0 || next_open_time_ms <= prev {
        return false;
    }
    let step = timeframe_to_ms(tf) as f64;
    (next_open_time_ms - prev) as f64 > step * 1.5
}

/// Cliff-normalizes a value into `[0, 1]`.
fn clamp01(value: f64) -> f64 {
    if !value.is_finite() {
        0.0
    } else {
        value.clamp(0.0, 1.0)
    }
}

pub fn median_f64(values: &[f64]) -> f64 {
    let mut clean: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if clean.is_empty() {
        return 0.0;
    }
    clean.sort_by(f64::total_cmp);
    let mid = clean.len() / 2;
    if clean.len().is_multiple_of(2) {
        (clean[mid - 1] + clean[mid]) / 2.0
    } else {
        clean[mid]
    }
}

/// Composite Trend Score (CTS): RVOL + 1h momentum + relative volume.
///
/// Every component is normalized into `[0, 1]` before weighting, so a single
/// unbounded term (raw USDT volume of BTC-sized symbols) can never dominate.
/// Returns `None` when RVOL is unavailable (e.g. a listing younger than 24h).
pub fn compute_cts_score(
    rvol_1h: f64,
    momentum_1h_pct: f64,
    quote_volume: f64,
    median_quote_volume: f64,
    weights: (f64, f64, f64),
) -> Option<f64> {
    if !rvol_1h.is_finite() || rvol_1h <= 0.0 {
        return None;
    }
    let (w_rvol, w_momentum, w_volume) = (
        weights.0.max(0.0),
        weights.1.max(0.0),
        weights.2.max(0.0),
    );
    let total = w_rvol + w_momentum + w_volume;
    if total <= 0.0 {
        return None;
    }
    let rvol_score = clamp01(rvol_1h / 3.0);
    let momentum = if momentum_1h_pct.is_finite() { momentum_1h_pct } else { 0.0 };
    let momentum_score = clamp01(momentum / 5.0 * 0.5 + 0.5);
    let rel_volume = if median_quote_volume > 0.0 {
        quote_volume / median_quote_volume
    } else {
        0.0
    };
    let volume_score = clamp01(rel_volume / 10.0);
    Some(
        (rvol_score * w_rvol + momentum_score * w_momentum + volume_score * w_volume) / total,
    )
}

pub fn rank_screener_tickers(
    tickers: &[MarketTicker24h],
    category: TrendingCategory,
    quote_asset: &str,
    min_quote_volume_usdt: f64,
    only_tradable: bool,
    limit: usize,
    search_query: Option<&str>,
) -> Vec<MarketTicker24h> {
    let quote = {
        let q = quote_asset.trim().to_ascii_uppercase();
        if q.is_empty() { "USDT".to_string() } else { q }
    };
    let min_vol = min_quote_volume_usdt.max(0.0);
    let query = search_query.map(sanitize_trading_symbol).unwrap_or_default();
    let cap = limit.clamp(1, 200);

    let mut filtered: Vec<MarketTicker24h> = tickers
        .iter()
        .filter(|t| {
            t.symbol.ends_with(&quote)
                && (!only_tradable || t.tradable_on_active_env)
                && t.quote_volume >= min_vol
                && (query.is_empty() || t.symbol.contains(&query))
                && (category != TrendingCategory::CtsMomentum || t.cts_score.is_some())
                && t.last_price > 0.0
        })
        .cloned()
        .collect();

    filtered.sort_by(|a, b| match category {
        TrendingCategory::TopGainers => b
            .price_change_percent
            .total_cmp(&a.price_change_percent)
            .then_with(|| b.quote_volume.total_cmp(&a.quote_volume)),
        TrendingCategory::TopLosers => a
            .price_change_percent
            .total_cmp(&b.price_change_percent)
            .then_with(|| b.quote_volume.total_cmp(&a.quote_volume)),
        TrendingCategory::VolatilityLeaders => b
            .range_pct_24h
            .total_cmp(&a.range_pct_24h)
            .then_with(|| b.quote_volume.total_cmp(&a.quote_volume)),
        TrendingCategory::CtsMomentum => b
            .cts_score
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a.cts_score.unwrap_or(f64::NEG_INFINITY))
            .then_with(|| {
                b.rvol_1h
                    .unwrap_or(0.0)
                    .total_cmp(&a.rvol_1h.unwrap_or(0.0))
            })
            .then_with(|| b.quote_volume.total_cmp(&a.quote_volume)),
        TrendingCategory::HotVolume => b.quote_volume.total_cmp(&a.quote_volume),
    });

    filtered.truncate(cap);
    filtered
}

/// Resolves active effective pairs under Static Only / Hybrid / Dynamic modes,
/// enforcing active-venue `exchangeInfo` tradability, hysteresis + dwell stability,
/// and Zero Orphan protection for any open position / resting pending order symbol.
#[allow(clippy::too_many_arguments)]
pub fn resolve_effective_watchlist(
    mode: PairSelectionMode,
    pinned_pairs: &[String],
    trending_tickers: &[MarketTicker24h],
    protected_symbols: &HashSet<String>,
    currently_active_trending: &[String],
    dwell_state: Option<&mut WatchlistDwellState>,
    tradable_venue_symbols: Option<&HashSet<String>>,
    trading_cfg: &TradingConfig,
    now_ms: i64,
) -> Vec<ResolvedWatchlistEntry> {
    let cap = trading_cfg.max_watchlist_pairs.clamp(1, MAX_WATCHLIST_HARD_CAP);
    let top_n = trading_cfg.trending_top_n.clamp(1, cap);
    let hysteresis_buf = trading_cfg.trending_hysteresis_rank_buffer;
    let min_dwell_ms = (trading_cfg.trending_min_dwell_minutes as i64).saturating_mul(60_000);

    let is_tradable = |sym: &str| -> bool {
        match tradable_venue_symbols {
            Some(set) if !set.is_empty() => set.contains(sym),
            _ => true,
        }
    };

    let mut out = Vec::new();
    let mut added = HashSet::new();

    for sym in protected_symbols {
        push_unique_entry(sym, PairSourceTag::ProtectedPosition, &mut added, &mut out);
    }

    if matches!(mode, PairSelectionMode::Static | PairSelectionMode::Hybrid) {
        for sym in normalize_symbol_list(pinned_pairs, &[]) {
            if out.len() >= cap {
                break;
            }
            if is_tradable(&sym) || added.contains(&sym) {
                push_unique_entry(&sym, PairSourceTag::Pinned, &mut added, &mut out);
            }
        }
    }

    if matches!(mode, PairSelectionMode::Hybrid | PairSelectionMode::Dynamic) {
        let target_trending = if mode == PairSelectionMode::Dynamic {
            top_n
        } else {
            top_n.min(cap.saturating_sub(out.len()))
        };
        let ranked_pool: Vec<MarketTicker24h> = rank_screener_tickers(
            trending_tickers,
            trading_cfg.trending_category,
            &trading_cfg.quote_asset,
            trading_cfg.trending_min_quote_volume_usdt,
            true,
            (target_trending + hysteresis_buf + 5).max(25),
            None,
        )
        .into_iter()
        .filter(|t| is_tradable(&t.symbol))
        .collect();

        let rank_by_symbol: HashMap<&str, usize> = ranked_pool
            .iter()
            .enumerate()
            .map(|(i, t)| (t.symbol.as_str(), i))
            .collect();

        let mut retained = Vec::new();
        for prev_sym in currently_active_trending {
            let clean = sanitize_trading_symbol(prev_sym);
            if clean.is_empty() || added.contains(&clean) || !is_tradable(&clean) {
                continue;
            }
            let rank = rank_by_symbol.get(clean.as_str()).copied();
            let entered_at = dwell_state
                .as_deref()
                .and_then(|d| d.entered_at_ms.get(&clean).copied())
                .unwrap_or(0);
            let within_dwell = entered_at > 0 && now_ms.saturating_sub(entered_at) < min_dwell_ms;
            let within_hysteresis = rank.is_some_and(|r| r < target_trending + hysteresis_buf);
            if (within_dwell || within_hysteresis) && retained.len() < target_trending {
                retained.push(clean);
            }
        }

        for sym in retained {
            if out.len() >= cap {
                break;
            }
            push_unique_entry(&sym, PairSourceTag::Trending, &mut added, &mut out);
        }

        let mut trending_count = out
            .iter()
            .filter(|e| e.source_tag == PairSourceTag::Trending)
            .count();
        let mut dwell_ref = dwell_state;
        for t in &ranked_pool {
            if out.len() >= cap || trending_count >= target_trending {
                break;
            }
            if !added.contains(&t.symbol) {
                if let Some(d) = dwell_ref.as_deref_mut() {
                    d.entered_at_ms.entry(t.symbol.clone()).or_insert(now_ms);
                }
                push_unique_entry(&t.symbol, PairSourceTag::Trending, &mut added, &mut out);
                trending_count += 1;
            }
        }

        if let Some(d) = dwell_ref {
            let active_set: HashSet<String> = out.iter().map(|e| e.symbol.clone()).collect();
            d.entered_at_ms.retain(|k, _| active_set.contains(k));
        }

        if mode == PairSelectionMode::Dynamic && out.is_empty() {
            for sym in normalize_symbol_list(pinned_pairs, &[]).into_iter().take(top_n) {
                if out.len() >= cap {
                    break;
                }
                if is_tradable(&sym) {
                    push_unique_entry(&sym, PairSourceTag::Trending, &mut added, &mut out);
                }
            }
        }
    }

    out
}

fn push_unique_entry(
    sym: &str,
    tag: PairSourceTag,
    added: &mut HashSet<String>,
    out: &mut Vec<ResolvedWatchlistEntry>,
) {
    let clean = sanitize_trading_symbol(sym);
    if clean.is_empty() || !added.insert(clean.clone()) {
        return;
    }
    out.push(ResolvedWatchlistEntry {
        symbol: clean,
        source_tag: tag,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ExchangeVenue;

    fn sample_ticker(sym: &str, chg: f64, qvol: f64, range: f64) -> MarketTicker24h {
        MarketTicker24h {
            symbol: sym.into(),
            venue: ExchangeVenue::Futures,
            last_price: 100.0,
            open_price_24h: 100.0 / (1.0 + chg / 100.0),
            high_price_24h: 105.0,
            low_price_24h: 95.0,
            price_change_percent: chg,
            base_volume: qvol / 100.0,
            quote_volume: qvol,
            range_pct_24h: range,
            tradable_on_active_env: true,
            in_watchlist: false,
            source_tag: None,
            updated_at_ms: 1_000,
            rvol_1h: None,
            momentum_1h_pct: None,
            cts_score: None,
        }
    }

    #[test]
    fn cts_score_is_bounded_and_volume_cannot_dominate() {
        let btc_like = compute_cts_score(2.0, 1.0, 50_000_000_000.0, 20_000_000.0, (0.4, 0.4, 0.2))
            .unwrap();
        let alt_like = compute_cts_score(3.0, 4.0, 200_000_000.0, 20_000_000.0, (0.4, 0.4, 0.2))
            .unwrap();
        assert!((0.0..=1.0).contains(&btc_like));
        assert!(alt_like > btc_like, "alt momentum must outrank raw mega-volume");
        assert_eq!(compute_cts_score(0.0, 5.0, 1.0, 1.0, (0.4, 0.4, 0.2)), None);
        assert_eq!(compute_cts_score(2.0, 0.0, 1.0, 1.0, (0.0, 0.0, 0.0)), None);
    }

    #[test]
    fn resolves_static_hybrid_dynamic_with_zero_orphan_protection() {
        let cfg = TradingConfig {
            trending_top_n: 2,
            trending_category: TrendingCategory::TopLosers,
            trending_min_quote_volume_usdt: 10_000_000.0,
            ..Default::default()
        };

        let pinned = vec!["BTCUSDT".into(), "PEPEUSDT".into()];
        let tickers = vec![
            sample_ticker("WIFUSDT", -12.5, 80_000_000.0, 14.0),
            sample_ticker("DOGEUSDT", -7.2, 200_000_000.0, 9.0),
            sample_ticker("LOWLIQUSDT", -25.0, 500_000.0, 30.0),
            sample_ticker("SUIUSDT", 8.0, 120_000_000.0, 11.0),
        ];
        let mut tradable = HashSet::new();
        for s in ["BTCUSDT", "WIFUSDT", "DOGEUSDT", "SUIUSDT", "SOLUSDT"] {
            tradable.insert(s.to_string());
        }
        let mut protected = HashSet::new();
        protected.insert("SOLUSDT".to_string());

        let dyn_res = resolve_effective_watchlist(
            PairSelectionMode::Dynamic,
            &pinned,
            &tickers,
            &protected,
            &[],
            None,
            Some(&tradable),
            &cfg,
            1_000_000,
        );
        let syms: Vec<&str> = dyn_res.iter().map(|r| r.symbol.as_str()).collect();
        // Protected open position stays even in dynamic mode, low-liquidity coin filtered out, top losers picked
        assert_eq!(syms, vec!["SOLUSDT", "WIFUSDT", "DOGEUSDT"]);

        let stat_res = resolve_effective_watchlist(
            PairSelectionMode::Static,
            &pinned,
            &tickers,
            &protected,
            &[],
            None,
            Some(&tradable),
            &cfg,
            1_000_000,
        );
        let stat_syms: Vec<&str> = stat_res.iter().map(|r| r.symbol.as_str()).collect();
        // Unlisted PEPEUSDT on Futures is excluded, BTCUSDT + protected SOLUSDT remain
        assert_eq!(stat_syms, vec!["SOLUSDT", "BTCUSDT"]);
    }

    #[test]
    fn timeframe_to_ms_supports_all_binance_intervals_without_false_gaps() {
        assert_eq!(timeframe_to_ms("30m"), 1_800_000);
        assert_eq!(timeframe_to_ms("2h"), 7_200_000);
        assert_eq!(timeframe_to_ms("4h"), 14_400_000);
        assert_eq!(timeframe_to_ms("6h"), 21_600_000);
        assert_eq!(timeframe_to_ms("8h"), 28_800_000);
        assert_eq!(timeframe_to_ms("12h"), 43_200_000);
        assert_eq!(timeframe_to_ms("1d"), 86_400_000);

        let t0 = 1_760_000_000_000i64;
        assert!(!has_candle_sequence_gap(Some(t0), t0 + 14_400_000, "4h"));
        assert!(has_candle_sequence_gap(Some(t0), t0 + 28_800_000, "4h"));
    }
}
