# AI & Developer Handoff Guide

This document is structured specifically to help future developers and AI coding assistants extend **ApexRust Quant** safely without breaking invariants.

## 1. Non-Negotiable Invariants

1. **Pure Logic Isolation**:
   - `bot-indicators`, `bot-strategy`, and `bot-risk` MUST remain pure, deterministic, and free of network I/O or wall-clock side effects (`Utc::now()` must be passed in as a parameter where needed for deterministic backtesting).
2. **Risk Gate Precedence**:
   - Every `OrderRequest` produced by `bot-strategy` MUST pass `RiskManager::authorize_entry(&mut self, ...)` before reaching `bot-exchange`.
   - Never bypass `CircuitBreakerState::Halted` in order-submission paths.
3. **Monotonic Trailing Stops**:
   - A long stop loss may ONLY increase (`new_sl >= old_sl`); a short stop loss may ONLY decrease (`new_sl <= old_sl`).
4. **Official SDK First**:
   - Keep all Binance REST/WebSocket protocol types inside `bot-exchange`. Do not leak `binance_sdk` types into `bot-core`, `bot-strategy`, or `bot-risk`; translate at the boundary using traits (`ExchangeGateway`).

## 2. How to Add a New Technical Indicator

1. Implement a streaming struct in `crates/bot-indicators/src/lib.rs` with `pub fn next(&mut self, candle: &Candle) -> Option<f64>`.
2. Expose the new field in `IndicatorSnapshot` inside `crates/bot-core/src/types.rs`.
3. Add deterministic unit tests with known reference values in `bot-indicators`.

## 3. How to Add a New Strategy Profile

1. Add a variant to `StrategyMode` in `crates/bot-core/src/config.rs`.
2. Implement the signal evaluator in `crates/bot-strategy/src/lib.rs` implementing the `SignalEvaluator` trait.
3. Keep exit management (`ExitPlan::evaluate_tick`) decoupled so ATR SL/BE/Trailing rules apply consistently across strategies.

## 4. How to Connect the WebApp Frontend to `bot-web`

- `bot-web` exposes:
  - `GET /api/health` -> Transport mode (`WsPrimary` | `RestFallback`), uptime, Binance latency
  - `GET /api/snapshot` -> Full JSON `EngineSnapshot` (pairs, indicators, open positions, closed trades, risk metrics)
  - `POST /api/control` -> `{ "action": "pause" | "resume" | "trip_cb" | "reset_cb" | "flatten_all" }`
  - `WS /ws/telemetry` -> Real-time JSON stream pushed on every tick/candle update
- Mirror TypeScript types in `src/engine/types.ts` must stay field-compatible with `crates/bot-core/src/types.rs`.
