# AI & Developer Handoff Guide

This document helps developers and AI coding assistants inspect, modify, and extend **ApexRust Quant** safely while preserving parity across the **Web Command Center (`src/`)**, **Express Server Proxy (`server.ts`)**, and **Rust Workspace (`rust-bot/`)**.

---

## 1. Non-Negotiable Invariants

0. **Mandatory WebApp ↔ Desktop Parity (Every Change & Feature)**:
   - Every change, bugfix, config field, feature toggle, strategy/risk rule, or execution capability MUST be implemented in **both** the WebApp (`src/` + `server.ts`) and the Rust Desktop/Daemon workspace (`rust-bot/`) in the same change set, with matching unit tests on both sides. Never land a feature in only one runtime.
1. **Pure Logic Isolation & Deterministic Testing**:
   - `bot-indicators`, `bot-strategy`, and `bot-risk` (Rust) and `src/engine/indicators.ts`, `strategy.ts`, `risk.ts`, `quantAnalytics.ts`, `sessionWindows.ts`, and `configStorage.ts` (TypeScript) MUST remain pure, deterministic, and free of network I/O or hidden `Date.now()` / `Utc::now()` calls. Always pass `nowMs` / `now: DateTime<Utc>` as an explicit parameter.
2. **Risk Gate & Feature Toggle Precedence**:
   - Every entry MUST pass `RiskManager::authorize_entry` / `RiskManager.authorizeEntry` before execution. Never bypass `CircuitBreakerState::Halted` when `features.circuit_breaker` is enabled.
   - All 19 `FeatureToggles` flags MUST be honored identically across `rust-bot/crates/bot-engine/src/lib.rs`, `src/engine/simulator.ts`, and UI components.
3. **UTC Session Window Entry-Only Gating (24/7 Exit Continuity)**:
   - When `features.session_window_filter` / `sessionWindowFilter` is `true`, ONLY automated **new entry evaluations** (`evaluate_entry_signal*`, `evaluateAutoPair`, `runAutoScanNow`, `stepBar` auto-entries) are gated by `[[automation.session_windows]]`.
   - Open position exit management (`manage_position_tick` / `managePositionTick` for SL, Break-Even, ATR Trailing Stop, TP1/TP2, and Circuit Breaker Flatten) MUST ALWAYS run 24/7 even outside active UTC windows.
4. **Strict Paper vs Live Account Isolation**:
   - `App.tsx` maintains two separate `SimulationRuntime` instances (`paperRuntimeRef` and `liveRuntimeRef`). Paper mode never hits signed `/api/live/*` order endpoints; Live mode disables synthetic `Simulated` feeds and requires explicit vault verification + arming.
5. **Monotonic Trailing Stops**:
   - Long SL may ONLY increase (`new_sl >= old_sl`); Short SL may ONLY decrease (`new_sl <= old_sl`).
6. **Configuration Persistence & Backward Compatibility**:
   - Any new field added to `BotConfig` in `src/engine/types.ts` MUST have a default in `DEFAULT_BOT_CONFIG` (`src/engine/simulator.ts`), explicit deep-merge/validation in `mergeBotConfigWithDefaults` (`src/engine/configStorage.ts`), TOML serialization in `buildSyncedTomlFromPayload` (`server.ts`), and `#[serde(default = ...)]` parity in `rust-bot/crates/bot-core/src/config.rs` and `rust-bot/config/bot.example.toml`.
7. **Official Binance SDK & Secret Hygiene**:
   - Keep `binance_sdk` protocol types inside `bot-exchange` (`binance_rest.rs`, `binance_futures.rs`, `binance_ws.rs`).
   - API keys/secrets stay strictly in server memory (`server.ts`) or environment variables (`BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_ED25519_PRIVATE_KEY`). Never store secrets in `localStorage`, `backups/`, `bot.synced.toml`, or Git commits.
8. **Desktop PWA & API Routing Safety**:
   - `vite.config.ts` Workbox `navigateFallbackDenylist` MUST continue excluding `/^\/api\//` and `/^\/_ah\//` so installed Desktop PWA windows never serve `index.html` for Express API calls.

---

## 2. TypeScript ↔ Rust Module Parity Map

| Domain | TypeScript (`src/engine/` & `server.ts`) | Rust (`rust-bot/crates/`) |
| :--- | :--- | :--- |
| Config & Types | `src/engine/types.ts`, `configStorage.ts` | `bot-core/src/config.rs`, `types.rs`, `error.rs` |
| Indicators | `src/engine/indicators.ts` | `bot-indicators/src/lib.rs` |
| Strategy & Exits | `src/engine/strategy.ts` | `bot-strategy/src/lib.rs` |
| Risk & Circuit Breaker | `src/engine/risk.ts` | `bot-risk/src/lib.rs` |
| UTC Session Windows | `src/engine/sessionWindows.ts` | `bot-core/src/config.rs` (`UtcSessionWindow`, `is_within_session_windows`) |
| Orchestrator & Vol Alerts | `src/engine/simulator.ts` | `bot-engine/src/lib.rs` |
| Exchange / Signing | `server.ts` (`/api/live/*`) | `bot-exchange/src/{binance_rest,binance_futures,binance_ws,failover}.rs` |
| Web / Telemetry Bridge | `server.ts` (Express `:3000`) | `bot-web/src/lib.rs` (Axum `:8080`) |
| Git Sanitized Backup | `server.ts` (`/api/git/*`), `GitBackupView.tsx` | `bot-engine/src/git_sync.rs`, `deploy/git-backup.sh` |

---

## 3. Extension Checklists

### Adding a New Feature Toggle
1. Add field to `FeatureToggles` in `src/engine/types.ts`, `DEFAULT_BOT_CONFIG.features` (`src/engine/simulator.ts`), and `handleSafeDefaults` + `TOGGLE_GROUPS` in `src/components/FeatureTogglesView.tsx`.
2. Add snake_case field with `#[serde(default)]` to `FeatureToggles` in `rust-bot/crates/bot-core/src/config.rs` and `rust-bot/config/bot.example.toml`.
3. Enforce the toggle in both `src/engine/simulator.ts` / `strategy.ts` and `rust-bot/crates/bot-engine/src/lib.rs` / `bot-strategy/src/lib.rs`.
4. Add unit tests covering ON/OFF behavior and persistence round-trip in `configStorage.test.ts` + feature test file.

### Adding a New Technical Indicator
1. Implement streaming O(1) updater in `src/engine/indicators.ts` and `rust-bot/crates/bot-indicators/src/lib.rs`.
2. Expose field on `IndicatorSnapshot` in `src/engine/types.ts` and `rust-bot/crates/bot-core/src/types.rs`.
3. Wire into `CandlestickChart.tsx` / `MarketsAndSignalsView.tsx` / `strategy.ts` as needed and add deterministic tests to `src/engine/indicators.test.ts`.

### Adding a New Strategy Profile
1. Add variant to `StrategyProfile` in `src/engine/types.ts` and `rust-bot/crates/bot-core/src/config.rs`.
2. Implement evaluator in `src/engine/strategy.ts` and `rust-bot/crates/bot-strategy/src/lib.rs`.
3. Add UI card in `StrategyConfigView.tsx` and checklist rows in `MarketsAndSignalsView.tsx` (`SignalsView`), keeping `managePositionTick` decoupled.

---

## 4. API & Telemetry Surfaces

- **`bot-web` (Rust Axum, default `:8080`)**:
  - `GET /api/health` -> `{ status, running, transport_mode, failover_count }`
  - `GET /api/config` -> Sanitized `BotConfig` (`exchange.credentials = None`)
  - `GET /api/snapshot` -> Full `EngineSnapshot` (venue, transport, risk, pairs, closed trades, `recent_volatility_alerts`)
  - `POST /api/control` -> `{ "action": "pause" | "resume" | "trip_cb" | "reset_cb" | "flatten_all" | "backup_now" | "manual_order", "reason"?: string, "symbol"?: string, "side"?: "Long" | "Short", "notional_usdt"?: number, "order_method"?: "MARKET" | "LIMIT" | "LIMIT_MAKER" | "OCO", "limit_price"?: number }`
  - `WS /ws/telemetry` -> Broadcast stream of `EngineSnapshot` JSON frames
- **Express Bridge (`server.ts`, default `:3000`)**:
  - `GET /api/health`, `GET /api/market/klines`, `GET /api/market/ticker`, `GET/POST/DELETE /api/live/config`, `POST /api/live/verify`, `POST /api/live/arm`, `POST/DELETE /api/live/order`, `GET /api/live/open-orders`, `GET /api/live/order-status`, `POST /api/live/cancel-open-brackets`, `GET /api/live/trades`, `GET/POST/DELETE /api/orders/history`, `GET /api/git/status`, `POST /api/git/init`, `POST /api/git/remote`, `POST /api/git/backup`

---

## 5. Verification Commands

```bash
# Type-check & production Vite bundle
npm run lint && npm run build

# Pure-logic TypeScript unit tests (node:test via tsx)
npx --yes tsx --test \
  src/engine/indicators.test.ts \
  src/engine/riskAndStrategy.test.ts \
  src/engine/configStorage.test.ts \
  src/engine/sessionWindows.test.ts \
  src/engine/orderHistoryAnalytics.test.ts \
  src/engine/liveFillNotifications.test.ts

# Rust workspace tests & clippy
cd rust-bot && cargo test --workspace && cargo clippy --workspace
```
