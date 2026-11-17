//! Multi-pair trend-following scalping/intraday strategy and ATR-based
//! position exit lifecycle (Initial SL, TP1 partial, Break-Even, ATR Trailing Stop).

use bot_core::{
    Candle, EntrySignal, ExitConfig, ExitPlan, ExitReason, IndicatorConfig, IndicatorSnapshot,
    Position, Side, StrategyMode, TradingConfig,
};
use chrono::{DateTime, Utc};

/// Evaluates whether a symbol exhibits a valid trend-following pullback entry.
pub fn evaluate_entry_signal(
    symbol: &str,
    candle: &Candle,
    ind: &IndicatorSnapshot,
    trading_cfg: &TradingConfig,
    ind_cfg: &IndicatorConfig,
    now: DateTime<Utc>,
) -> Option<EntrySignal> {
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

    // 1. Trend strength anti-chop gate
    if adx < ind_cfg.adx_min_trend || atr <= 0.0 {
        return None;
    }

    // Optional macro EMA 200 filter for Intraday mode
    let macro_long_ok = match (trading_cfg.mode, ind.ema_macro) {
        (StrategyMode::Intraday, Some(ema200)) => candle.close > ema200,
        _ => true,
    };
    let macro_short_ok = match (trading_cfg.mode, ind.ema_macro) {
        (StrategyMode::Intraday, Some(ema200)) => candle.close < ema200,
        _ => true,
    };

    let vwap_long_ok = !ind_cfg.require_vwap_alignment || ind.vwap.map_or(true, |v| candle.close >= v);
    let vwap_short_ok = !ind_cfg.require_vwap_alignment || ind.vwap.map_or(true, |v| candle.close <= v);

    // 2. LONG Trend-Following Pullback Setup
    if candle.close > ema_mid
        && ema_fast >= ema_mid
        && ema_mid > ema_slow
        && macro_long_ok
        && pdi > mdi
        && rsi >= ind_cfg.rsi_long_pullback_min
        && rsi <= ind_cfg.rsi_long_pullback_max
        && rsi > prev_rsi
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
                "EMA stack bullish (9>{:.2}, 21>{:.2}, 50>{:.2}), ADX {:.1} (+DI>{:.1}), RSI curl {:.1}->{:.1}",
                ema_fast, ema_mid, ema_slow, adx, pdi, prev_rsi, rsi
            ),
            timestamp: now,
        });
    }

    // 3. SHORT Trend-Following Pullback Setup
    if candle.close < ema_mid
        && ema_fast <= ema_mid
        && ema_mid < ema_slow
        && macro_short_ok
        && mdi > pdi
        && rsi >= ind_cfg.rsi_short_pullback_min
        && rsi <= ind_cfg.rsi_short_pullback_max
        && rsi < prev_rsi
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
                "EMA stack bearish, ADX {:.1} (-DI>{:.1}), RSI curl {:.1}->{:.1}",
                adx, mdi, prev_rsi, rsi
            ),
            timestamp: now,
        });
    }

    None
}

/// Build an initial ATR-based `ExitPlan` at trade entry.
pub fn build_exit_plan(side: Side, entry_price: f64, atr: f64, cfg: &ExitConfig) -> ExitPlan {
    let sl_dist = atr * cfg.atr_sl_multiplier;
    let tp1_dist = atr * cfg.atr_tp1_multiplier;
    let tp2_dist = atr * cfg.atr_tp2_multiplier;

    match side {
        Side::Long => ExitPlan {
            initial_stop_loss: entry_price - sl_dist,
            active_stop_loss: entry_price - sl_dist,
            take_profit_1: entry_price + tp1_dist,
            take_profit_2: entry_price + tp2_dist,
            tp1_hit: false,
            break_even_armed: false,
            trailing_active: false,
            risk_distance_r: sl_dist,
        },
        Side::Short => ExitPlan {
            initial_stop_loss: entry_price + sl_dist,
            active_stop_loss: entry_price + sl_dist,
            take_profit_1: entry_price - tp1_dist,
            take_profit_2: entry_price - tp2_dist,
            tp1_hit: false,
            break_even_armed: false,
            trailing_active: false,
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
            if mark_price >= pos.exit_plan.take_profit_2 {
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.take_profit_2,
                    reason: ExitReason::TakeProfit2,
                };
            }

            // 3. Check Partial TP1
            if !pos.exit_plan.tp1_hit && mark_price >= pos.exit_plan.take_profit_1 {
                pos.exit_plan.tp1_hit = true;
                return PositionTickAction::PartialClose {
                    ratio: cfg.tp1_close_ratio,
                    exit_price: pos.exit_plan.take_profit_1,
                    reason: ExitReason::TakeProfit1,
                };
            }

            // 4. Arm Break-Even at >= break_even_trigger_r
            let r_gain = (mark_price - pos.entry_price) / r;
            if !pos.exit_plan.break_even_armed && r_gain >= cfg.break_even_trigger_r {
                let be_price = pos.entry_price + fee_buffer;
                if be_price > pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = be_price;
                }
                pos.exit_plan.break_even_armed = true;
            }

            // 5. Monotonic ATR Trailing Stop
            if r_gain >= cfg.trailing_activation_r && current_atr > 0.0 {
                pos.exit_plan.trailing_active = true;
                let trail_sl = pos.highest_favorable_price - (current_atr * cfg.atr_trailing_multiplier);
                if trail_sl > pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = trail_sl;
                }
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

            if mark_price <= pos.exit_plan.take_profit_2 {
                return PositionTickAction::FullClose {
                    exit_price: pos.exit_plan.take_profit_2,
                    reason: ExitReason::TakeProfit2,
                };
            }

            if !pos.exit_plan.tp1_hit && mark_price <= pos.exit_plan.take_profit_1 {
                pos.exit_plan.tp1_hit = true;
                return PositionTickAction::PartialClose {
                    ratio: cfg.tp1_close_ratio,
                    exit_price: pos.exit_plan.take_profit_1,
                    reason: ExitReason::TakeProfit1,
                };
            }

            let r_gain = (pos.entry_price - mark_price) / r;
            if !pos.exit_plan.break_even_armed && r_gain >= cfg.break_even_trigger_r {
                let be_price = pos.entry_price - fee_buffer;
                if be_price < pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = be_price;
                }
                pos.exit_plan.break_even_armed = true;
            }

            if r_gain >= cfg.trailing_activation_r && current_atr > 0.0 {
                pos.exit_plan.trailing_active = true;
                let trail_sl = pos.highest_favorable_price + (current_atr * cfg.atr_trailing_multiplier);
                if trail_sl < pos.exit_plan.active_stop_loss {
                    pos.exit_plan.active_stop_loss = trail_sl;
                }
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
}
