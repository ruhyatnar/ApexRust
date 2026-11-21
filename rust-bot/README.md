# ApexRust Quant — Multi-Pair Binance Trading Bot (Linux Desktop & WebApp Ready)

A modular, production-structured **Rust** cryptocurrency trading bot built on top of the **official Binance Rust SDK (`binance-sdk`)** (`https://developers.binance.com/en/docs/sdks-tools/connectors/rust`), supporting both **Binance Spot** and **Binance USD-M Futures**.

## Folder Structure

```text
rust-bot/
├── Cargo.toml                     # Cargo workspace (binance-sdk 78.3 Spot + USD-M Futures, Axum, Tokio)
├── README.md                      # This guide
├── config/
│   ├── bot.example.toml           # Complete Spot/Futures, Automation, Session Windows, FeatureToggles, Risk & Git config
│   └── bot.synced.toml            # Auto-generated sanitized snapshot synced from the Web Command Center (no secrets)
├── deploy/
│   └── git-backup.sh              # Sanitized Git sync & backup script (never commits keys/secrets)
├── docs/
│   ├── ARCHITECTURE.md            # Crate graph, Web/Express bridge, WS/REST failover, OCO/GTX & FeatureToggles
│   ├── STRATEGY_GUIDE.md          # Multi-profile signals, Volume & UTC gates, ATR exits, Volatility alerts & Kelly sizing
│   └── AI_HANDOFF.md              # Invariants, TS <-> Rust parity map, and extension guide for developers & AI agents
└── crates/
    ├── bot-core/                  # Shared models, Spot/Futures config, UtcSessionWindow, FeatureToggles, VolatilitySpikeAlert
    ├── bot-indicators/            # Streaming EMA(9/21/50/200), Wilder RSI(14), ADX(14), ATR(14), Session VWAP, Vol Avg(20)
    ├── bot-strategy/              # Multi-profile signals (Pullback/Breakout/VWAP) + ATR SL/TP/Break-Even/Trailing exits
    ├── bot-risk/                  # Drawdown (pair & cumulative), Profit lock, Streak cooldown, Circuit Breaker
    ├── bot-exchange/              # binance-sdk Spot + USD-M Futures (WS primary + REST fallback, MARKET/LIMIT/GTX/OCO)
    ├── bot-engine/                # Tokio orchestrator: UTC session gating, ATR volatility spike monitor & sanitized git_sync
    ├── bot-web/                   # Embedded Axum HTTP + WebSocket telemetry bridge (:8080)
    ├── bot-desktop/               # Linux Desktop CLI & systemd daemon entry point
    └── bot-keygen/                # Ed25519 keypair generator for WS API session.logon
```

Generated Ed25519 keys live in `keys/` (created `0700`, private key `0600`, gitignored):

```bash
cargo run -p bot-keygen -- --environment testnet --out-dir keys --label main
```

## Key Capabilities

1. **Official Binance Rust SDK (`binance-sdk`) — Spot & USD-M Futures**
   - Supports **Binance Spot** (`/api/v3/*`) and **Binance USD-M Futures** (`/fapi/v1/*`, `/fapi/v3/*` with `/fapi/v2/*` fallback) with configurable leverage (`exchange.leverage`, clamped to `exchange.max_leverage` — default `3x`, hard ceiling `20x`) and `ISOLATED` / `CROSSED` margin modes.
   - Supported order methods: **Market**, **Limit** (`GTC` / `IOC` / `FOK`), **Post-Only Maker** (Spot `LIMIT_MAKER` / Futures `GTX`), and **OCO** (Spot `/api/v3/orderList/oco` + Futures `TAKE_PROFIT_MARKET` & `STOP_MARKET` bracket).

2. **WebSocket-First Architecture with Automatic REST Fallback**
   - Primary real-time market data (`@kline_<tf>`) via Binance Spot & Futures WebSocket streams.
   - Automatic stale-stream watchdog (`ws_heartbeat_timeout_ms`) transparently degrades to **`RestFallback`** polling and order placement without dropping position management.
   - Exponential backoff reconnection automatically promotes back to `WsPrimary`.

3. **Multi-Pair Trend-Following Scalping & Intraday Engine**
   - Concurrent per-symbol state machines (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `AVAXUSDT`, configurable).
   - **Strategies**: `trend_pullback` (EMA stack + RSI curl), `ema_breakout`, and `vwap_reversion`.
   - **Indicators**: Triple/Macro EMA (`9 / 21 / 50 / 200`), `ADX(14)` with `+DI / -DI`, `Wilder RSI(14)`, `ATR(14)`, `Session VWAP`, and 20-bar Average Volume expansion confirmation.

4. **Daily UTC Liquidity Session Windows**
   - Optional `features.session_window_filter` restricts new automated entries in `bot-engine` to configured daily `[[automation.session_windows]]` UTC intervals (supporting standard and overnight wrap schedules via `AutomationConfig::is_within_session_windows`).
   - Open position exit management (`manage_position_tick`) runs **24/7** even outside active UTC windows so existing risk/profit exits are never stranded.

5. **ATR-Based Exit Lifecycle & Volatility Spike Alerts**
   - **Initial Stop Loss**: `Entry ± (atr_sl_multiplier × ATR)`
   - **Partial Take Profit Ladder (TP1 / TP2)**: Configurable ATR multipliers and close ratio
   - **Automatic Break-Even**: Moves SL to `Entry ± fee_buffer` once unrealized gain reaches `break_even_trigger_r`
   - **ATR Trailing Stop**: Monotonically ratchets SL once `trailing_activation_r` is reached
   - **ATR Volatility Spike Alerts**: Monitors `atr_spike_pct_threshold` (% of price) and `atr_expansion_ratio_threshold` (vs prior ATR / TR) with per-pair `volatility_alert_cooldown_sec`, emitting `VolatilitySpikeAlert` telemetry.

6. **Granular Toggle for All 21 Features (`[features]`)**
   - **Core**: `automated_trading`, `session_window_filter`, `manual_trading`, `signal_generator`
   - **Venues**: `spot_market`, `futures_market`
   - **Transport**: `ws_primary_feed`, `rest_fallback`
   - **Indicators**: `ema_trend_filter`, `rsi_momentum_filter`, `adx_strength_filter`, `vwap_bias_filter`, `volume_confirmation_filter`, `htf_trend_filter`, `obi_entry_filter`
   - **Exits**: `atr_dynamic_exits`, `take_profit_ladder`, `break_even_stop`, `trailing_stop`
   - **Protection & Backup**: `circuit_breaker`, `git_auto_backup`

7. **Institutional Risk Management, Quantitative Sizing & Strict Isolation**
   - Cumulative max daily drawdown, per-pair daily drawdown quarantine, max daily profit lock, win/lose streak cooldowns, and global Circuit Breaker.
   - Position sizing modes: `fixed_usdt`, `fixed_risk_pct`, `quarter_kelly`, `half_kelly`, and `full_kelly`.
   - Isolated Paper Sandbox (`paper_trading = true`) vs Armed Live Execution (`armed_for_live_orders = true` + server-side secrets only).

8. **Embedded Web Bridge (`bot-web`) & Git Sync Backup**
   - `bot-web` serves `GET /api/health`, `GET /api/config`, `GET /api/snapshot`, `POST /api/control`, and `WS /ws/telemetry` on `:8080`.
   - Built-in `bot-engine::git_sync` module and `deploy/git-backup.sh` commit sanitized configs while strictly ignoring `.env`, `*.pem`, `*.key`, and `config/bot.toml`.

---

## Quick Start on Linux Desktop

### 1. Prerequisites
- Rust `1.85+` (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Binance Spot or USD-M Futures API Key & HMAC/Ed25519 Secret (Testnet recommended first)

### 2. Configure Environment & Strategy
```bash
cd rust-bot
cp config/bot.example.toml config/bot.toml

export BINANCE_API_KEY="your_api_key"
export BINANCE_API_SECRET="your_api_secret"
```

### 3. Build, Test & Run
```bash
cargo test --workspace
cargo run --release -p bot-desktop -- --config config/bot.toml --web-port 8080
```

### 4. Unified `apexrust` CLI

The workspace ships one friendly binary for every day-to-day operation, so you rarely need `cargo run` flags or hand-written `curl` calls:

```bash
cargo build --release --bin apexrust
./target/release/apexrust --help

./target/release/apexrust doctor                     # config, credentials, REST, daemon, binaries
./target/release/apexrust config validate            # parse + invariants + warnings
./target/release/apexrust keygen --label main        # Ed25519 pair with 0600 permissions
./target/release/apexrust ws-api logon               # real session.logon check
./target/release/apexrust indicators BTCUSDT         # indicator pipeline + gate checks, no daemon
./target/release/apexrust signal BTCUSDT             # strategy dry-run, never sends orders
./target/release/apexrust screen --category top_gainers
./target/release/apexrust status | snapshot | watch  # reads the running daemon
./target/release/apexrust order manual --symbol BTCUSDT --notional 15 --yes
./target/release/apexrust risk pause | resume | trip | reset
./target/release/apexrust run --config config/bot.toml
```

Global flags: `--config <path>`, `--url <daemon>`, `--token <token>`, `--json`, `--no-color`.
From the repository root the Node wrapper exposes the same surface as `./apexrust bot <command>`.

### 5. Auto-Start Service, Access Token & Backup via Git

From the repository root, use the ApexRust CLI to manage OS auto-start services (`systemd --user` on Linux, `launchd` on macOS, Scheduled Tasks on Windows) and API access tokens (`APEXRUST_PROXY_TOKEN` / `APEXRUST_WEB_TOKEN`):

```bash
cd ..
./apexrust service install bot
./apexrust token status          # view/generate/rotate access tokens (or `bot-desktop remote ...` with --token)
./rust-bot/deploy/git-backup.sh
```
