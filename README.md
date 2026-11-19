# ApexRust Quant — Binance Multi-Pair Trading Bot & Web Command Center

A full-stack quantitative cryptocurrency trading platform combining an interactive **React 19 + TypeScript Web & Desktop PWA Command Center**, a local **Express Binance Signing, Order Ledger & Git Backup Proxy (`server.ts`)**, and a modular **8-crate Rust trading engine (`rust-bot/`)** built on the official **Binance Rust SDK (`binance-sdk 78.1.0`)** for **Binance Spot** and **Binance USD-M Futures**.

---

## Table of Contents

1. [Installation](#installation)
2. [System Architecture](#system-architecture)
3. [Project Structure](#project-structure)
4. [Core Trading & Quantitative Capabilities](#core-trading--quantitative-capabilities)
5. [Web Command Center & Desktop PWA](#web-command-center--desktop-pwa)
6. [Backend Proxy API (`server.ts`)](#backend-proxy-api-serverts)
7. [Configuration, Persistence & Secret Hygiene](#configuration-persistence--secret-hygiene)
8. [Rust Workspace (`rust-bot/`) & Headless Deployment](#rust-workspace-rust-bot--headless-deployment)
9. [Environment Variables (`server.ts`)](#environment-variables-serverts)
10. [Verification & Test Suite](#verification--test-suite)
11. [Additional Documentation](#additional-documentation)

---

## Installation

### Quick Guided Installer (Recommended — Linux, macOS, Windows)

Clone the repository and run the cross-platform installer. It checks/installs missing prerequisites (`Node.js ^20.19.0 || >=22.12.0`, Rust `>= 1.85.0`, and C/OpenSSL build headers) using user-local toolchains by default (prompting before any `sudo` call), builds the WebApp and/or Rust daemon, writes `.env` and a safe `paper_trading = true` `rust-bot/config/bot.toml`, and optionally registers auto-start services.

```bash
git clone <your-repo-url> ApexRust
cd ApexRust

# Linux / macOS:
./install.sh

# Windows (PowerShell — or double-click install.cmd):
.\install.ps1
```

Once installed, manage everything with the bundled CLI (`./apexrust` on Linux/macOS, `.\apexrust.cmd` on Windows):

```bash
./apexrust start | stop | restart | status | logs -f | doctor | update
./apexrust service install   # systemd --user (with optional --linger) / launchd / Scheduled Tasks
./apexrust uninstall         # add --purge to remove .env, bot.toml, node_modules, dist & rust-bot/target
```

For unattended CI / server setup:

```bash
./install.sh --yes --non-interactive --components web --env testnet --venue spot --no-service
```

---

### Manual Installation

#### Prerequisites

| Component | Requirement | Notes |
| :--- | :--- | :--- |
| **Node.js & npm** | Node `^20.19.0 \|\| >=22.12.0` & `npm` | Required for Web Command Center, Vite build & Express proxy |
| **Rust Toolchain** | Rust `1.85+` (`cargo`, `rustc`) | Required for `rust-bot/` native trading daemon (install via [rustup.rs](https://rustup.rs)) |
| **Linux Build Deps** | `build-essential`, `pkg-config`, `libssl-dev` | Required on Debian/Ubuntu when compiling Rust `openssl-sys` |
| **Git** | `git 2.30+` | Used for repository cloning and sanitized Git config backups |

### Step 1 — Clone the Repository

```bash
git clone <your-repo-url> ApexRust
cd ApexRust
```

### Step 2 — Install WebApp & Proxy Dependencies

```bash
npm install
```

*(For production-only servers where you only need to serve a prebuilt `dist/` via `npm start`, `tsx` is included in `dependencies`, so `npm install --omit=dev` also works after `dist/` is built.)*

### Step 3 — Configure & Build the Rust Desktop Engine (`rust-bot/`)

```bash
cd rust-bot
cp config/bot.example.toml config/bot.toml
cargo build --release -p bot-desktop
cd ..
```

*(The compiled binary is output to `rust-bot/target/release/bot-desktop`. Keep `rust-bot/config/bot.toml` local—it is gitignored.)*

### Step 4 — Configure API Credentials (Optional Pre-Load)

You can configure Binance Spot / USD-M Futures credentials directly in the UI (**Bot → Live Credentials**), or pre-load them via a root `.env` file (gitignored) or shell environment variables:

```bash
# Example .env at repository root (optional; Paper Sandbox works with zero keys)
PORT=3000
BINANCE_ENVIRONMENT=Testnet
BINANCE_VENUE=Spot
BINANCE_AUTH_METHOD=HMAC-SHA256
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret
# Optional shared token protecting mutating /api/live/*, /api/orders/*, /api/git/* routes
# APEXRUST_PROXY_TOKEN=your_local_secret_token
```

### Step 5 — Run the Application

#### Option A: Development Mode (Express + Vite Middleware)

```bash
npm run dev
# Serves WebApp & Proxy at http://localhost:3000
```

#### Option B: Production Mode (Built `dist/` + Express Proxy)

```bash
npm run lint
npm run build
npm start
# Serves production bundle + PWA at http://localhost:3000
```

#### Option C: Native Rust Desktop / Headless Daemon

```bash
# Run from repo root or rust-bot/
./rust-bot/target/release/bot-desktop --config rust-bot/config/bot.toml --web-port 8080
# Serves Rust Axum telemetry API & WebSocket at http://127.0.0.1:8080
```

#### Verify Running Services

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:8080/api/health
```

#### Optional: Install Desktop PWA & OS Auto-Start Service

- **Desktop App (PWA)**: Open `http://localhost:3000` in Chromium/Chrome/Edge and click **Install Desktop App** in the header bar.
- **Auto-Start OS Service** (`systemd --user` on Linux with optional `loginctl enable-linger`, `launchd` LaunchAgent on macOS, or per-user Scheduled Task on Windows):
  ```bash
  ./apexrust service install        # user-local auto-start (add --system on Linux for /etc/systemd/system)
  ./apexrust service uninstall      # remove registered auto-start services
  ```

### 24/7 VPS Deployment (Cloudflare One Zero Trust) & Cross-Platform Desktop Connection

You can run the 24/7 Rust Trading Daemon (`bot-desktop --daemon`) and Express Gateway (`server.ts`) continuously on a VPS over your **Cloudflare One Client (Zero Trust WARP Mesh `100.96.0.0/12` or `cloudflared` private tunnel)**, while monitoring, configuring API keys, viewing SQLite Order History, and placing manual orders from your **Windows, macOS, or Linux** computer—with instant switching between **`🖥️ This Computer`** and **`☁️ Remote VPS`**:

1. **On the 24/7 VPS** (auto-detects your Cloudflare One WARP virtual IP and binds `bot-web` strictly to `127.0.0.1:8080`):
   ```bash
   ./install.sh --role vps --service
   # Sets APEXRUST_ENGINE_AUTHORITY=daemon, APEXRUST_PERSIST_VAULT=true, and starts both `web` and `bot`
   ```
   - Whitelist your VPS outbound IP in Binance API Management and keep public ports `3000`/`8080` blocked on public `ufw`/`eth0`.

2. **On Your Desktop (Windows / macOS / Linux)**:
   ```bash
   # Linux / macOS:
   ./install.sh --role client --remote-url http://100.96.x.y:3000 --remote-name "Tokyo VPS"
   # Windows PowerShell:
   .\install.ps1 -PassThruArgs --role client --remote-url http://100.96.x.y:3000 --remote-name "Tokyo VPS"
   ```
   - Open your local Desktop PWA at `http://localhost:3000` and click **`🖥️ This Computer`** / **`☁️ Remote VPS`** in the top header bar (or **`Bot → VPS & Server Connection`**) to switch between local simulation and your 24/7 VPS at any time.
   - Use the cross-platform CLI on Windows (`apexrust.cmd` / `bot-desktop.exe`), macOS, or Linux:
     ```bash
     ./apexrust remote status
     ./apexrust remote use-local     # switch Desktop PWA + bot-desktop back to This Computer
     ./apexrust remote use-vps       # switch back to 24/7 Remote VPS

     # Native Rust CLI remote monitor & controls:
     ./rust-bot/target/release/bot-desktop connect --url http://100.96.x.y:3000 --name "Tokyo VPS"
     ./rust-bot/target/release/bot-desktop remote watch
     ./rust-bot/target/release/bot-desktop remote pause
     ./rust-bot/target/release/bot-desktop remote manual-order --symbol BTCUSDT --side long --notional 150 --yes
     ```

---

## System Architecture

ApexRust Quant maintains parity across two runtimes sharing an identical domain model (`BotConfig`, 19 `FeatureToggles`, streaming technical indicators, multi-profile strategies, ATR exit lifecycles, UTC session windows, and circuit-breaker risk rules):

```text
+-----------------------------------------------------------------------------+
| Browser / Installable Desktop PWA (React 19 + Tailwind v4 + Workbox)        |
|  - Isolated Paper SimulationRuntime ($10k virtual equity, localStorage)     |
|  - Isolated Live SimulationRuntime (Binance WS + verified proxy execution)  |
|  - Order History & Performance Analytics, Kelly Sizing & MTF 9-Step Audit   |
|  - Web Notifications (ATR Volatility Spike Alerts & Live Fill Alerts)       |
+------------------------------+--------------------------+-------------------+
                               | /api/market/*,           | /api/git/*
                               | /api/live/*, /api/orders/*
                               v                          v
+-----------------------------------------------------------------------------+
| Express Control Proxy (server.ts :3000)                                     |
|  - In-memory API Vault (HMAC-SHA256 / Ed25519 signing, zero disk secrets)   |
|  - Exchange filter rounding (tickSize / stepSize) & max notional safety cap |
|  - Order execution log store (.apexrust-order-logs.json) + allOrders sync   |
|  - Sanitized Git backup writer (backups/bot-config-backup.json + TOML)      |
+------------------------------+----------------------------------------------+
                               |
                               v
+-----------------------------------------------------------------------------+
| Binance Spot (/api/v3/*) & USD-M Futures (/fapi/v1/*, /fapi/v2/*)           |
|  - Testnet & Production REST + WebSocket Streams                            |
+------------------------------^----------------------------------------------+
                               | (Native 24/7 Alternative / Parity Engine)
+------------------------------+----------------------------------------------+
| Rust 8-Crate Workspace (rust-bot/, Tokio + binance-sdk 78.1.0)              |
|  - bot-desktop CLI / systemd daemon + bot-web Axum telemetry bridge (:8080) |
|  - WebSocket primary feed with automatic REST fallback & exponential backoff|
+-----------------------------------------------------------------------------+
```

---

## Project Structure

```text
.
├── index.html                        # HTML shell, PWA icons/meta, dark theme bootstrap
├── metadata.json                     # App manifest metadata
├── package.json                      # Node scripts (dev, build, start, preview, clean, lint)
├── tsconfig.json                     # TypeScript compiler configuration
├── vite.config.ts                    # Vite + Tailwind CSS v4 + VitePWA (Workbox offline cache)
├── server.ts                         # Express server: market proxy, Live Vault, order logs, Git backup, Vite/dist
├── .gitignore                        # Excludes node_modules, dist, .env*, *.pem, .apexrust-order-logs.json
├── public/                           # App icons (icon.svg, favicon.ico, apple-touch-icon, pwa-192/512/maskable)
├── backups/
│   └── bot-config-backup.json        # Sanitized config snapshot written by Git backup sync
├── src/
│   ├── main.tsx                      # React 19 entry point
│   ├── App.tsx                       # Root shell, Paper/Live runtime isolation, WS/REST feed loop, alerts
│   ├── index.css                     # Tailwind CSS v4 global theme
│   ├── hooks/
│   │   ├── useOnlineStatus.ts        # Browser navigator.onLine status hook for OfflineIndicator
│   │   └── usePWAInstall.ts          # beforeinstallprompt & standalone display-mode detection hook
│   ├── engine/
│   │   ├── types.ts                  # Shared domain types (BotConfig, FeatureToggles, OrderExecutionLog, etc.)
│   │   ├── indicators.ts             # Streaming EMA(9/21/50/200), Wilder RSI(14), ADX(14)+DI, ATR(14), VWAP, Vol Ratio
│   │   ├── strategy.ts               # Strategy profiles (trend_pullback, ema_breakout, vwap_reversion) & ATR exits
│   │   ├── risk.ts                   # Daily drawdown caps, per-pair quarantine, profit lock, streak cooldowns, CB
│   │   ├── quantAnalytics.ts         # Expectancy E(R), Profit Factor regimes, Kelly G(f), C^-1 covariance, 9-step audit
│   │   ├── sessionWindows.ts         # Daily UTC market liquidity window parser, overnight wrap & presets
│   │   ├── orderHistoryAnalytics.ts  # Order filtering, UTC date bounds, equity curve, drawdown, metrics & CSV export
│   │   ├── liveFillNotifications.ts  # Live fill deduplication & desktop Web Notification dispatcher
│   │   ├── configStorage.ts          # Schema-safe deep-merge & localStorage persistence for config & UI state
│   │   ├── simulator.ts              # Deterministic multi-pair SimulationRuntime & DEFAULT_BOT_CONFIG
│   │   ├── indicators.test.ts        # Streaming indicator unit tests
│   │   ├── riskAndStrategy.test.ts   # Strategy profile, ATR exit & circuit-breaker unit tests
│   │   ├── configStorage.test.ts     # Config persistence & backward-compatibility merge tests
│   │   ├── sessionWindows.test.ts    # UTC session window & overnight wrap tests
│   │   ├── orderHistoryAnalytics.test.ts # Order filtering, UTC date range, metrics & CSV export tests
│   │   └── liveFillNotifications.test.ts # Live execution notification deduplication & formatting tests
│   └── components/
│       ├── TradingDeskView.tsx       # Primary trading desk: Auto-Trading strip, chart, ticket, positions & ledgers
│       ├── CandlestickChart.tsx      # Interactive SVG candlestick/line chart with EMA, VWAP & SL/BE/TP overlays
│       ├── OrderTicketPanel.tsx      # Manual Spot/Futures ticket, OCO brackets, Kelly sizing & 9-step checklist
│       ├── SummaryCardsRow.tsx       # Equity, win/loss donut, daily PnL sparkline & transport telemetry cards
│       ├── MarketsAndSignalsView.tsx # Multi-pair scanner table, WS/REST failover controls & MTF signal cards
│       ├── OrderHistoryView.tsx      # Unified Paper/Live order history, performance analytics, CSV export & Binance sync
│       ├── DateRangePicker.tsx       # UTC date range calendar picker with Today / 7D / 30D presets
│       ├── TradeHistoryView.tsx      # Binance-schema execution history (myTrades / userTrades), JSON inspect & sync
│       ├── StrategyConfigView.tsx    # Strategy profiles, order methods, ATR exits & ATR Volatility Spike Alerts
│       ├── FeatureTogglesView.tsx    # 19 modular feature switches + Daily High-Liquidity UTC Session Windows editor
│       ├── RiskCircuitBreakerView.tsx# Drawdown/profit gauges, quarantine table, Kelly G(f) curve & covariance matrix
│       ├── LiveCredentialsView.tsx   # Server-side HMAC-SHA256 / Ed25519 key vault, Testnet/Prod & Live arming gate
│       ├── GitBackupView.tsx         # Sanitized Git init, remote config, commit & push UI
│       ├── RustCodebaseView.tsx      # In-app browser for rust-bot/ crates, docs, TOML configs & systemd scripts
│       └── PWAInstallButton.tsx      # Desktop PWA installer button, setup dialog & OfflineIndicator banner
└── rust-bot/                         # 8-crate Rust Cargo workspace (see rust-bot/README.md)
    ├── Cargo.toml
    ├── README.md
    ├── config/
    │   ├── bot.example.toml          # Reference Spot/Futures, Automation, Session Windows, Features & Risk config
    │   └── bot.synced.toml           # Auto-generated sanitized snapshot synced from Web Command Center
    ├── deploy/
    │   └── git-backup.sh             # Sanitized Git commit & push helper
    ├── docs/
    │   ├── ARCHITECTURE.md
    │   ├── STRATEGY_GUIDE.md
    │   └── AI_HANDOFF.md
    └── crates/
        ├── bot-core/                 # Shared types, BotConfig, UtcSessionWindow, FeatureToggles, VolatilitySpikeAlert
        ├── bot-indicators/           # Streaming EMA(9/21/50/200), Wilder RSI(14), ADX(14), ATR(14), VWAP, Vol Avg(20)
        ├── bot-strategy/             # Multi-profile entry evaluators & ATR exit lifecycle manager
        ├── bot-risk/                 # Pair & cumulative drawdown, profit lock, streak cooldown & Circuit Breaker
        ├── bot-exchange/             # binance-sdk Spot + USD-M Futures REST/WS clients & FailoverGateway
        ├── bot-engine/               # Tokio multi-pair orchestrator, UTC window gating, vol alerts & git_sync
        ├── bot-web/                  # Embedded Axum HTTP + WebSocket telemetry server (:8080)
        └── bot-desktop/              # Linux Desktop CLI & systemd daemon binary
```

---

## Core Trading & Quantitative Capabilities

### 1. Multi-Venue Execution (Binance Spot & USD-M Futures)

- **Venues & Environments**: Supports **Binance Spot** (`/api/v3/*`) and **Binance USD-M Futures** (`/fapi/v1/*`, `/fapi/v2/*`) on both **Testnet** and **Production**.
- **Futures Controls**: Configurable leverage (`1x–20x`), `ISOLATED` or `CROSSED` margin alignment (`/fapi/v1/marginType`, `/fapi/v1/leverage`), and `long_only` (Spot-safe) vs `both` (Futures Long & Short) direction policies.
- **Order Types & Safeguards**:
  - `MARKET` (Spot `quoteOrderQty` on buys or filter-rounded `quantity` on sells/Futures)
  - `LIMIT` with configurable `timeInForce` (`GTC`, `IOC`, `FOK`) and `limitOffsetBps`
  - Post-Only Maker (`LIMIT_MAKER` on Spot; `LIMIT` + `GTX` on USD-M Futures)
  - `ATR SCALP` and **OCO Brackets** (Spot `/api/v3/orderList/oco`; Futures protective `TAKE_PROFIT_MARKET` + `STOP_MARKET` on `MARK_PRICE` with `priceProtect = TRUE`)
  - Optional preflight validation (`/api/v3/order/test` or `/fapi/v1/order/test`) and server-enforced `maxOrderNotionalUsdt` cap (`$250` default).

### 2. Strict Paper Sandbox vs Live Execution Isolation

- `App.tsx` maintains two completely isolated `SimulationRuntime` instances (`paperRuntimeRef` and `liveRuntimeRef`) toggled from the header (`Paper` vs `Live`):
  - **Paper Sandbox**: Virtual `$10,000` initial equity, deterministic simulated klines or public Binance WebSocket feed, local fill simulation, and zero authenticated order requests.
  - **Live Execution**: Prohibits synthetic simulation feeds, synchronizes real account balances from `/api/live/verify`, and dispatches signed orders only after credentials are configured and Live Execution is explicitly armed. New live fills (`FILLED` / `PARTIALLY_FILLED`) emit deduplicated desktop Web Notifications via `liveFillNotifications.ts`.

### 3. Streaming Technical Indicators (`indicators.ts` / `bot-indicators`)

| Indicator | Period | Purpose |
| :--- | :--- | :--- |
| **EMA Stack** | `9 / 21 / 50 / 200` | Short/mid trend stack & intraday macro trend filter |
| **Wilder RSI** | `14` | Pullback zone detection (`42–58` default) & directional momentum curl |
| **ADX + DI** | `14` | Trend strength filter (`>= 25` default) & `+DI / -DI` directional bias |
| **ATR** | `14` | Volatility normalization for SL/TP/trailing distances & spike alerts |
| **Session VWAP** | `00:00 UTC` reset | Institutional intraday fair-value alignment |
| **Volume Baseline** | `20` bars | Volume expansion confirmation (`volume / avg_vol_20`) |

### 4. Strategy Profiles, Volume Gate & UTC Liquidity Windows

- **`trend_pullback`** (Default): EMA `9/21/50` stack (plus `Close > EMA 200` in `intraday` mode) + `ADX >= adxMinTrend` with `+DI > -DI` (or `-DI > +DI` for shorts) + `RSI(14)` curl inside pullback bounds + optional Session VWAP alignment.
- **`ema_breakout`**: 10-bar Donchian high/low breakout confirmed by stacked EMAs, `ADX(14)`, and `>= 1.1x` recent volume surge.
- **`vwap_reversion`**: Fades `>= 1.1x ATR` stretches away from Session VWAP (or `EMA 21` when VWAP filter is off) when RSI curls from oversold/overbought (`<= 38` / `>= 62`) under bounded ADX.
- **Volume Expansion Gate** (`volumeConfirmationFilter`): Enforces bar volume `>= minVolumeExpansionMult` (`1.5x` default) × 20-bar mean volume.
- **Daily High-Liquidity Market Sessions (UTC)** (`sessionWindowFilter`): When enabled, restricts **new automated entries** to active `[[automation.session_windows]]` UTC intervals (default presets: `London Open` `07:00–11:00`, `London / NY Overlap` `12:30–16:30`, `US Equities Close` `19:00–21:00` disabled; additional presets include `Tokyo / Asia Open` and `NY Cash Open`; supports overnight wrap such as `22:00–02:00`). Open position exit management continues **24/7** regardless of session windows.

### 5. ATR Exit Lifecycle & Volatility Spike Alerts

- **Initial Stop Loss ($SL_0$)**: `Entry ± (atrSlMultiplier × ATR)` (`1.5x` default, defining `1R`).
- **Partial Take Profit ($TP_1$)**: `atrTp1Multiplier × ATR` (`2.25x` = `1.5R`), closing `tp1CloseRatio` (`50%` default).
- **Automatic Break-Even**: Moves SL to `Entry ± breakEvenFeeBufferBps` (`25 bps` TS default / `12 bps` `bot.example.toml`) once gain reaches `breakEvenTriggerR` (`1.0R`).
- **Monotonic ATR Trailing Stop**: Ratchets SL strictly in the profitable direction once `trailingActivationR` (`1.2R`) is reached (`atrTrailingMultiplier = 1.4x`).
- **Final Runner Target ($TP_2$)**: `atrTp2Multiplier × ATR` (`3.75x` = `2.5R`).
- **ATR Volatility Spike Alerts**: Monitors closed-candle `ATR(14) / Price` (`atrSpikePctThreshold = 0.45%`) and TR/ATR expansion vs rolling 10-bar baseline (`atrExpansionRatioThreshold = 1.25x`) with per-pair cooldown (`volatilityAlertCooldownSec = 60s`), dispatching in-app banners and browser Web Notifications.

### 6. Quantitative Sizing, Risk Circuit Breaker & Order Analytics

- **Position Sizing Modes**: `fixed_usdt`, `fixed_risk_pct`, `quarter_kelly` (`0.25 f*`), `half_kelly` (`0.50 f*`), and `full_kelly` (`1.00 f*`) using expected log utility $G(f)$ and portfolio inverse-covariance diversification $C^{-1}\mu$, halting automated Kelly entries when $f^* \le 0$.
- **Quantitative Analytics (`quantAnalytics.ts`)**: Expectancy $E(R)$, Profit Factor regimes (`NetLosing`, `SubThreshold`, `ViableEdge`, `StrongEdge`, `OverfitWarning`), Multi-Timeframe alignment (`D1/H4/H1/M5`), and 9-Step Pre-Trade Validation.
- **Risk & Circuit Breaker (`risk.ts` / `bot-risk`)**: Cumulative daily drawdown cap (`3.0%`), per-pair daily drawdown quarantine (`1.25%`), daily profit target lock (`5.0%`), win/lose streak cooldowns (`5` wins / `3` losses → `30m`), and emergency Flatten All.
- **Order History & Performance Analytics (`orderHistoryAnalytics.ts`)**: Filterable by account mode, venue, status, symbol, search query, and UTC date range (`Today`, `7D`, `30D`, or custom calendar bounds), computing fill rate, maker/taker ratio, net realized PnL, profit factor, average R-multiple, P95 latency, cumulative equity curve, max drawdown, and RFC-4180 CSV export.

### 7. Granular Feature Toggles (19 Independent Switches)

Configurable in **Bot → Feature Toggles** and `[features]` in Rust TOML:

| Category | Feature Flags |
| :--- | :--- |
| **Execution & Signal Core** | `automatedTrading`, `sessionWindowFilter`, `manualTrading`, `signalGenerator` |
| **Binance Market Venues** | `spotMarket`, `futuresMarket` |
| **Connectivity & Failover** | `wsPrimaryFeed`, `restFallback` |
| **Technical Indicator Filters** | `emaTrendFilter`, `rsiMomentumFilter`, `adxStrengthFilter`, `vwapBiasFilter`, `volumeConfirmationFilter` |
| **ATR Exits & Protection** | `atrDynamicExits`, `takeProfitLadder`, `breakEvenStop`, `trailingStop` |
| **Risk Guard & Backup** | `circuitBreaker`, `gitAutoBackup` |

---

## Web Command Center & Desktop PWA

### Navigation & Views

- **Trade (`TradingDeskView.tsx`)**: Auto-Trading header strip, summary KPI cards, interactive SVG candlestick chart (EMA `9/21/50/200`, VWAP, SL/BE/TP overlays), manual Spot/Futures order ticket with Kelly sizing & 9-step audit, and open positions/pending/closed trade ledgers.
- **Markets (`MarketsAndSignalsView.tsx`)**: Multi-pair live scanner (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `AVAXUSDT`), WebSocket/REST transport failover telemetry, and per-pair inspection.
- **Orders (`OrderHistoryView.tsx`)**: Unified Paper/Live order execution ledger, UTC `DateRangePicker`, equity/drawdown analytics, JSON inspector, CSV export, and Binance `allOrders` sync.
- **Bot**:
  - **Strategy (`StrategyConfigView.tsx`)**: Strategy profiles, order execution methods, ATR exit multipliers, and ATR Volatility Spike Alerts console.
  - **Features (`FeatureTogglesView.tsx`)**: 19 modular feature switches and Daily High-Liquidity UTC Session Windows editor.
  - **Risk (`RiskCircuitBreakerView.tsx`)**: Daily drawdown/profit gauges, per-pair quarantine controls, Kelly $G(f)$ utility curve, and $C^{-1}$ covariance matrix.
  - **Credentials (`LiveCredentialsView.tsx`)**: Server-side `HMAC-SHA256` / `Ed25519` vault, Testnet/Production & Spot/Futures selector, balance verification, and Live Arming gate.
  - **Git Backup (`GitBackupView.tsx`)**: Sanitized Git repository initialization, remote setup, snapshot commit, and push controls.
- **Signal (`MarketsAndSignalsView.tsx`)**: Multi-timeframe (`D1/H4/H1/M5`) signal matrix and per-pair indicator checklist.
- **Rust (`RustCodebaseView.tsx`)**: In-app explorer for the `rust-bot/` crates, TOML config templates, `systemd` service, and architecture docs.

### Desktop & Mobile PWA Support

Configured in `vite.config.ts` via `vite-plugin-pwa`:
- Installable standalone window (`display: "standalone"`) via the **Install Desktop App** header button (`PWAInstallButton.tsx`) or browser prompt.
- Workbox precaches static assets (`js`, `css`, `html`, `ico`, `png`, `svg`, `woff`, `woff2`) and Google Fonts while excluding `/api/*` and `/_ah/*` via `navigateFallbackDenylist` so API requests always hit Express.
- `OfflineIndicator` surfaces network status while keeping the Paper Sandbox operational offline.

---

## Backend Proxy API (`server.ts`)

Express runs on port `3000` (`0.0.0.0:3000`), mounting Vite middleware in development or serving `dist/` in production. Mutating requests to `/api/live/*`, `/api/git/*`, and `/api/orders/*` reject `sec-fetch-site: cross-site` headers.

| Method & Path | Purpose |
| :--- | :--- |
| `GET /api/health`, `/_ah/health` | Health check returning active environment and venue |
| `GET /api/market/klines` | Public Binance Spot/Futures kline proxy (avoids browser CORS on Futures/Testnet) |
| `GET /api/market/ticker` | Public Binance Spot/Futures ticker proxy |
| `GET /api/live/config` | Masked vault status (`apiKeyMasked`, venue, environment, leverage, balances; secrets never returned) |
| `POST /api/live/config` | Stores Binance Spot/Futures credentials (`HMAC-SHA256` or `Ed25519`), venue, leverage, margin & notional cap in server memory |
| `POST /api/live/verify` | Executes signed `/api/v3/account` or `/fapi/v2/account` check & syncs wallet balances |
| `POST /api/live/arm` | Arms or disarms live order execution (requires explicit confirmation in `Production`) |
| `POST /api/live/order` | Runs optional `/order/test` preflight and executes `MARKET`, `LIMIT`, `LIMIT_MAKER`/`GTX`, or `OCO`/bracket orders with filter rounding & `maxOrderNotionalUsdt` cap |
| `GET /api/live/open-orders` | Queries open Binance Spot/Futures orders (`/api/v3/openOrders` or `/fapi/v1/openOrders` + `/fapi/v1/algoOpenOrders`) |
| `GET /api/live/order-status` | Queries single order status (`/api/v3/order` or `/fapi/v1/order`) to reconcile filled vs canceled resting limit orders |
| `POST /api/live/cancel-open-brackets` | Cancels open Spot OCO order lists or Futures algo orders for a symbol |
| `DELETE /api/live/order` | Cancels an open Spot/Futures order, OCO list, or Futures algo order |
| `GET /api/live/trades` | Pulls signed account trade fills (`/api/v3/myTrades` or `/fapi/v1/userTrades`) |
| `DELETE /api/live/config` | Clears credentials from server memory and disarms live execution |
| `GET /api/orders/history` | Queries persisted order execution logs (`.apexrust-order-logs.json`), optionally syncing Binance `allOrders` |
| `POST /api/orders/history` | Upserts paper or live order execution logs |
| `DELETE /api/orders/history` | Clears order execution logs (`Paper`, `Live`, or `ALL`) |
| `GET /api/git/status` | Returns Git initialization state, branch, sanitized remote URL, dirty files, and recent commits |
| `POST /api/git/init` | Ensures secret-safe `.gitignore` and initializes local Git repository |
| `POST /api/git/remote` | Validates and configures `origin` HTTPS/SSH remote URL |
| `POST /api/git/backup` | Writes `backups/bot-config-backup.json` & `rust-bot/config/bot.synced.toml` and commits (with optional push) |

---

## Configuration, Persistence & Secret Hygiene

- **Browser `localStorage` (`src/engine/configStorage.ts`)**:
  - `apexrust_bot_config_v1`: Persists `BotConfig` via `mergeBotConfigWithDefaults` so older saved configs safely backfill newly added schema fields.
  - `apexrust_ui_state_v1`: Persists `accountMode` (`Paper`/`Live`), active navigation tab/sub-tab, `selectedSymbol`, `environment`, and `paperFeedSource`.
- **Sanitized Config Sync**:
  - Triggering Git Backup writes `backups/bot-config-backup.json` and `rust-bot/config/bot.synced.toml` with zero API keys or private keys.
- **Secret Hygiene**:
  - API keys and signing secrets remain strictly in server process memory (`server.ts`) or environment variables / local `bot.toml` (gitignored). `.gitignore` excludes `.env`, `.env.*`, `*.pem`, and `.apexrust-order-logs.json` (and `git-backup.sh` also ensures `*.key`, `config/bot.toml`, and `backups/*.secret*` are ignored).

---

## Rust Workspace (`rust-bot/`) & Headless Deployment

The `rust-bot/` workspace implements the full trading engine in Rust (`edition = "2021"`, `binance-sdk 78.1.0`, `tokio 1.47`, `axum 0.8`):

| Crate | Responsibility |
| :--- | :--- |
| `bot-core` | Shared models, Spot/Futures `BotConfig`, `UtcSessionWindow`, `FeatureToggles`, `VolatilitySpikeAlert` |
| `bot-indicators` | Streaming `EMA(9/21/50/200)`, `Wilder RSI(14)`, `ADX(14) + DI`, `ATR(14)`, `Session VWAP`, `Vol Avg(20)` |
| `bot-strategy` | `trend_pullback`, `ema_breakout`, `vwap_reversion` evaluators & ATR exit lifecycle manager |
| `bot-risk` | Pair & cumulative daily drawdown limits, profit lock, streak cooldowns & Circuit Breaker |
| `bot-exchange` | `binance-sdk` Spot + USD-M Futures REST/WS clients, `MARKET`/`LIMIT`/`GTX`/`OCO`, and `FailoverGateway` |
| `bot-engine` | Tokio multi-pair orchestrator, UTC session window gating, volatility spike monitor & `git_sync` |
| `bot-web` | Embedded Axum HTTP + WebSocket telemetry bridge (`:8080`): `GET /api/health`, `/api/config`, `/api/snapshot`, `POST /api/control` (`pause`, `resume`, `trip_cb`, `reset_cb`, `flatten_all`, `backup_now`, `manual_order`), `WS /ws/telemetry` |
| `bot-desktop` | Linux Desktop CLI & `systemd` daemon (`--config <path>`, `--web-port <port>`, `0` disables web bridge) |

### Linux `systemd` & Sanitized Git Backup

```bash
cd rust-bot
cp config/bot.example.toml config/bot.toml
cargo build --release -p bot-desktop

# Optional OS auto-start service install & sanitized Git snapshot
../apexrust service install bot --linger
./deploy/git-backup.sh
```

---

## Environment Variables (`server.ts`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port for Express + Vite / `dist/` server |
| `HOST` | `0.0.0.0` (`.env` defaults to `127.0.0.1`) | HTTP bind address (`0.0.0.0` when unset; installer sets `127.0.0.1` unless `--lan`) |
| `BINANCE_ENVIRONMENT` | `Testnet` | `Testnet` or `Production` |
| `BINANCE_VENUE` | `Spot` | `Spot` or `Futures` |
| `BINANCE_AUTH_METHOD` | `HMAC-SHA256` | `HMAC-SHA256` or `Ed25519` |
| `BINANCE_API_KEY` | `""` | Optional pre-loaded Binance API key |
| `BINANCE_API_SECRET` | `""` | Optional pre-loaded `HMAC-SHA256` secret |
| `BINANCE_ED25519_PRIVATE_KEY` | `""` | Optional inline `Ed25519` PEM private key |
| `BINANCE_PRIVATE_KEY_PATH` | `""` | Optional path to `Ed25519` PEM private key file |
| `BINANCE_FUTURES_TESTNET_REST` | `""` | Optional override URL for Futures Testnet REST |
| `APEXRUST_PROXY_TOKEN` | `""` | Optional shared token required on mutating `/api/live/*`, `/api/orders/*`, `/api/git/*` requests (`x-apexrust-token` or `Bearer`) |
| `DISABLE_HMR` | `false` | Set `true` to disable Vite HMR & file watching |

---

## Verification & Test Suite

### TypeScript Engine & Analytics Unit Tests

Run all 6 pure-logic test suites using Node's built-in test runner via `tsx` (after `npm install`):

```bash
npx --yes tsx --test \
  src/engine/indicators.test.ts \
  src/engine/riskAndStrategy.test.ts \
  src/engine/configStorage.test.ts \
  src/engine/sessionWindows.test.ts \
  src/engine/orderHistoryAnalytics.test.ts \
  src/engine/liveFillNotifications.test.ts
```

### Installer & Lifecycle CLI Tests

```bash
npm run test:installer
```

### Type-Check & Production Build

```bash
npm run lint && npm run build
```

### Rust Workspace Tests

```bash
cd rust-bot && cargo test --workspace
```

---

## Additional Documentation

- [`rust-bot/README.md`](rust-bot/README.md) — Rust workspace overview & Linux desktop quick start
- [`rust-bot/docs/ARCHITECTURE.md`](rust-bot/docs/ARCHITECTURE.md) — Crate dependency graph, Binance endpoints, WS/REST failover state machine & PWA boundaries
- [`rust-bot/docs/STRATEGY_GUIDE.md`](rust-bot/docs/STRATEGY_GUIDE.md) — Mathematical definitions for indicators, strategy profiles, ATR exits, volatility alerts & Kelly sizing
- [`rust-bot/docs/AI_HANDOFF.md`](rust-bot/docs/AI_HANDOFF.md) — Non-negotiable invariants, TypeScript ↔ Rust parity map & extension checklists
