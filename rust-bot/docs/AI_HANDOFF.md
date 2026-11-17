# AI & Developer Handoff Guide

This document is structured specifically to help future developers and AI coding assistants extend **ApexRust Quant** safely without breaking invariants.

## 1. Non-Negotiable Invariants

1. **Pure Logic Isolation**:
   - `bot-indicators`, `bot-strategy`, and `bot-risk` MUST remain pure, deterministic, and free of network I/O or wall-clock side effects (`Utc::now()` must be passed in as a parameter where needed for deterministic backtesting).
2. **Risk Gate & Feature Toggle Precedence**:
   - Every `OrderRequest` produced by `bot-strategy` MUST pass `RiskManager::authorize_entry(&mut self, ...)` before reaching `bot-exchange`.
   - Never bypass `CircuitBreakerState::Halted` in order-submission paths when `features.circuit_breaker` is enabled.
   - Respect `FeatureToggles` in both `bot-engine` (`crates/bot-engine/src/lib.rs`) and the TypeScript simulator (`src/engine/simulator.ts`).
3. **Monotonic Trailing Stops**:
   - A long stop loss may ONLY increase (`new_sl >= old_sl`); a short stop loss may ONLY decrease (`new_sl <= old_sl`).
4. **Official SDK First & Venue Parity**:
   - Keep all Binance REST/WebSocket protocol types (`spot` and `derivatives_trading_usds_futures`) inside `bot-exchange` (`binance_rest.rs`, `binance_futures.rs`, `binance_ws.rs`). Translate at the boundary without leaking `binance_sdk` types into `bot-core`.
5. **Secret Hygiene in Git Sync**:
   - Never stage or commit `config/bot.toml`, `.env*`, or `*.pem` keys via `git_sync` or `/api/git/backup`. Only sanitized config snapshots belong in Git.

## 2. How to Add a New Technical Indicator

1. Implement a streaming struct in `crates/bot-indicators/src/lib.rs` with `pub fn next(&mut self, candle: &Candle) -> Option<f64>`.
2. Expose the new field in `IndicatorSnapshot` inside `crates/bot-core/src/types.rs` and mirror it in `src/engine/types.ts`.
3. Add a feature toggle boolean in `FeatureToggles` (`crates/bot-core/src/config.rs` and `src/engine/types.ts`) if the filter should be independently toggleable.

## 3. How to Add a New Strategy Profile

1. Add a variant to `StrategyProfile` in `crates/bot-core/src/config.rs` and `src/engine/types.ts`.
2. Implement the signal evaluator in `crates/bot-strategy/src/lib.rs` (`evaluate_entry_signal_with_options`) and `src/engine/strategy.ts` (`evaluateEntrySignal`).
3. Keep exit management (`manage_position_tick` / `managePositionTick`) decoupled so ATR SL/BE/Trailing rules apply consistently across strategies.

## 4. How to Connect the WebApp Frontend to `bot-web`

- `bot-web` exposes:
  - `GET /api/health` -> Transport mode (`WsPrimary` | `RestFallback`), uptime, Binance latency
  - `GET /api/snapshot` -> Full JSON `EngineSnapshot` (venue, pairs, indicators, open positions, closed trades, risk metrics)
  - `POST /api/control` -> `{ "action": "pause" | "resume" | "trip_cb" | "reset_cb" | "flatten_all" }`
  - `WS /ws/telemetry` -> Real-time JSON stream pushed on every tick/candle update
- Express bridge (`server.ts`) exposes:
  - `GET/POST/DELETE /api/live/*` -> Isolated server-side Binance Spot & USD-M Futures signing vault + execution (`MARKET`, `LIMIT`, `LIMIT_MAKER`/`GTX`, `OCO`)
  - `GET/POST /api/git/*` -> Sanitized Git repository initialization, remote configuration, and snapshot backup commits

