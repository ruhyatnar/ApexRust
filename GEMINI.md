# ApexRust Quant — Project Rules

## 1. Mandatory WebApp ↔ Desktop Parity
- Every change, bugfix, config field, feature toggle, strategy/risk rule, or execution capability MUST be implemented in **both** the WebApp (`src/`, `server.ts`) and the Rust Desktop/Daemon workspace (`rust-bot/`) in the same change set, with matching unit tests.
- Keep `BotConfig`, all 19 `FeatureToggles`, `UtcSessionWindow`, `StrategyProfile`, `PositionSizingMode` (including Kelly negative-expectancy block), `VolatilitySpikeAlert`, and `RiskManager` behavior (including `reset_circuit_breaker` clearing `quarantined_pairs`) synchronized across:
  - TypeScript: `src/engine/types.ts`, `simulator.ts`, `configStorage.ts`, `strategy.ts`, `risk.ts`
  - Express Proxy: `server.ts` (`buildSyncedTomlFromPayload`, `/api/live/*`, `/api/git/*`)
  - Rust: `rust-bot/crates/bot-core`, `bot-indicators`, `bot-strategy`, `bot-risk`, `bot-exchange`, `bot-engine`, `bot-web`, and `rust-bot/config/bot.example.toml`

## 2. Binance API Compliance (`developers.binance.com`)
- **USD-M Futures (`/fapi/v1/order`)**: Use `newOrderRespType = RESULT` (never `FULL`, which is Spot-only).
- **USD-M Futures Conditional TP/SL**: Route `TAKE_PROFIT_MARKET` / `STOP_MARKET` through `/fapi/v1/algoOrder` (`algoType=CONDITIONAL`, lowercase `priceProtect="true"`, `closePosition="true"`, `workingType="MARK_PRICE"`), and query `/fapi/v1/algoOpenOrders` alongside `/fapi/v1/openOrders`.
- **Futures `reduceOnly` Exits**: Skip `/fapi/v1/marginType` and `/fapi/v1/leverage` on `reduceOnly` exit orders so Binance error `-4048` never blocks protective closes.
- **Binance Spot**: Use `/api/v3/orderList/oco` (`aboveType`/`belowType`) and reject Spot short-open attempts.
- **Resting Order Reconciliation**: When reconciling pending live orders, verify `/api/v3/order` or `/fapi/v1/order` status before removing locally—promote `FILLED` orders to open positions rather than treating missing open orders as canceled.

## 3. Strategy, Exit Lifecycle & Build Hygiene
- **ATR Exit Lifecycle**: In `managePositionTick` / `manage_position_tick`, evaluate Break-Even and monotonic ATR Trailing Stop **before** returning `PartialClose` on TP1 so a direct move to TP1 still protects the remaining runner.
- **Session Windows**: `sessionWindowFilter` gates only new automated entries; open position exit management runs 24/7.
- **Build & Secret Hygiene**: Never commit secrets (`.env*`, `*.pem`, `*.key`, `rust-bot/config/bot.toml`, `.apexrust-order-logs.json`), keep `target/` and `rust-bot/target/` gitignored, and exclude `!/rust-bot/target/**` and `!/rust-bot/Cargo.lock` from Vite globs in `src/components/RustCodebaseView.tsx`.

## 4. Verification Before Completing Changes
- **Rust**: `cd rust-bot && cargo test --workspace && cargo clippy --workspace`
- **WebApp / TS** (when `node_modules` is installed): `npm run lint && npm run build` and `npx --yes tsx --test src/engine/*.test.ts`
