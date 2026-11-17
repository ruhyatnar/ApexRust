# Scalping & Intraday Trend-Following Strategy Guide

This bot implements a quantitative, multi-indicator trend-following engine optimized for **5m (scalping)** and **15m (intraday)** Binance Spot pairs.

## 1. Technical Indicator Pipeline (`bot-indicators`)

| Indicator | Period | Role | Mathematical Basis |
| :--- | :--- | :--- | :--- |
| **EMA Stack** | 9 / 21 / 50 / 200 | Trend direction & pullback zone | $\text{EMA}_t = P_t \cdot k + \text{EMA}_{t-1}(1 - k), \; k = \frac{2}{N+1}$ |
| **ADX + DI** | 14 | Trend strength filter (anti-chop) | Wilder's smoothing on $+DM, -DM, TR$; requires $\text{ADX} \ge 25.0$ |
| **Wilder RSI** | 14 | Pullback momentum timing | Wilder's smoothed RS; avoids chasing overbought/oversold extremes |
| **ATR** | 14 | Volatility normalization | Wilder's smoothing of $\max(H-L, |H-C_{prev}|, |L-C_{prev}|)$ |
| **Session VWAP** | UTC Day | Institutional fair value bias | $\frac{\sum (\text{Typical Price} \times \text{Volume})}{\sum \text{Volume}}$ |

## 2. Entry Rules (Strict Confluence)

### Long Entry
1. **Trend Stack**: `Close > EMA 21 > EMA 50` and `EMA 9 >= EMA 21` (plus `Close > EMA 200` for intraday mode).
2. **Trend Strength**: `ADX(14) >= adx_min_trend` (default `25.0`) and `+DI > -DI`.
3. **Pullback Timing**: `RSI(14)` sits in the healthy pullback band (`42.0 ..= 58.0`) and `RSI_curr > RSI_prev` (curling upward, not overbought `> 70`).
4. **VWAP Bias**: `Close >= VWAP` (when `require_vwap_alignment = true`).

### Short / Exit-Bias Signal
1. **Trend Stack**: `Close < EMA 21 < EMA 50` and `EMA 9 <= EMA 21`.
2. **Trend Strength**: `ADX(14) >= adx_min_trend` and `-DI > +DI`.
3. **Pullback Timing**: `RSI(14)` sits in `42.0 ..= 58.0` and `RSI_curr < RSI_prev` (curling downward).
4. **VWAP Bias**: `Close <= VWAP`.

> Note: On Binance Spot (non-margin), short signals either trigger flat/hedged exits on long inventory or execute on Cross/Isolated Margin / Futures when extended. In paper/simulation mode, both Long and Short legs are simulated cleanly.

## 3. ATR-Based Exit Lifecycle (`bot-strategy`)

Upon entry at $P_{entry}$ with current volatility $ATR$:

1. **Initial Stop Loss ($SL_0$)**:
   - Long: $SL_0 = P_{entry} - (1.5 \times ATR)$
   - Short: $SL_0 = P_{entry} + (1.5 \times ATR)$
   - Let $R = |P_{entry} - SL_0|$ be the initial 1R risk distance.
2. **Partial Take Profit ($TP_1$)**:
   - Triggered at $1.5 \times R$ (equivalent to $2.25 \times ATR$); closes 50% of position to bank realized profit.
3. **Automatic Break-Even ($BE$)**:
   - Once price reaches $P_{entry} \pm (1.0 \times R)$, Stop Loss automatically moves to $P_{entry} \pm \text{fee\_buffer}$ (`12 bps`) so the trade cannot turn into a net loss after Binance taker fees.
4. **ATR Trailing Stop ($TS$)**:
   - Once price reaches `trailing_activation_r` (`1.2R`), the trailing stop ratchets monotonically:
     - Long: $SL_{new} = \max(SL_{curr}, \; P_{mark} - 1.4 \times ATR)$
     - Short: $SL_{new} = \min(SL_{curr}, \; P_{mark} + 1.4 \times ATR)$
5. **Final Runner Target ($TP_2$)**:
   - Full close at $2.5 \times R$ ($3.75 \times ATR$) or when the ratcheted trailing stop is hit.
