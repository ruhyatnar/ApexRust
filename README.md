# ApexRust Quant — Binance Multi-Pair Trading Bot & Web Command Center

A full-stack quantitative cryptocurrency trading system combining an interactive **React + TypeScript Web & Desktop PWA Command Center**, a local **Express Binance Signing & Git Backup Proxy**, and a modular **8-crate Rust trading engine** built on the official **Binance Rust SDK (`binance-sdk`)** for **Binance Spot** and **Binance USD-M Futures**.

---

## Table of Contents
1. [Project Layout](#project-layout)
2. [Core Capabilities](#core-capabilities)
3. [Web Command Center & Desktop PWA](#web-command-center--desktop-pwa)
4. [Backend Proxy API (`server.ts`)](#backend-proxy-api-serverts)
5. [Persistence & Configuration Sync](#persistence--configuration-sync)
6. [Rust Workspace (`rust-bot/`)](#rust-workspace-rust-bot)
7. [Quick Start & Commands](#quick-start--commands)
8. [Verification & Test Suite](#verification--test-suite)

---

## Project Layout

```text
.
├── index.html                        # HTML shell, PWA icons/meta, dark theme bootstrap
├── metadata.json                     # App manifest metadata
├── package.json                      # Node scripts (dev, build, start, lint) & dependencies
├── vite.config.ts                    # Vite + Tailwind v4 + VitePWA (Workbox offline cache)
├── server.ts                         # Express server: Binance Live Vault proxy, Git backup, TOML sync, Vite/dist serving
├── public/                           # App icons (icon.svg, favicon.ico, apple-touch-icon, pwa-192/512/maskable)
├── backups/
│   └── bot-config-backup.json        # Sanitized config & summary snapshot written by Git backup sync
├── src/
│   ├── App.tsx                       # Root shell, strict Paper/Live runtime isolation, WS/REST feed loop, push alerts
│   ├── main.tsx                      # React entry point
│   ├── index.css                     # Tailwind CSS v4 global theme
│   ├── hooks/
│   │   ├── useOnlineStatus.ts        # Browser navigator.onLine status hook for Desktop/PWA offline banner
│   │   └── usePWAInstall.ts          # beforeinstallprompt & standalone display-mode detection hook
│   ├── engine/
│   │   ├── types.ts                  # Shared domain types (BotConfig, FeatureToggles, UtcTimeWindow, EngineSnapshot, etc.)
│   │   ├── indicators.ts             # Streaming EMA(9/21/50/200), Wilder RSI(14), ADX(14)+DI, ATR(14), Session VWAP, Vol Ratio
│   │   ├── strategy.ts               # Strategy evaluators (trend_pullback, ema_breakout, vwap_reversion) & ATR exit lifecycle
│   │   ├── risk.ts                   # Daily drawdown caps, per-pair quarantine, profit lock, streak cooldowns, Circuit Breaker
│   │   ├── quantAnalytics.ts         # Expectancy E(R), Profit Factor, Kelly Criterion G(f), C^-1 covariance matrix, 9-step audit
│   │   ├── sessionWindows.ts         # Daily UTC market liquidity window parser, overnight wrap evaluator & presets
│   │   ├── configStorage.ts          # Safe deep-merge & localStorage persistence for BotConfig and workspace UI state
│   │   ├── simulator.ts              # Deterministic multi-pair SimulationRuntime (Paper/Live parity, ATR alerts, UTC gating)
│   │   └── *.test.ts                 # Node test runner suites (indicators, riskAndStrategy, configStorage, sessionWindows)
│   └── components/
│       ├── TradingDeskView.tsx       # Primary desk: Auto-Trading strip, summary cards, chart, order ticket & ledgers
│       ├── CandlestickChart.tsx      # Interactive SVG candlestick/line chart with EMA, VWAP & SL/BE/TP brackets
│       ├── OrderTicketPanel.tsx      # Manual Spot/Futures ticket, OCO brackets, Kelly sizing & 9-step checklist
│       ├── SummaryCardsRow.tsx       # Equity, win/loss donut, daily PnL sparkline & transport telemetry cards
│       ├── TradeHistoryView.tsx      # Binance-schema execution history (myTrades / userTrades), JSON inspect & live sync
│       ├── MarketsAndSignalsView.tsx # Multi-pair scanner table, WS/REST failover controls & MTF signal cards
│       ├── StrategyConfigView.tsx    # Strategy profiles, order methods, ATR exits & ATR Volatility Spike Alerts console
│       ├── FeatureTogglesView.tsx    # 19 modular feature switches + Daily High-Liquidity UTC Session Windows editor
│       ├── RiskCircuitBreakerView.tsx# Drawdown/profit gauges, quarantine table, Kelly G(f) curve & covariance matrix
│       ├── LiveCredentialsView.tsx   # Server-side HMAC-SHA256 / Ed25519 key vault, Testnet/Prod & Live arming gate
│       ├── GitBackupView.tsx         # Sanitized Git init, remote config, commit & push UI
│       ├── RustCodebaseView.tsx      # In-app browser for all rust-bot/ crates, docs, TOML configs & systemd scripts
│       └── PWAInstallButton.tsx      # Desktop PWA installer button, setup dialog & OfflineIndicator banner
└── rust-bot/                         # Complete 8-crate Rust Cargo workspace (see rust-bot/README.md)
```

---

## Core Capabilities

### 1. Multi-Venue Trading (Binance Spot & USD-M Futures)
- **Venues**: **Binance Spot** (`/api/v3/*`) and **Binance USD-M Futures** (`/fapi/v1/*`, `/fapi/v2/*`) across both **Testnet** and **Production**.
- **Futures Controls**: Configurable leverage (`1x–20x`), `ISOLATED` / `CROSSED` margin alignment (`/fapi/v1/marginType`, `/fapi/v1/leverage`), and `long_only` vs `both` (Long & Short) direction policies.
- **Order Types**: `MARKET`, `LIMIT` (`GTC` / `IOC` / `FOK`), `LIMIT_MAKER` (Spot) / `GTX` Post-Only (Futures), `ATR SCALP`, and **OCO Brackets** (Spot `/api/v3/orderList/oco` and Futures `TAKE_PROFIT_MARKET` + `STOP_MARKET` on `MARK_PRICE`).

### 2. Strict Paper Sandbox vs Live Execution Isolation
- Two completely separate `SimulationRuntime` instances run side-by-side (`PAPER` vs `LIVE` header toggle):
  - **Paper Runtime**: `$10,000` virtual equity, deterministic simulated klines or public Binance WebSocket market data, local fills, and zero authenticated order requests.
  - **Live Runtime**: Synchronizes real wallet balances from `/api/live/verify`, prohibits synthetic simulation feeds, and dispatches signed orders only when credentials are configured and Live Execution is explicitly armed.

### 3. Autonomous Strategy Profiles, Volume Gate & UTC Session Windows
- **3 Strategy Profiles**:
  1. `trend_pullback`: EMA `9/21/50/(200 intraday)` alignment + `ADX(14)` trend strength + `Wilder RSI(14)` pullback curl + optional Session VWAP bias.
  2. `ema_breakout`: 10-bar Donchian breakout + stacked EMAs + `ADX(14)` + volume surge (`>= 1.1x`).
  3. `vwap_reversion`: Fades `>= 1.1x ATR` stretches away from Session VWAP when RSI curls from extremes under bounded ADX.
- **Volume Expansion Confirmation** (`volumeConfirmationFilter`): Enforces bar volume `>= minVolumeExpansionMult` (`1.5x` default) × 20-bar baseline volume.
- **Daily High-Liquidity Market Sessions (UTC)** (`sessionWindowFilter`): When enabled, restricts **new automated entry execution** to enabled daily UTC intervals (defaults: `London Open` `07:00–11:00`, `London / NY Overlap` `12:30–16:30`, `US Equities Close` `19:00–21:00` disabled; presets also include `Tokyo / Asia Open` and `NY Cash Open`; supports overnight wrap e.g. `22:00–02:00`). Open position exit management (SL, Break-Even, ATR Trailing Stop, TP1/TP2) continues **24/7** so positions are never stranded outside windows.

### 4. ATR Exits, Volatility Spike Alerts & Quantitative Risk
- **ATR Exit Lifecycle**: Initial SL (`atrSlMultiplier * ATR`), Partial TP1 (`atrTp1Multiplier * ATR`, closing `tp1CloseRatio`), Automatic Break-Even (`breakEvenTriggerR` + `breakEvenFeeBufferBps`), Monotonic ATR Trailing Stop (`trailingActivationR`, `atrTrailingMultiplier`), and Final TP2 target (`atrTp2Multiplier * ATR`).
- **ATR Volatility Spike Alerts**: Monitors `ATR(14) / Price` (`atrSpikePctThreshold`) and TR/ATR expansion vs rolling 10-bar baseline (`atrExpansionRatioThreshold`) with per-pair cooldown (`volatilityAlertCooldownSec`), dispatching Web Notifications (when granted) and in-app banners.
- **Quantitative Analytics (`quantAnalytics.ts`)**: Expectancy `E(R)`, Profit Factor regimes, Expected Logarithmic Utility curve `G(f)`, Fractional Kelly sizing (`quarter_kelly`, `half_kelly`, `full_kelly`, `fixed_risk_pct`, `fixed_usdt`), Multi-Asset Portfolio Covariance Kelly Matrix (`f* = C^-1 * mu`), Multi-Timeframe alignment (`D1/H4/H1/M5`), and 9-Step Pre-Trade Validation.
- **Circuit Breaker & Quarantine**: Cumulative daily drawdown cap, per-pair daily drawdown quarantine, daily profit target lock, win/lose streak cooldowns, and emergency Flatten All.

### 5. Granular Feature Toggles (19 Independent Switches)
All subsystems can be switched independently in **Bot → Feature Toggles** (and in `[features]` in Rust TOML):
- **Execution & Signal Core**: `automatedTrading`, `sessionWindowFilter`, `manualTrading`, `signalGenerator`
- **Binance Market Venues**: `spotMarket`, `futuresMarket`
- **Connectivity & Failover**: `wsPrimaryFeed`, `restFallback`
- **Technical Indicator Filters**: `emaTrendFilter`, `rsiMomentumFilter`, `adxStrengthFilter`, `vwapBiasFilter`, `volumeConfirmationFilter`
- **ATR Exits & Protection**: `atrDynamicExits`, `takeProfitLadder`, `breakEvenStop`, `trailingStop`
- **Risk Guard & Backup**: `circuitBreaker`, `gitAutoBackup`

---

## Web Command Center & Desktop PWA

The web application is configured via `vite-plugin-pwa` as an installable **Desktop & Mobile Progressive Web App**:
- **Standalone Window Mode**: Install via the **Install Desktop App** header button (or browser address-bar install prompt) for a native-window desktop experience with desktop notifications and cached static assets.
- **Offline Continuity**: Workbox precaches JS/CSS/HTML/SVG/PNG/WOFF assets while excluding `/api/*` via `navigateFallbackDenylist`, and `OfflineIndicator` surfaces offline status while keeping Paper Sandbox simulation functional.

---

## Backend Proxy API (`server.ts`)

Express runs on port `3000` (`0.0.0.0:3000`), mounting Vite middleware in development or serving `dist/` in production:

| Method & Path | Purpose |
| :--- | :--- |
| `GET /api/health`, `/_ah/health` | Server proxy health check returning active environment and venue |
| `GET /api/live/config` | Returns masked vault status (`apiKeyMasked`, environment, venue, balances; secrets never returned) |
| `POST /api/live/config` | Stores Binance Spot/Futures credentials (`HMAC-SHA256` or `Ed25519`), venue, leverage, margin & notional safety cap in server memory |
| `POST /api/live/verify` | Executes signed `/api/v3/account` or `/fapi/v2/account` verification & syncs wallet balances |
| `POST /api/live/arm` | Arms/disarms live order execution (requires explicit confirmation in `Production`) |
| `POST /api/live/order` | Runs optional `/order/test` preflight and executes live `MARKET`, `LIMIT`, `LIMIT_MAKER`/`GTX`, or `OCO` orders with server `maxOrderNotionalUsdt` cap & exchange filter rounding |
| `DELETE /api/live/order` | Cancels an open Binance Spot/Futures order by `symbol` + `orderId` |
| `GET /api/live/trades` | Pulls recent signed account fills (`/api/v3/myTrades` or `/fapi/v1/userTrades`) |
| `DELETE /api/live/config` | Clears credentials from server memory and disarms live execution |
| `GET /api/git/status` | Returns Git initialization state, branch, sanitized remote URL, dirty files, and recent commits |
| `POST /api/git/init` | Ensures secret-safe `.gitignore` and initializes local Git repository |
| `POST /api/git/remote` | Validates and sets `origin` HTTPS/SSH remote URL |
| `POST /api/git/backup` | Exports `backups/bot-config-backup.json` & `rust-bot/config/bot.synced.toml` and creates a sanitized Git commit (with optional push) |

---

## Persistence & Configuration Sync

- **Browser Persistence (`src/engine/configStorage.ts`)**:
  - `apexrust_bot_config_v1`: Saves full `BotConfig` (`trading`, `indicators`, `exits`, `risk`, `automation` including `sessionWindows`, and `features`) via `mergeBotConfigWithDefaults` so newly added schema fields backfill cleanly onto older saved configs.
  - `apexrust_ui_state_v1`: Persists `accountMode` (`Paper`/`Live`), active navigation tab/sub-tab, `selectedSymbol`, `environment`, and `paperFeedSource`.
- **TOML Parity Export**: Triggering Git Backup (or saving with `gitAutoBackup` enabled) writes a matching TOML preset to `rust-bot/config/bot.synced.toml` with zero secrets.

---

## Rust Workspace (`rust-bot/`)

The `rust-bot/` directory contains an 8-crate Cargo workspace mirroring the TypeScript engine for native Linux desktop & 24/7 `systemd` deployment:
- `bot-core`, `bot-indicators`, `bot-strategy`, `bot-risk`, `bot-exchange`, `bot-engine`, `bot-web`, `bot-desktop`

See [`rust-bot/README.md`](rust-bot/README.md) and [`rust-bot/docs/`](rust-bot/docs/) for detailed Rust documentation:
- [`rust-bot/docs/ARCHITECTURE.md`](rust-bot/docs/ARCHITECTURE.md)
- [`rust-bot/docs/STRATEGY_GUIDE.md`](rust-bot/docs/STRATEGY_GUIDE.md)
- [`rust-bot/docs/AI_HANDOFF.md`](rust-bot/docs/AI_HANDOFF.md)

---

## Quick Start & Commands

```bash
# 1. Install Node dependencies
npm install

# 2. Start full-stack dev server (Express + Vite on http://localhost:3000)
npm run dev

# 3. Type-check & build production bundle
npm run lint
npm run build

# 4. Run production server serving dist/
npm start
```

Optional environment variables for `server.ts` (if pre-loading vault defaults instead of configuring in **Live Credentials**):
- `PORT` (default `3000`)
- `BINANCE_ENVIRONMENT` (`Testnet` | `Production`)
- `BINANCE_VENUE` (`Spot` | `Futures`)
- `BINANCE_AUTH_METHOD` (`HMAC-SHA256` | `Ed25519`)
- `BINANCE_API_KEY`, `BINANCE_API_SECRET` or `BINANCE_ED25519_PRIVATE_KEY`

---

## Verification & Test Suite

Run all TypeScript engine & persistence unit tests with Node's built-in test runner via `tsx`:

```bash
npx --yes tsx --test src/engine/indicators.test.ts src/engine/riskAndStrategy.test.ts src/engine/configStorage.test.ts src/engine/sessionWindows.test.ts
```

For the Rust workspace (on hosts with Rust `1.86+` / Cargo installed):

```bash
cd rust-bot && cargo test --workspace
```
