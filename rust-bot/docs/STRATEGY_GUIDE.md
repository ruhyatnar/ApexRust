# Multi-Profile Strategy, Exits, Volatility Alerts & Quantitative Risk Guide

ApexRust Quant implements a deterministic multi-pair signal, exit, and quantitative sizing engine synchronized across **Rust (`bot-indicators`, `bot-strategy`, `bot-risk`, `bot-engine`)** and **TypeScript (`indicators.ts`, `strategy.ts`, `risk.ts`, `quantAnalytics.ts`, `sessionWindows.ts`, `simulator.ts`)**, supporting **Binance Spot (`long_only`)** and **USD-M Futures (`both`)**.

---

## 1. Technical Indicator Pipeline (`bot-indicators` / `indicators.ts`)

| Indicator | Period | Role | Mathematical Basis |
| :--- | :--- | :--- | :--- |
| **EMA Stack** | 9 / 21 / 50 / 200 | Trend direction & pullback zone | $\text{EMA}_t = P_t \cdot k + \text{EMA}_{t-1}(1 - k), \; k = \frac{2}{N+1}$ |
| **ADX + DI** | 14 | Trend strength filter (anti-chop) | Wilder's smoothing on $+DM, -DM, TR$; default $\text{ADX} \ge 25.0$ |
| **Wilder RSI** | 14 | Pullback momentum timing & curls | Wilder's smoothed RS; avoids chasing uncurled extremes |
| **ATR** | 14 | Volatility normalization, exits & alerts | Wilder's smoothing of $\max(H-L, |H-C_{prev}|, |L-C_{prev}|)$ |
| **Session VWAP** | UTC Day | Institutional fair value bias | $\frac{\sum (\text{Typical Price} \times \text{Volume})}{\sum \text{Volume}}$ (resets at `00:00 UTC`) |
| **Volume Baseline** | 20 Bars | Institutional participation filter | Bar volume divided by prior 20-bar mean (`volumeRatio`) |

---

## 2. Entry Strategy Profiles (`strategy_profile`)

### Profile A: `trend_pullback` (Default)
- **Long Entry**:
  1. `ema_trend_filter`: `Close > EMA 21 > EMA 50` and `EMA 9 >= EMA 21` (plus `Close > EMA 200` in `intraday` mode).
  2. `adx_strength_filter`: `ADX(14) >= adx_min_trend` and `+DI > -DI`.
  3. `rsi_momentum_filter`: `RSI(14)` inside `[rsi_long_pullback_min, rsi_long_pullback_max]` (`42..58` default) and `RSI_curr > RSI_prev`.
  4. `vwap_bias_filter` & `require_vwap_alignment`: `Close >= VWAP`.
- **Short Entry** (when `direction_policy = "both"`): Symmetrical bearish EMA stack, `-DI > +DI`, downward RSI curl, and `Close <= VWAP`.

### Profile B: `ema_breakout` (10-Bar Donchian Expansion)
- Confirms close breaking above/below the prior 10-bar Donchian high/low, aligned with the EMA `9/21/50` stack, `ADX >= adx_min_trend`, and `volume >= 1.1x` recent 10-bar average volume.

### Profile C: `vwap_reversion` (Bounded ATR Stretch)
- Fades extremes `>= 1.1 * ATR` away from Session VWAP (or `EMA 21` if VWAP filter is off) when `RSI` curls upward from `<= 38` (Long) or downward from `>= 62` (Short, if `both`), under bounded ADX (`<= max(38, adx_min_trend + 12)`).

### Optional Entry Gates Across All Profiles
- **Volume Expansion Confirmation** (`features.volume_confirmation_filter`): Requires `volume >= avg_vol_20 * min_volume_expansion_mult` (`1.5x` default).
- **Daily UTC Liquidity Session Windows** (`features.session_window_filter`): When enabled, automated entries only fire when the UTC clock `[HH:MM]` falls inside at least one enabled `[[automation.session_windows]]` interval (`[start_utc, end_utc)`, supporting overnight wrap when `start_utc > end_utc`). **Open position exits continue 24/7 regardless of session windows.**

---

## 3. ATR-Based Exit Lifecycle (`bot-strategy` / `strategy.ts`)

Upon entry at $P_{entry}$ with live volatility $ATR$:

1. **Initial Stop Loss ($SL_0$)** (`atr_dynamic_exits`):
   - Long: $SL_0 = P_{entry} - (\text{atr\_sl\_multiplier} \times ATR)$ (default `1.5x`)
   - Short: $SL_0 = P_{entry} + (\text{atr\_sl\_multiplier} \times ATR)$
   - Defines $1R = |P_{entry} - SL_0|$.
2. **Partial Take Profit ($TP_1$)** (`take_profit_ladder`):
   - Placed at `atr_tp1_multiplier * ATR` (`2.25x` default = `1.5R`); closes `tp1_close_ratio` (`50%` default) of remaining quantity.
3. **Automatic Break-Even ($BE$)** (`break_even_stop`):
   - Once favorable excursion reaches `break_even_trigger_r * R` (`1.0R`), SL advances to `Entry ± fee_buffer_bps` (`12–25 bps`) so winning trades cannot turn net-negative after fees.
4. **Monotonic ATR Trailing Stop ($TS$)** (`trailing_stop`):
   - Once profit reaches `trailing_activation_r` (`1.2R`), SL ratchets monotonically in trade direction:
     - Long: $SL_{new} = \max(SL_{curr}, \; P_{best} - \text{atr\_trailing\_multiplier} \times ATR)$ (`1.4x` default)
     - Short: $SL_{new} = \min(SL_{curr}, \; P_{best} + \text{atr\_trailing\_multiplier} \times ATR)$
5. **Final Runner Target ($TP_2$)**:
   - Full close at `atr_tp2_multiplier * ATR` (`3.75x` default = `2.5R`) or trailed stop hit.

---

## 4. ATR Volatility Spike Alerts

When `indicators.volatility_alerts_enabled = true`:
- On closed bars, computes `atr_pct = (ATR / Price) * 100` and `expansion_ratio = max(ATR / baseline_ATR, bar_range / baseline_ATR)`.
- Fires a `VolatilitySpikeAlert` (with per-pair cooldown `volatility_alert_cooldown_sec`) if:
  - `(atr_pct >= atr_spike_pct_threshold && expansion_ratio >= atr_expansion_ratio_threshold)` OR
  - `expansion_ratio >= atr_expansion_ratio_threshold * 1.18` (classified `extreme` when `>= 1.5x` threshold or `atr_pct >= 1.75x` threshold).
- In the Web Command Center, triggers an in-app toast banner and a Web `Notification` if browser push permissions are granted.

---

## 5. Quantitative Sizing, Kelly Criterion & 9-Step Pre-Trade Audit (`quantAnalytics.ts`)

1. **Position Sizing Modes** (`trading.position_sizing_mode`):
   - `fixed_usdt`: Fixed notional (`automation.auto_order_notional_usdt`).
   - `fixed_risk_pct`: $\text{Notional} = (\text{Equity} \times \text{baseRiskPerTradePct}) / \text{StopDistance}$.
   - `quarter_kelly` ($0.25 f^*$), `half_kelly` ($0.50 f^*$), `full_kelly` ($1.00 f^*$): Derived from $f^* = (b \cdot p - q) / b$ and expected log growth $G(f) = p \ln(1 + b f) + q \ln(1 - f)$, scaled by the portfolio inverse-correlation diversification factor $C^{-1}$ across tracked pairs. Automated Kelly sizing halts if $f^* \le 0$ (negative expectancy guard).
2. **Expectancy & Profit Factor Regimes**:
   - $E(R) = (p \cdot \overline{Win}_R) - (q \cdot \overline{Loss}_R)$, statistically valid at $N \ge 50$ trades.
   - Profit Factor regimes: `NetLosing (<1.0)`, `SubThreshold (1.0–1.3)`, `ViableEdge (1.3–2.0)`, `StrongEdge (2.0–3.0)`, `OverfitWarning (>3.0)`.
3. **9-Step Pre-Trade Validation & Multi-Timeframe Protocol**:
   - Checks `D1 (Macro)`, `H4 (Structure)`, `H1 (Momentum)`, `M5 (Execution)` alignment plus 9 structured checks (HTF trend, market structure/VWAP, closed candle non-repainting, volume expansion, invalidation level, ATR stop buffer `0.8x–4.0x`, `R:R >= 1.5:1`, equity risk vs daily limit, and round-trip fees `<= 25%` of target profit).
