# System Architecture

ApexRust Quant spans two parity-aligned runtimes sharing an identical domain model:
1. **Rust Workspace (`rust-bot/`)**: Native 8-crate Tokio engine (`bot-desktop`, `bot-web`, `bot-engine`, `bot-exchange`, `bot-indicators`, `bot-strategy`, `bot-risk`, `bot-core`) built on `binance-sdk 78.1.0`.
2. **Web Command Center & Server Proxy (`/src`, `server.ts`, `vite.config.ts`)**: Installable Desktop/Mobile PWA + TypeScript `SimulationRuntime` + Express server-side signing & Git backup proxy on port `3000`.

---

## 1. Rust Crate Dependency Graph

```text
                    +-------------------+
                    |    bot-desktop    |  Linux Desktop CLI / systemd Daemon
                    +---------+---------+
                              |
              +---------------+---------------+
              |                               |
    +---------v---------+           +---------v---------+
    |      bot-web      |           |     bot-engine    |  Tokio Orchestrator
    |  (Axum REST + WS) |<--------->|  (Event Loop +    |  (UTC Session Gate, Vol Alerts,
    +-------------------+           |   git_sync Backup)|   24/7 Exits, Paper/Live Sim)
                                    +---------+---------+
                                              |
                 +--------------------+-------+-------+--------------------+
                 |                    |               |                    |
       +---------v---------+ +--------v--------+ +----v------------+ +-----v-----------+
       |   bot-exchange    | | bot-indicators  | |  bot-strategy   | |    bot-risk     |
       |  (binance-sdk     | | (EMA, RSI, ADX, | | (3 Profiles +   | | (Drawdown, CB,  |
       |   Spot + Futures) | |  ATR, VWAP, Vol)| |  ATR Exit Plan) | |  Streak Guards) |
       +---------+---------+ +--------+--------+ +----+------------+ +-----+-----------+
                 |                    |               |                    |
                 +--------------------+---------------+--------------------+
                                              |
                                    +---------v---------+
                                    |     bot-core      |  Shared Models, UtcSessionWindow,
                                    +-------------------+  19 FeatureToggles, BotConfig
```

---

## 2. Web Command Center, Desktop PWA & Express Proxy

```text
+-----------------------------------------------------------------------+
| Browser / Standalone Desktop PWA (React 19 + Tailwind v4 + Workbox)   |
|  - Isolated Paper SimulationRuntime (localStorage config persistence) |
|  - Isolated Live SimulationRuntime (BinanceLive WS + Proxy fills)     |
|  - Web Notification API for ATR Volatility Spike Alerts               |
+---------------------------+-----------------------+-------------------+
                            | /api/live/*           | /api/git/*
                            v                       v
+-----------------------------------------------------------------------+
| Express Server Proxy (server.ts :3000)                                |
|  - In-memory API Vault (HMAC-SHA256 / Ed25519 signing, server-only)   |
|  - Exchange filter rounding (tickSize / stepSize) & notional cap      |
|  - Git backup writer (backups/bot-config-backup.json + bot.synced.toml)|
+-----------------------------------------------------------------------+
```

- **PWA Cache Boundaries (`vite.config.ts`)**: Precaches static bundle assets for offline Paper Sandbox operation while setting `navigateFallbackDenylist: [/^\/api\//, /^\/_ah\//]` so API routes always reach Express.
- **Persistence (`src/engine/configStorage.ts`)**: `BOT_CONFIG_STORAGE_KEY` (`apexrust_bot_config_v1`) and `UI_STATE_STORAGE_KEY` (`apexrust_ui_state_v1`) run through `mergeBotConfigWithDefaults` on load so legacy snapshots retain user settings while adopting new schema defaults cleanly.

---

## 3. Binance Spot & USD-M Futures Routing (`binance-sdk`)

Official reference: [Binance Connectors — Rust](https://developers.binance.com/en/docs/sdks-tools/connectors/rust) (`binance-sdk` `78.1.0` with `spot` and `derivatives_trading_usds_futures` features).

| Venue | Environment | REST Base URL | WebSocket Stream URL | WebSocket API URL |
| :--- | :--- | :--- | :--- | :--- |
| **Spot** | Testnet | `https://testnet.binance.vision` | `wss://stream.testnet.binance.vision/stream` | `wss://ws-api.testnet.binance.vision/ws-api/v3` |
| **Spot** | Production | `https://api.binance.com` | `wss://stream.binance.com:9443/stream` | `wss://ws-api.binance.com:443/ws-api/v3` |
| **Futures** | Testnet | `https://testnet.binancefuture.com` | `wss://stream.binancefuture.com/stream` | `wss://testnet.binancefuture.com/ws-fapi/v1` |
| **Futures** | Production | `https://fapi.binance.com` | `wss://fstream.binance.com/stream` | `wss://ws-fapi.binance.com/ws-fapi/v1` |

### Supported Order Types & Execution Safeguards
- **MARKET**: Immediate execution (`BUY` via `quoteOrderQty` on Spot or rounded `quantity` on Futures).
- **LIMIT**: Passive resting entry with `GTC`, `IOC`, or `FOK`.
- **POST-ONLY MAKER**: `LIMIT_MAKER` on Spot; `LIMIT` + `timeInForce = GTX` on USD-M Futures.
- **OCO / Bracket**:
  - **Spot**: `/api/v3/orderList/oco` (`aboveType = LIMIT_MAKER`, `belowType = STOP_LOSS_LIMIT`).
  - **Futures**: Margin & leverage alignment (`/fapi/v1/marginType`, `/fapi/v1/leverage`, skipped on `reduceOnly` closes) followed by conditional `/fapi/v1/algoOrder` `TAKE_PROFIT_MARKET` and `STOP_MARKET` protective triggers (`algoType = CONDITIONAL`, `workingType = MARK_PRICE`, `priceProtect = "true"`, `closePosition = "true"`).
- **Preflight**: Optional signed `/api/v3/order/test` or `/fapi/v1/order/test` validation before live order dispatch.

---

## 4. WebSocket Primary + REST Fallback State Machine

1. **Cold Start Warmup**: `BinanceRestClient` / `BinanceFuturesClient` issues parallel kline requests (`/api/v3/klines` or `/fapi/v1/klines`) to warm up the 200+ candle indicator ring buffer.
2. **Primary Real-Time Stream (`WsPrimary`)**: Connects to Binance combined WebSocket Stream when `features.ws_primary_feed = true`.
3. **Heartbeat Watchdog & Automatic Degradation (`RestFallback`)**: When `Instant::now() - last_ws_message_at > ws_heartbeat_timeout_ms` (and `features.rest_fallback = true`), `FailoverGateway` degrades transparently to REST polling and re-attempts WebSocket reconnection with exponential backoff.
4. **Auto-Promotion**: Once WebSocket frames stabilize, `TransportMode` returns to `WsPrimary`.

---

## 5. Granular Feature Gating (19 `FeatureToggles`) & Runtime Controls

Every subsystem checks `BotConfig.features` before executing:
- **Execution & Session Timing**: `automated_trading`, `session_window_filter` (gates new automated entries against `[[automation.session_windows]]` UTC intervals while keeping open-position exit checks active 24/7), `manual_trading`, `signal_generator`.
- **Venues & Transport**: `spot_market`, `futures_market`, `ws_primary_feed`, `rest_fallback`.
- **Indicator Gates**: `ema_trend_filter`, `rsi_momentum_filter`, `adx_strength_filter`, `vwap_bias_filter`, `volume_confirmation_filter`.
- **Exit Lifecycle**: `atr_dynamic_exits`, `take_profit_ladder`, `break_even_stop`, `trailing_stop`.
- **Protection & Sync**: `circuit_breaker`, `git_auto_backup`.

### Volatility Spike Telemetry
Both `bot-engine` and `SimulationRuntime` track closed-candle `atr / price` (`atr_spike_pct_threshold`) and `max(atr / baseline_atr, tr / baseline_atr)` (`atr_expansion_ratio_threshold`) with per-symbol cooldown (`volatility_alert_cooldown_sec`).

---

## 6. Sanitized Git Sync & Backup

- `bot_engine::git_sync`, `deploy/git-backup.sh`, and `POST /api/git/backup` enforce `.gitignore` exclusions for `.env`, `.env.*`, `*.pem`, `*.key`, and `config/bot.toml`.
- Only sanitized snapshots (`backups/bot-config-backup.json` and `rust-bot/config/bot.synced.toml`, preserving all `[automation]`, `[[automation.session_windows]]`, `[indicators]`, `[exits]`, `[risk]`, and `[features]` fields without secrets) are staged and committed.
