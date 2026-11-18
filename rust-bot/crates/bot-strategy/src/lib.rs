//! Multi-pair trend-following scalping/intraday strategy and ATR-based
//! position exit lifecycle (Initial SL, TP1 partial, Break-Even, ATR Trailing Stop).

use bot_core::{
    Candle, DirectionPolicy, EntrySignal, ExitConfig, ExitPlan, ExitReason, FeatureToggles,
    IndicatorConfig, IndicatorSnapshot, Position, Side, StrategyMode, StrategyProfile,
    TradingConfig,
};
use chrono::{DateTime, Utc};

/// Evaluates entry signals with full historical candle context for Donchian breakout confirmation.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_entry_signal_full(
    symbol: &str,
    candle: &Candle,
    ind: &IndicatorSnapshot,
    trading_cfg: &TradingConfig,
    ind_cfg: &IndicatorConfig,
    profile: StrategyProfile,
    direction_policy: DirectionPolicy,
    features: &FeatureToggles,
    recent_candles: &[Candle],
    now: DateTime<Utc>,
) -> Option<EntrySignal> {
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
        });
        if let Some(vr) = vol_ratio {
            if vr < ind_cfg.min_volume_expansion_mult.max(1.0) {
                return None;
            }
        }
    }

    let allow_short = matches!(direction_policy, DirectionPolicy::Both);

    if matches!(profile, StrategyProfile::VwapReversion) {
        let anchor = if features.vwap_bias_filter {
            ind.vwap.unwrap_or(ema_mid)
        } else {
            ema_mid
        };
        if features.adx_strength_filter && adx > (ind_cfg.adx_min_trend + 12.0).max(38.0) {
            return None;
        }
        let min_stretch = atr * 1.1;
        if candle.close <= anchor - min_stretch
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

    // Optional macro EMA 200 filter for Intraday mode
    let macro_long_ok = if !features.ema_trend_filter {
        true
    } else {
        match (trading_cfg.mode, ind.ema_macro) {
            (StrategyMode::Intraday, Some(ema200)) => candle.close > ema200,
            _ => true,
        }
    };
    let macro_short_ok = if !features.ema_trend_filter {
        true
    } else {
        match (trading_cfg.mode, ind.ema_macro) {
            (StrategyMode::Intraday, Some(ema200)) => candle.close < ema200,
            _ => true,
        }
    };

    let vwap_long_ok = !features.vwap_bias_filter
        || !ind_cfg.require_vwap_alignment
        || ind.vwap.is_none_or(|v| candle.close >= v);
    let vwap_short_ok = !features.vwap_bias_filter
        || !ind_cfg.require_vwap_alignment
        || ind.vwap.is_none_or(|v| candle.close <= v);

    if matches!(profile, StrategyProfile::EmaBreakout) {
        let lookback: Vec<&Candle> = recent_candles
            .iter()
            .rev()
            .skip(if recent_candles.last().is_some_and(|c| c.open_time_ms == candle.open_time_ms) { 1 } else { 0 })
            .take(10)
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
            ind.avg_volume_20.unwrap_or(candle.volume)
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

        if candle.close > prior_high
            && ema_break_long_ok
            && macro_long_ok
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
                rationale: format!("Momentum Breakout Long · Close > 10-bar High · ADX {adx:.1}"),
                timestamp: now,
            });
        }

        if allow_short
            && candle.close < prior_low
            && ema_break_short_ok
            && macro_short_ok
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
                rationale: format!("Momentum Breakout Short · Close < 10-bar Low · ADX {adx:.1}"),
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
    if ema_long_ok && macro_long_ok && di_long_ok && rsi_long_ok && vwap_long_ok {
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
    if allow_short && ema_short_ok && macro_short_ok && di_short_ok && rsi_short_ok && vwap_short_ok {
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

/// Build an initial ATR-based `ExitPlan` at trade entry.
pub fn build_exit_plan(side: Side, entry_price: f64, atr: f64, cfg: &ExitConfig) -> ExitPlan {
    build_exit_plan_with_features(side, entry_price, atr, cfg, &FeatureToggles::default())
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

    match side {
        Side::Long => ExitPlan {
            initial_stop_loss: entry_price - sl_dist,
            active_stop_loss: entry_price - sl_dist,
            take_profit_1: entry_price + tp1_dist,
            take_profit_2: entry_price + tp2_dist,
            tp1_hit: false,
            break_even_armed: false,
            break_even_enabled: features.break_even_stop,
            trailing_active: false,
            trailing_enabled: features.trailing_stop,
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
            break_even_enabled: features.break_even_stop,
            trailing_active: false,
            trailing_enabled: features.trailing_stop,
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
    let r = pos.exit_plan.risk_distance_r.max(1e-9);
    let fee_buffer = pos.entry_price * (cfg.break_even_fee_buffer_bps / 10_000.0);

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
                let trail_sl = pos.highest_favorable_price - (current_atr * cfg.atr_trailing_multiplier);
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
                let trail_sl = pos.highest_favorable_price + (current_atr * cfg.atr_trailing_multiplier);
                if trail_sl < pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = trail_sl;
                }
            }

            if pos.exit_plan.tp_ladder_enabled
                && !pos.exit_plan.tp1_hit
                && mark_price <= pos.exit_plan.take_profit_1
            {
                pos.exit_plan.tp1_hit = true;
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
        let plan = build_exit_plan(Side::Long, 100.0, 2.0, &cfg);
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
}
