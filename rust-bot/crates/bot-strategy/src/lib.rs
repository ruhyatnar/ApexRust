//! Multi-pair trend-following scalping/intraday strategy and ATR-based
//! position exit lifecycle (Initial SL, TP1 partial, Break-Even, ATR Trailing Stop).

use bot_core::{
    AutomationConfig, BotConfig, Candle, DirectionPolicy, EntrySignal, ExchangeVenue, ExitConfig,
    ExitPlan, ExitReason, FeatureToggles, IndicatorConfig, IndicatorSnapshot, Position, Side,
    StrategyMode, StrategyProfile, TradingConfig,
};
use chrono::{DateTime, Utc};

fn compute_candle_strength_metrics(candle: &Candle, side: Side) -> (f64, f64) {
    let range = candle.high - candle.low;
    if !range.is_finite() || range <= 1e-12 {
        return (1.0, 1.0);
    }
    let close_strength = match side {
        Side::Long => (candle.close - candle.low) / range,
        Side::Short => (candle.high - candle.close) / range,
    };
    let body_ratio = (candle.close - candle.open).abs() / range;
    (close_strength, body_ratio)
}

#[allow(clippy::too_many_arguments)]
fn passes_quality_mitigation(
    side: Side,
    candle: &Candle,
    ind: &IndicatorSnapshot,
    trading_cfg: &TradingConfig,
    ind_cfg: &IndicatorConfig,
    features: &FeatureToggles,
    profile: StrategyProfile,
    spread_bps: Option<f64>,
) -> bool {
    let min_warmup = ind_cfg.min_warmup_bars.max(20);
    if ind.warmup_bars_count > 0 && ind.warmup_bars_count < min_warmup {
        return false;
    }
    if ind.has_bar_gap {
        return false;
    }
    if let Some(sp) = spread_bps {
        if ind_cfg.max_spread_bps > 0.0 && sp > ind_cfg.max_spread_bps {
            return false;
        }
    }

    // Higher-timeframe (closed 1h) alignment. Missing HTF data fails open.
    if features.htf_trend_filter {
        if let (Some(htf_close), Some(htf_ema)) = (ind.htf_close, ind.htf_ema_macro) {
            let aligned = match side {
                Side::Long => htf_close >= htf_ema,
                Side::Short => htf_close <= htf_ema,
            };
            if !aligned {
                return false;
            }
        }
    }

    // Order-book imbalance gate. A missing book snapshot fails open.
    if features.obi_entry_filter {
        if let Some(obi) = ind.obi {
            let threshold = ind_cfg.obi_min_imbalance.max(0.0);
            let aligned = match side {
                Side::Long => obi >= threshold,
                Side::Short => obi <= -threshold,
            };
            if !aligned {
                return false;
            }
        }
    }

    if matches!(profile, StrategyProfile::VwapReversion) {
        return true;
    }

    // Volatility regime: ATR must be expanding versus its SMA(50) baseline.
    if ind_cfg.atr_expansion_filter_enabled {
        if let (Some(atr), Some(baseline)) = (ind.atr, ind.atr_sma_50) {
            if baseline > 0.0
                && atr / baseline < ind_cfg.atr_expansion_min_ratio.max(0.5)
            {
                return false;
            }
        }
    }

    let require_macro = features.ema_trend_filter
        && ind.ema_macro.is_some()
        && (matches!(trading_cfg.mode, StrategyMode::Intraday)
            || ind_cfg.require_macro_ema_in_scalping);
    if require_macro {
        if let Some(ema200) = ind.ema_macro {
            let macro_ok = match side {
                Side::Long => candle.close > ema200,
                Side::Short => candle.close < ema200,
            };
            if !macro_ok {
                return false;
            }
        }
    }

    if let (Some(atr), Some(ema_mid)) = (ind.atr, ind.ema_mid) {
        if atr > 0.0 && ind_cfg.max_ema_mid_extension_atr > 0.0 {
            let ext = match side {
                Side::Long => candle.close - ema_mid,
                Side::Short => ema_mid - candle.close,
            };
            if ext > ind_cfg.max_ema_mid_extension_atr * atr {
                return false;
            }
        }
        if features.vwap_bias_filter && atr > 0.0 && ind_cfg.max_vwap_extension_atr > 0.0 {
            if let Some(vwap) = ind.vwap {
                let vwap_ext = match side {
                    Side::Long => candle.close - vwap,
                    Side::Short => vwap - candle.close,
                };
                if vwap_ext > ind_cfg.max_vwap_extension_atr * atr {
                    return false;
                }
            }
        }
    }

    if features.ema_trend_filter {
        if let (Some(mid), Some(prev_mid)) = (ind.ema_mid, ind.prev_ema_mid) {
            let slope_ok = match side {
                Side::Long => mid >= prev_mid,
                Side::Short => mid <= prev_mid,
            };
            if !slope_ok {
                return false;
            }
        }
    }

    let (close_strength, body_ratio) = compute_candle_strength_metrics(candle, side);
    if ind_cfg.min_close_strength_ratio > 0.0 && close_strength < ind_cfg.min_close_strength_ratio
    {
        return false;
    }
    if ind_cfg.min_candle_body_ratio > 0.0 && body_ratio < ind_cfg.min_candle_body_ratio {
        return false;
    }

    if features.adx_strength_filter {
        if ind_cfg.require_rising_adx {
            if let (Some(adx), Some(prev_adx)) = (ind.adx, ind.prev_adx) {
                if adx < ind_cfg.adx_min_trend + 6.0 && adx < prev_adx {
                    return false;
                }
            }
        }
        if ind_cfg.min_di_spread > 0.0 {
            if let (Some(pdi), Some(mdi)) = (ind.plus_di, ind.minus_di) {
                if (pdi - mdi).abs() < ind_cfg.min_di_spread {
                    return false;
                }
            }
        }
    }

    true
}

/// Evaluates entry signals with optional real-time spread gate and directional override.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_entry_signal_with_options(
    symbol: &str,
    candle: &Candle,
    ind: &IndicatorSnapshot,
    cfg: &BotConfig,
    recent_candles: &[Candle],
    now: DateTime<Utc>,
    spread_bps: Option<f64>,
    direction_override: Option<DirectionPolicy>,
    enforce_spot_long_only: bool,
) -> Option<EntrySignal> {
    let trading_cfg = &cfg.trading;
    let ind_cfg = &cfg.indicators;
    let profile = cfg.automation.strategy_profile;
    let effective_direction = if enforce_spot_long_only
        && cfg.exchange.venue == ExchangeVenue::Spot
    {
        DirectionPolicy::LongOnly
    } else {
        direction_override.unwrap_or(cfg.automation.direction_policy)
    };
    let features = &cfg.features;
    if !features.signal_generator {
        return None;
    }

    let (Some(ema_fast), Some(ema_mid), Some(ema_slow), Some(adx), Some(pdi), Some(mdi), Some(rsi), Some(prev_rsi), Some(atr)) = (
        ind.ema_fast,
        ind.ema_mid,
        ind.ema_slow,
        ind.adx,
        ind.plus_di,
        ind.minus_di,
        ind.rsi,
        ind.prev_rsi,
        ind.atr,
    ) else {
        return None;
    };

    if atr <= 0.0 {
        return None;
    }

    if features.volume_confirmation_filter {
        let vol_ratio = ind.volume_ratio.or_else(|| {
            ind.avg_volume_20
                .filter(|&a| a > 0.0)
                .map(|a| candle.volume / a)
        })?;
        if vol_ratio < ind_cfg.min_volume_expansion_mult.max(1.0) {
            return None;
        }
    }

    let allow_long = matches!(effective_direction, DirectionPolicy::LongOnly | DirectionPolicy::Both);
    let allow_short = matches!(effective_direction, DirectionPolicy::ShortOnly | DirectionPolicy::Both);

    if matches!(profile, StrategyProfile::VwapReversion) {
        let anchor = if features.vwap_bias_filter {
            ind.vwap?
        } else {
            ema_mid
        };
        if features.adx_strength_filter && adx > (ind_cfg.adx_min_trend + 12.0).max(38.0) {
            return None;
        }
        let min_stretch = atr * 1.1;
        if allow_long
            && passes_quality_mitigation(Side::Long, candle, ind, trading_cfg, ind_cfg, features, profile, spread_bps)
            && candle.close <= anchor - min_stretch
            && (!features.rsi_momentum_filter || (rsi <= 38.0 && rsi > prev_rsi))
        {
            return Some(EntrySignal {
                symbol: symbol.to_string(),
                side: Side::Long,
                entry_price: candle.close,
                atr,
                adx,
                rsi,
                rationale: format!("VWAP Reversion Long · RSI curl {prev_rsi:.1}->{rsi:.1}"),
                timestamp: now,
            });
        }
        if allow_short
            && passes_quality_mitigation(Side::Short, candle, ind, trading_cfg, ind_cfg, features, profile, spread_bps)
            && candle.close >= anchor + min_stretch
            && (!features.rsi_momentum_filter || (rsi >= 62.0 && rsi < prev_rsi))
        {
            return Some(EntrySignal {
                symbol: symbol.to_string(),
                side: Side::Short,
                entry_price: candle.close,
                atr,
                adx,
                rsi,
                rationale: format!("VWAP Reversion Short · RSI curl {prev_rsi:.1}->{rsi:.1}"),
                timestamp: now,
            });
        }
        return None;
    }

    // 1. Trend strength anti-chop gate
    if features.adx_strength_filter && adx < ind_cfg.adx_min_trend {
        return None;
    }

    let vwap_long_ok = !features.vwap_bias_filter
        || !ind_cfg.require_vwap_alignment
        || ind.vwap.is_none_or(|v| candle.close >= v);
    let vwap_short_ok = !features.vwap_bias_filter
        || !ind_cfg.require_vwap_alignment
        || ind.vwap.is_none_or(|v| candle.close <= v);

    let qual_long = passes_quality_mitigation(Side::Long, candle, ind, trading_cfg, ind_cfg, features, profile, spread_bps);
    let qual_short = passes_quality_mitigation(Side::Short, candle, ind, trading_cfg, ind_cfg, features, profile, spread_bps);

    if matches!(profile, StrategyProfile::EmaBreakout) {
        let donchian_lookback = ind_cfg.donchian_lookback.clamp(3, 200);
        let lookback: Vec<&Candle> = recent_candles
            .iter()
            .rev()
            .skip(if recent_candles.last().is_some_and(|c| c.open_time_ms == candle.open_time_ms) { 1 } else { 0 })
            .take(donchian_lookback)
            .collect();
        let prior_high = if lookback.is_empty() {
            candle.open
        } else {
            lookback.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max)
        };
        let prior_low = if lookback.is_empty() {
            candle.open
        } else {
            lookback.iter().map(|c| c.low).fold(f64::INFINITY, f64::min)
        };
        let avg_vol = if lookback.is_empty() {
            candle.volume
        } else {
            lookback.iter().map(|c| c.volume).sum::<f64>() / lookback.len() as f64
        };
        let req_vol_mult = if features.volume_confirmation_filter {
            ind_cfg.min_volume_expansion_mult.max(1.1)
        } else {
            1.1
        };
        let vol_surge_ok = avg_vol <= f64::EPSILON || candle.volume >= avg_vol * req_vol_mult;
        let ema_break_long_ok = !features.ema_trend_filter || (ema_fast > ema_mid && ema_mid > ema_slow);
        let ema_break_short_ok = !features.ema_trend_filter || (ema_fast < ema_mid && ema_mid < ema_slow);
        let di_long_ok = !features.adx_strength_filter || pdi > mdi;
        let di_short_ok = !features.adx_strength_filter || mdi > pdi;
        let rsi_break_long_ok = !features.rsi_momentum_filter || (50.0..=74.0).contains(&rsi);
        let rsi_break_short_ok = !features.rsi_momentum_filter || (26.0..=50.0).contains(&rsi);

        if allow_long
            && candle.close > prior_high
            && ema_break_long_ok
            && qual_long
            && di_long_ok
            && rsi_break_long_ok
            && vol_surge_ok
            && vwap_long_ok
        {
            return Some(EntrySignal {
                symbol: symbol.to_string(),
                side: Side::Long,
                entry_price: candle.close,
                atr,
                adx,
                rsi,
                rationale: format!(
                    "Momentum Breakout Long · Close > {donchian_lookback}-bar High · ADX {adx:.1}"
                ),
                timestamp: now,
            });
        }

        if allow_short
            && candle.close < prior_low
            && ema_break_short_ok
            && qual_short
            && di_short_ok
            && rsi_break_short_ok
            && vol_surge_ok
            && vwap_short_ok
        {
            return Some(EntrySignal {
                symbol: symbol.to_string(),
                side: Side::Short,
                entry_price: candle.close,
                atr,
                adx,
                rsi,
                rationale: format!(
                    "Momentum Breakout Short · Close < {donchian_lookback}-bar Low · ADX {adx:.1}"
                ),
                timestamp: now,
            });
        }
        return None;
    }

    let ema_long_ok = !features.ema_trend_filter
        || (candle.close > ema_mid && ema_fast >= ema_mid && ema_mid > ema_slow);
    let ema_short_ok = !features.ema_trend_filter
        || (candle.close < ema_mid && ema_fast <= ema_mid && ema_mid < ema_slow);
    let di_long_ok = !features.adx_strength_filter || pdi > mdi;
    let di_short_ok = !features.adx_strength_filter || mdi > pdi;
    let rsi_long_ok = !features.rsi_momentum_filter
        || (rsi >= ind_cfg.rsi_long_pullback_min
            && rsi <= ind_cfg.rsi_long_pullback_max
            && rsi > prev_rsi);
    let rsi_short_ok = !features.rsi_momentum_filter
        || (rsi >= ind_cfg.rsi_short_pullback_min
            && rsi <= ind_cfg.rsi_short_pullback_max
            && rsi < prev_rsi);

    // 2. LONG Trend-Following Setup
    if allow_long && ema_long_ok && qual_long && di_long_ok && rsi_long_ok && vwap_long_ok {
        return Some(EntrySignal {
            symbol: symbol.to_string(),
            side: Side::Long,
            entry_price: candle.close,
            atr,
            adx,
            rsi,
            rationale: format!(
                "{profile:?} Long (9>{ema_fast:.2}, 21>{ema_mid:.2}, 50>{ema_slow:.2}), ADX {adx:.1}, RSI {prev_rsi:.1}->{rsi:.1}"
            ),
            timestamp: now,
        });
    }

    // 3. SHORT Trend-Following Setup
    if allow_short && ema_short_ok && qual_short && di_short_ok && rsi_short_ok && vwap_short_ok {
        return Some(EntrySignal {
            symbol: symbol.to_string(),
            side: Side::Short,
            entry_price: candle.close,
            atr,
            adx,
            rsi,
            rationale: format!(
                "{profile:?} Short, ADX {adx:.1}, RSI {prev_rsi:.1}->{rsi:.1}"
            ),
            timestamp: now,
        });
    }

    None
}

/// Build an `ExitPlan` honoring `FeatureToggles` (`atr_dynamic_exits`, `break_even_stop`, `trailing_stop`, `take_profit_ladder`).
pub fn build_exit_plan_with_features(
    side: Side,
    entry_price: f64,
    atr: f64,
    cfg: &ExitConfig,
    features: &FeatureToggles,
) -> ExitPlan {
    let (sl_dist, tp1_dist, tp2_dist) = if features.atr_dynamic_exits {
        (
            atr * cfg.atr_sl_multiplier,
            atr * cfg.atr_tp1_multiplier,
            atr * cfg.atr_tp2_multiplier,
        )
    } else {
        (entry_price * 0.015, entry_price * 0.025, entry_price * 0.04)
    };
    let be_enabled = features.atr_dynamic_exits && features.break_even_stop;
    let trail_enabled = features.atr_dynamic_exits && features.trailing_stop;

    match side {
        Side::Long => ExitPlan {
            initial_stop_loss: entry_price - sl_dist,
            active_stop_loss: entry_price - sl_dist,
            take_profit_1: entry_price + tp1_dist,
            take_profit_2: entry_price + tp2_dist,
            tp1_hit: false,
            break_even_armed: false,
            break_even_enabled: be_enabled,
            trailing_active: false,
            trailing_enabled: trail_enabled,
            tp_ladder_enabled: features.take_profit_ladder,
            risk_distance_r: sl_dist,
        },
        Side::Short => ExitPlan {
            initial_stop_loss: entry_price + sl_dist,
            active_stop_loss: entry_price + sl_dist,
            take_profit_1: entry_price - tp1_dist,
            take_profit_2: entry_price - tp2_dist,
            tp1_hit: false,
            break_even_armed: false,
            break_even_enabled: be_enabled,
            trailing_active: false,
            trailing_enabled: trail_enabled,
            tp_ladder_enabled: features.take_profit_ladder,
            risk_distance_r: sl_dist,
        },
    }
}

/// Actions emitted on each market tick for an open position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PositionTickAction {
    Hold,
    PartialClose { ratio: f64, exit_price: f64, reason: ExitReason },
    FullClose { exit_price: f64, reason: ExitReason },
}

/// Updates Break-Even, monotonic ATR Trailing Stop, and evaluates SL/TP hits.
pub fn manage_position_tick(
    pos: &mut Position,
    mark_price: f64,
    current_atr: f64,
    cfg: &ExitConfig,
) -> PositionTickAction {
    manage_position_tick_with_trail_override(pos, mark_price, current_atr, cfg, None)
}

/// Variant supporting dynamic ATR trailing multiplier override (e.g. momentum saturation tightening).
pub fn manage_position_tick_with_trail_override(
    pos: &mut Position,
    mark_price: f64,
    current_atr: f64,
    cfg: &ExitConfig,
    trailing_mult_override: Option<f64>,
) -> PositionTickAction {
    let r = pos.exit_plan.risk_distance_r.max(1e-9);
    let fee_buffer = pos.entry_price * (cfg.break_even_fee_buffer_bps / 10_000.0);
    let effective_trail_mult = trailing_mult_override
        .filter(|m| m.is_finite() && *m > 0.0)
        .map(|m| m.min(cfg.atr_trailing_multiplier))
        .unwrap_or(cfg.atr_trailing_multiplier);

    match pos.side {
        Side::Long => {
            pos.highest_favorable_price = pos.highest_favorable_price.max(mark_price);
            pos.unrealized_pnl_usdt = (mark_price - pos.entry_price) * pos.remaining_quantity;

            // 1. Check Stop Loss / Break-Even / Trailing Stop hit first
            if mark_price <= pos.exit_plan.active_stop_loss {
                let reason = if pos.exit_plan.trailing_active {
                    ExitReason::TrailingStop
                } else if pos.exit_plan.break_even_armed {
                    ExitReason::BreakEvenStop
                } else {
                    ExitReason::StopLoss
                };
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.active_stop_loss,
                    reason,
                };
            }

            // 2. Check Runner TP2
            if pos.exit_plan.tp_ladder_enabled && mark_price >= pos.exit_plan.take_profit_2 {
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.take_profit_2,
                    reason: ExitReason::TakeProfit2,
                };
            }

            // 3. Arm Break-Even at >= break_even_trigger_r and update Monotonic ATR Trailing Stop
            //    before evaluating PartialClose TP1 so a direct move to TP1 still protects the runner.
            let r_gain = (mark_price - pos.entry_price) / r;
            if pos.exit_plan.break_even_enabled
                && !pos.exit_plan.break_even_armed
                && r_gain >= cfg.break_even_trigger_r
            {
                let be_price = pos.entry_price + fee_buffer;
                if be_price > pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = be_price;
                }
                pos.exit_plan.break_even_armed = true;
            }

            if pos.exit_plan.trailing_enabled
                && r_gain >= cfg.trailing_activation_r
                && current_atr > 0.0
            {
                pos.exit_plan.trailing_active = true;
                let trail_sl = pos.highest_favorable_price - (current_atr * effective_trail_mult);
                if trail_sl > pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = trail_sl;
                }
            }

            // 4. Check Partial TP1
            if pos.exit_plan.tp_ladder_enabled
                && !pos.exit_plan.tp1_hit
                && mark_price >= pos.exit_plan.take_profit_1
            {
                pos.exit_plan.tp1_hit = true;
                if cfg.tp1_close_ratio >= 0.999_999 {
                    return PositionTickAction::FullClose {
                        exit_price: pos.exit_plan.take_profit_1,
                        reason: ExitReason::TakeProfit1,
                    };
                }
                return PositionTickAction::PartialClose {
                    ratio: cfg.tp1_close_ratio,
                    exit_price: pos.exit_plan.take_profit_1,
                    reason: ExitReason::TakeProfit1,
                };
            }
        }
        Side::Short => {
            pos.highest_favorable_price = pos.highest_favorable_price.min(mark_price);
            pos.unrealized_pnl_usdt = (pos.entry_price - mark_price) * pos.remaining_quantity;

            if mark_price >= pos.exit_plan.active_stop_loss {
                let reason = if pos.exit_plan.trailing_active {
                    ExitReason::TrailingStop
                } else if pos.exit_plan.break_even_armed {
                    ExitReason::BreakEvenStop
                } else {
                    ExitReason::StopLoss
                };
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.active_stop_loss,
                    reason,
                };
            }

            if pos.exit_plan.tp_ladder_enabled && mark_price <= pos.exit_plan.take_profit_2 {
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.take_profit_2,
                    reason: ExitReason::TakeProfit2,
                };
            }

            let r_gain = (pos.entry_price - mark_price) / r;
            if pos.exit_plan.break_even_enabled
                && !pos.exit_plan.break_even_armed
                && r_gain >= cfg.break_even_trigger_r
            {
                let be_price = pos.entry_price - fee_buffer;
                if be_price < pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = be_price;
                }
                pos.exit_plan.break_even_armed = true;
            }

            if pos.exit_plan.trailing_enabled
                && r_gain >= cfg.trailing_activation_r
                && current_atr > 0.0
            {
                pos.exit_plan.trailing_active = true;
                let trail_sl = pos.highest_favorable_price + (current_atr * effective_trail_mult);
                if trail_sl < pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = trail_sl;
                }
            }

            if pos.exit_plan.tp_ladder_enabled
                && !pos.exit_plan.tp1_hit
                && mark_price <= pos.exit_plan.take_profit_1
            {
                pos.exit_plan.tp1_hit = true;
                if cfg.tp1_close_ratio >= 0.999_999 {
                    return PositionTickAction::FullClose {
                        exit_price: pos.exit_plan.take_profit_1,
                        reason: ExitReason::TakeProfit1,
                    };
                }
                return PositionTickAction::PartialClose {
                    ratio: cfg.tp1_close_ratio,
                    exit_price: pos.exit_plan.take_profit_1,
                    reason: ExitReason::TakeProfit1,
                };
            }
        }
    }

    PositionTickAction::Hold
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingCancelReason {
    SignalReversed,
    MomentumExhaustion,
    PriceRunaway,
    ExpiredBars,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingOrderDynamicAction {
    Keep,
    Cancel {
        reason: PendingCancelReason,
        rationale: String,
    },
}

pub struct PendingOrderEvalCtx<'a> {
    pub pending_side: Side,
    pub limit_price: f64,
    pub is_manual: bool,
    pub created_bar_idx: u64,
    pub current_bar_idx: u64,
    pub candle: &'a Candle,
    pub ind: &'a IndicatorSnapshot,
    pub auto_cfg: &'a AutomationConfig,
    pub opposing_signal: Option<&'a EntrySignal>,
}

pub fn evaluate_pending_order_dynamic_action(ctx: &PendingOrderEvalCtx<'_>) -> PendingOrderDynamicAction {
    let PendingOrderEvalCtx {
        pending_side,
        limit_price,
        is_manual,
        created_bar_idx,
        current_bar_idx,
        candle,
        ind,
        auto_cfg,
        opposing_signal,
    } = *ctx;
    if is_manual && !auto_cfg.apply_dynamic_cancel_to_manual_orders {
        return PendingOrderDynamicAction::Keep;
    }

    if auto_cfg.cancel_pending_on_signal_reversal {
        if let Some(opp) = opposing_signal {
            if opp.side != pending_side {
                return PendingOrderDynamicAction::Cancel {
                    reason: PendingCancelReason::SignalReversed,
                    rationale: format!(
                        "Auto-canceled pending {:?} limit: confirmed opposing {:?} signal ({})",
                        pending_side, opp.side, opp.rationale
                    ),
                };
            }
        }
        if let (Some(ef), Some(em), Some(es), Some(pdi), Some(mdi)) = (
            ind.ema_fast,
            ind.ema_mid,
            ind.ema_slow,
            ind.plus_di,
            ind.minus_di,
        ) {
            let flipped = match pending_side {
                Side::Long => ef < em && em < es && mdi > pdi && candle.close < em,
                Side::Short => ef > em && em > es && pdi > mdi && candle.close > em,
            };
            if flipped {
                return PendingOrderDynamicAction::Cancel {
                    reason: PendingCancelReason::SignalReversed,
                    rationale: format!(
                        "Auto-canceled pending {:?} limit: EMA stack & DI trend flipped opposite",
                        pending_side
                    ),
                };
            }
        }
    }

    if auto_cfg.cancel_pending_on_exhaustion {
        if let (Some(rsi), Some(prev_rsi)) = (ind.rsi, ind.prev_rsi) {
            let exhausted = match pending_side {
                Side::Long => rsi >= auto_cfg.exhaustion_rsi_high && rsi < prev_rsi,
                Side::Short => rsi <= auto_cfg.exhaustion_rsi_low && rsi > prev_rsi,
            };
            if exhausted {
                return PendingOrderDynamicAction::Cancel {
                    reason: PendingCancelReason::MomentumExhaustion,
                    rationale: format!(
                        "Auto-canceled pending {:?} limit: RSI exhausted ({prev_rsi:.1} -> {rsi:.1})",
                        pending_side
                    ),
                };
            }
        }
    }

    if auto_cfg.max_pending_runaway_atr > 0.0 {
        if let Some(atr) = ind.atr {
            if atr > 0.0 {
                let runaway = match pending_side {
                    Side::Long => candle.close - limit_price,
                    Side::Short => limit_price - candle.close,
                };
                if runaway > auto_cfg.max_pending_runaway_atr * atr {
                    return PendingOrderDynamicAction::Cancel {
                        reason: PendingCancelReason::PriceRunaway,
                        rationale: format!(
                            "Auto-canceled pending {:?} limit: price ran away {:.2}x ATR from limit ${limit_price:.4}",
                            pending_side,
                            runaway / atr
                        ),
                    };
                }
            }
        }
    }

    if auto_cfg.max_pending_order_bars > 0 {
        let elapsed = current_bar_idx.saturating_sub(created_bar_idx);
        if elapsed >= auto_cfg.max_pending_order_bars as u64 {
            return PendingOrderDynamicAction::Cancel {
                reason: PendingCancelReason::ExpiredBars,
                rationale: format!(
                    "Auto-canceled pending {:?} limit: TTL expired after {elapsed} closed bars",
                    pending_side
                ),
            };
        }
    }

    PendingOrderDynamicAction::Keep
}

#[derive(Debug, Clone)]
pub enum OpenPositionDynamicAction {
    Hold,
    TightenTrailing { factor: f64, rationale: String },
    EarlyReversalExit { opposing_signal: EntrySignal, rationale: String },
}

pub fn evaluate_open_position_dynamic_action(
    pos: &Position,
    candle: &Candle,
    ind: &IndicatorSnapshot,
    auto_cfg: &AutomationConfig,
    opposing_signal: Option<&EntrySignal>,
) -> OpenPositionDynamicAction {
    if auto_cfg.exit_position_on_signal_reversal {
        if let Some(opp) = opposing_signal {
            if opp.side != pos.side {
                return OpenPositionDynamicAction::EarlyReversalExit {
                    opposing_signal: opp.clone(),
                    rationale: format!(
                        "Closed {:?} early on confirmed opposing {:?} signal ({})",
                        pos.side, opp.side, opp.rationale
                    ),
                };
            }
        }
    }

    if auto_cfg.tighten_trailing_on_exhaustion {
        if let (Some(rsi), Some(prev_rsi)) = (ind.rsi, ind.prev_rsi) {
            let r = pos.exit_plan.risk_distance_r.max(1e-9);
            let r_gain = match pos.side {
                Side::Long => (candle.close - pos.entry_price) / r,
                Side::Short => (pos.entry_price - candle.close) / r,
            };
            let factor = auto_cfg.exhaustion_trail_factor.clamp(0.2, 0.95);
            let exhausted = match pos.side {
                Side::Long => rsi >= auto_cfg.exhaustion_rsi_high && rsi < prev_rsi,
                Side::Short => rsi <= auto_cfg.exhaustion_rsi_low && rsi > prev_rsi,
            };
            if r_gain >= auto_cfg.exhaustion_min_profit_r && exhausted {
                return OpenPositionDynamicAction::TightenTrailing {
                    factor,
                    rationale: format!(
                        "Tightened trailing stop ({:.0}%) on RSI exhaustion at +{r_gain:.2}R",
                        factor * 100.0
                    ),
                };
            }
        }
    }

    OpenPositionDynamicAction::Hold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_break_even_and_trailing_ratchet_monotonically() {
        let cfg = ExitConfig {
            atr_sl_multiplier: 1.5,
            atr_tp1_multiplier: 2.25,
            atr_tp2_multiplier: 3.75,
            tp1_close_ratio: 0.5,
            break_even_trigger_r: 1.0,
            break_even_fee_buffer_bps: 10.0,
            trailing_activation_r: 1.2,
            atr_trailing_multiplier: 1.4,
        };
        let plan = build_exit_plan_with_features(
            Side::Long,
            100.0,
            2.0,
            &cfg,
            &FeatureToggles::default(),
        );
        let mut pos = Position {
            id: "test-1".into(),
            symbol: "ETHUSDT".into(),
            side: Side::Long,
            entry_price: 100.0,
            quantity: 1.0,
            remaining_quantity: 1.0,
            unrealized_pnl_usdt: 0.0,
            realized_pnl_usdt: 0.0,
            highest_favorable_price: 100.0,
            exit_plan: plan,
            opened_at: Utc::now(),
        };

        // Move +1.0R (+3.0 price) -> Break-even armed
        let action = manage_position_tick(&mut pos, 103.1, 2.0, &cfg);
        assert_eq!(action, PositionTickAction::Hold);
        assert!(pos.exit_plan.break_even_armed);
        assert!(pos.exit_plan.active_stop_loss > 100.0);

        // Move +1.5R (+4.5 price) -> Trailing activates & ratchets up
        let sl_before = pos.exit_plan.active_stop_loss;
        manage_position_tick(&mut pos, 104.5, 2.0, &cfg);
        assert!(pos.exit_plan.trailing_active);
        assert!(pos.exit_plan.active_stop_loss >= sl_before);
    }

    #[test]
    fn tp_ladder_disabled_skips_partial_tp1_exit() {
        let cfg = ExitConfig {
            atr_sl_multiplier: 1.5,
            atr_tp1_multiplier: 2.25,
            atr_tp2_multiplier: 3.75,
            tp1_close_ratio: 0.5,
            break_even_trigger_r: 1.0,
            break_even_fee_buffer_bps: 10.0,
            trailing_activation_r: 1.2,
            atr_trailing_multiplier: 1.4,
        };
        let features = FeatureToggles {
            take_profit_ladder: false,
            ..FeatureToggles::default()
        };
        let plan = build_exit_plan_with_features(Side::Long, 100.0, 2.0, &cfg, &features);
        assert!(!plan.tp_ladder_enabled);

        let mut pos = Position {
            id: "test-no-ladder".into(),
            symbol: "BTCUSDT".into(),
            side: Side::Long,
            entry_price: 100.0,
            quantity: 1.0,
            remaining_quantity: 1.0,
            unrealized_pnl_usdt: 0.0,
            realized_pnl_usdt: 0.0,
            highest_favorable_price: 100.0,
            exit_plan: plan,
            opened_at: Utc::now(),
        };

        // When take_profit_ladder is disabled, both TP1 and TP2 are skipped in favor of TrailingStop
        let at_tp1 = manage_position_tick(&mut pos, 104.6, 2.0, &cfg);
        assert_eq!(at_tp1, PositionTickAction::Hold);
        assert!(!pos.exit_plan.tp1_hit);

        let at_tp2 = manage_position_tick(&mut pos, 107.6, 2.0, &cfg);
        assert_eq!(at_tp2, PositionTickAction::Hold);
        assert!(pos.exit_plan.trailing_active);

        let stop_trigger = pos.exit_plan.active_stop_loss - 0.1;
        let on_trail = manage_position_tick(&mut pos, stop_trigger, 2.0, &cfg);
        assert!(matches!(on_trail, PositionTickAction::FullClose { reason: ExitReason::TrailingStop, .. }));
    }

    fn healthy_long_candle(close: f64) -> Candle {
        Candle {
            open_time_ms: 1_700_000_000_000,
            open: close - 1.4,
            high: close + 0.1,
            low: close - 1.6,
            close,
            volume: 2_000.0,
            is_closed: true,
        }
    }

    fn healthy_short_candle(close: f64) -> Candle {
        Candle {
            open_time_ms: 1_700_000_000_000,
            open: close + 1.4,
            high: close + 1.6,
            low: close - 0.1,
            close,
            volume: 2_000.0,
            is_closed: true,
        }
    }

    fn healthy_long_indicators() -> IndicatorSnapshot {
        IndicatorSnapshot {
            ema_fast: Some(102.0),
            ema_mid: Some(101.0),
            prev_ema_mid: Some(100.6),
            ema_slow: Some(100.0),
            ema_macro: Some(95.0),
            vwap: Some(100.5),
            adx: Some(28.0),
            prev_adx: Some(26.0),
            plus_di: Some(30.0),
            minus_di: Some(14.0),
            rsi: Some(58.0),
            prev_rsi: Some(54.0),
            atr: Some(2.0),
            prev_atr: None,
            avg_volume_20: Some(1_000.0),
            volume_ratio: Some(2.0),
            warmup_bars_count: 220,
            has_bar_gap: false,
            ..IndicatorSnapshot::default()
        }
    }

    fn healthy_short_indicators() -> IndicatorSnapshot {
        IndicatorSnapshot {
            ema_fast: Some(98.0),
            ema_mid: Some(99.0),
            prev_ema_mid: Some(99.4),
            ema_slow: Some(100.0),
            ema_macro: Some(105.0),
            vwap: Some(99.5),
            adx: Some(28.0),
            prev_adx: Some(26.0),
            plus_di: Some(14.0),
            minus_di: Some(30.0),
            rsi: Some(42.0),
            prev_rsi: Some(46.0),
            atr: Some(2.0),
            prev_atr: None,
            avg_volume_20: Some(1_000.0),
            volume_ratio: Some(2.0),
            warmup_bars_count: 220,
            has_bar_gap: false,
            ..IndicatorSnapshot::default()
        }
    }

    #[test]
    fn symmetric_long_short_spot_enforcement_and_mitigation_gates() {
        let mut futures_cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        futures_cfg.exchange.venue = ExchangeVenue::Futures;
        futures_cfg.automation.direction_policy = DirectionPolicy::Both;

        let c_long = healthy_long_candle(103.0);
        let ind_long = healthy_long_indicators();
        let long_sig = evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_long,
            &ind_long,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        );
        assert_eq!(long_sig.as_ref().map(|s| s.side), Some(Side::Long));

        let c_short = healthy_short_candle(97.0);
        let ind_short = healthy_short_indicators();
        let short_sig = evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_short,
            &ind_short,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        );
        assert_eq!(short_sig.as_ref().map(|s| s.side), Some(Side::Short));

        // Spot enforces LongOnly when enforce_spot_long_only = true, blocking Short opens
        let mut spot_cfg = futures_cfg.clone();
        spot_cfg.exchange.venue = ExchangeVenue::Spot;
        let blocked_spot_short = evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_short,
            &ind_short,
            &spot_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        );
        assert!(blocked_spot_short.is_none());

        // Over-extended (> max_ema_mid_extension_atr * atr), wide spread, gap, and falling ADX must block
        let chased = healthy_long_candle(108.0);
        assert!(evaluate_entry_signal_with_options(
            "ETHUSDT",
            &chased,
            &ind_long,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        )
        .is_none());

        assert!(evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_long,
            &ind_long,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(45.0), // exceeds default max_spread_bps = 20.0
            None,
            true,
        )
        .is_none());

        let mut gapped = ind_long;
        gapped.has_bar_gap = true;
        assert!(evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_long,
            &gapped,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        )
        .is_none());

        let mut falling_adx = ind_short;
        falling_adx.prev_adx = Some(31.0);
        assert!(evaluate_entry_signal_with_options(
            "ETHUSDT",
            &c_short,
            &falling_adx,
            &futures_cfg,
            &[],
            Utc::now(),
            Some(4.0),
            None,
            true,
        )
        .is_none());
    }

    #[test]
    fn dynamic_pending_order_and_open_position_actions() {
        let auto_cfg = AutomationConfig::default();
        let ind_short = healthy_short_indicators();
        let c_short = healthy_short_candle(97.0);

        let opp_short = EntrySignal {
            symbol: "SOLUSDT".into(),
            side: Side::Short,
            entry_price: 97.0,
            atr: 2.0,
            adx: 28.0,
            rsi: 42.0,
            rationale: "Short reversal".into(),
            timestamp: Utc::now(),
        };

        // 1. Signal reversal cancels pending Long order (even manual opt-out respected)
        let manual_keep = evaluate_pending_order_dynamic_action(&PendingOrderEvalCtx {
            pending_side: Side::Long,
            limit_price: 98.0,
            is_manual: true,
            created_bar_idx: 10,
            current_bar_idx: 11,
            candle: &c_short,
            ind: &ind_short,
            auto_cfg: &auto_cfg,
            opposing_signal: Some(&opp_short),
        });
        assert_eq!(manual_keep, PendingOrderDynamicAction::Keep);

        let cancel_rev = evaluate_pending_order_dynamic_action(&PendingOrderEvalCtx {
            pending_side: Side::Long,
            limit_price: 98.0,
            is_manual: false,
            created_bar_idx: 10,
            current_bar_idx: 11,
            candle: &c_short,
            ind: &ind_short,
            auto_cfg: &auto_cfg,
            opposing_signal: Some(&opp_short),
        });
        assert!(matches!(
            cancel_rev,
            PendingOrderDynamicAction::Cancel {
                reason: PendingCancelReason::SignalReversed,
                ..
            }
        ));

        // 2. Price runaway cancels pending Long when price runs away > 1.8 * ATR
        let mut ind_neutral = healthy_long_indicators();
        ind_neutral.rsi = Some(60.0);
        ind_neutral.prev_rsi = Some(58.0);
        let c_runaway = healthy_long_candle(105.0);
        let cancel_run = evaluate_pending_order_dynamic_action(&PendingOrderEvalCtx {
            pending_side: Side::Long,
            limit_price: 100.0,
            is_manual: false,
            created_bar_idx: 10,
            current_bar_idx: 12,
            candle: &c_runaway,
            ind: &ind_neutral,
            auto_cfg: &auto_cfg,
            opposing_signal: None,
        });
        assert!(matches!(
            cancel_run,
            PendingOrderDynamicAction::Cancel {
                reason: PendingCancelReason::PriceRunaway,
                ..
            }
        ));

        // 3. TTL expiry cancels pending Short after >= 6 closed bars
        let short_ttl_candle = healthy_short_candle(101.0);
        let cancel_ttl = evaluate_pending_order_dynamic_action(&PendingOrderEvalCtx {
            pending_side: Side::Short,
            limit_price: 100.0,
            is_manual: false,
            created_bar_idx: 10,
            current_bar_idx: 16,
            candle: &short_ttl_candle,
            ind: &ind_short,
            auto_cfg: &auto_cfg,
            opposing_signal: None,
        });
        assert!(matches!(
            cancel_ttl,
            PendingOrderDynamicAction::Cancel {
                reason: PendingCancelReason::ExpiredBars,
                ..
            }
        ));

        // 4. Open Long position: RSI exhaustion >= 1R tightens trail; opposing signal exits early
        let base_cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        let pos = Position {
            id: "pos-dyn".into(),
            symbol: "SOLUSDT".into(),
            side: Side::Long,
            entry_price: 100.0,
            quantity: 1.0,
            remaining_quantity: 1.0,
            unrealized_pnl_usdt: 0.0,
            realized_pnl_usdt: 0.0,
            highest_favorable_price: 104.0,
            exit_plan: build_exit_plan_with_features(
                Side::Long,
                100.0,
                2.0,
                &base_cfg.exits,
                &FeatureToggles::default(),
            ),
            opened_at: Utc::now(),
        };
        let mut ind_exhaust = healthy_long_indicators();
        ind_exhaust.prev_rsi = Some(79.0);
        ind_exhaust.rsi = Some(76.5);
        let tighten = evaluate_open_position_dynamic_action(
            &pos,
            &healthy_long_candle(104.0),
            &ind_exhaust,
            &auto_cfg,
            None,
        );
        assert!(matches!(tighten, OpenPositionDynamicAction::TightenTrailing { .. }));

        let early_exit = evaluate_open_position_dynamic_action(
            &pos,
            &c_short,
            &ind_short,
            &auto_cfg,
            Some(&opp_short),
        );
        assert!(matches!(early_exit, OpenPositionDynamicAction::EarlyReversalExit { .. }));
    }
}
