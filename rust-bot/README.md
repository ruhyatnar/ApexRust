# ApexRust Quant — Multi-Pair Binance Trading Bot (Linux Desktop & WebApp Ready)

A modular, production-structured **Rust** cryptocurrency trading bot built on top of the **official Binance Rust SDK (`binance-sdk`)** (`https://developers.binance.com/en/docs/sdks-tools/connectors/rust`), supporting both **Binance Spot** and **Binance USD-M Futures**.

## Folder Structure

```text
rust-bot/
├── Cargo.toml                     # Cargo workspace (binance-sdk 78.x spot + derivatives_trading_usds_futures)
├── config/bot.example.toml        # Complete Spot/Futures, Automation, FeatureToggles, Risk & Git Backup config
├── deploy/
│   ├── git-backup.sh              # Sanitized Git sync & backup script (never commits keys/secrets)
│   └── rust-quant-bot.service     # Linux systemd unit for headless 24/7 operation
├── docs/
│   ├── ARCHITECTURE.md            # Crate graph, WS/REST failover, OCO/GTX flows, Futures margin & Git sync
│   └── AI_HANDOFF.md              # Invariants and extension guide for developers & AI assistants
└── crates/
    ├── bot-core/                  # Shared models, Spot/Futures config, FeatureToggles, GitBackupConfig
    ├── bot-indicators/            # Streaming EMA(9/21/50/200), Wilder RSI(14), ADX(14), ATR(14), Session VWAP
    ├── bot-strategy/              # Multi-profile signal generator + ATR SL/TP/Break-Even/Trailing exits
    ├── bot-risk/                  # Drawdown (pair & cumulative), Profit lock, Streak cooldown, Circuit Breaker
    ├── bot-exchange/              # binance-sdk Spot + USD-M Futures (WS primary + REST fallback, MARKET/LIMIT/GTX/OCO)
    ├── bot-engine/                # Tokio single-writer orchestrator + sanitized git_sync backup module
    ├── bot-web/                   # Embedded Axum HTTP + WebSocket telemetry bridge (:8080)
    └── bot-desktop/               # Linux Desktop CLI & daemon entry point
```

## Key Capabilities

1. **Official Binance Rust SDK (`binance-sdk`) — Spot & USD-M Futures**
   - Supports **Binance Spot** (`/api/v3/*`) and **Binance USD-M Futures** (`/fapi/v1/*`, `/fapi/v2/*`) with configurable leverage (`1x–20x`) and `ISOLATED` / `CROSSED` margin modes.
   - Supported order methods: **Market**, **Limit** (`GTC` / `IOC` / `FOK`), **Post-Only Maker** (Spot `LIMIT_MAKER` / Futures `GTX`), and **OCO** (Spot `/api/v3/orderList/oco` + Futures `TAKE_PROFIT_MARKET` & `STOP_MARKET` bracket).

2. **WebSocket-First Architecture with Automatic REST Fallback**
   - Primary real-time market data (`@kline_<tf>`, `@bookTicker`) via Binance Spot & Futures WebSocket streams.
   - Automatic stale-stream watchdog (`ws_heartbeat_timeout_ms`) transparently degrades to **`RestFallback`** polling and order placement without dropping position management.
   - Exponential backoff reconnection automatically promotes back to `WsPrimary`.

3. **Multi-Pair Trend-Following Scalping & Intraday Engine**
   - Concurrent per-symbol state machines (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `AVAXUSDT`, configurable).
   - **Strategies**: `trend_pullback` (EMA stack + RSI curl), `ema_breakout`, and `vwap_reversion`.
   - **Indicators**: Triple EMA (`9 / 21 / 50 / 200`), `ADX(14)` with `+DI / -DI`, `Wilder RSI(14)`, `ATR(14)`, and `Session VWAP`.

4. **ATR-Based Exit Lifecycle (SL, TP, Break-Even, Trailing Stop)**
   - **Initial Stop Loss**: `Entry ± (atr_sl_mult × ATR)`
   - **Partial Take Profit Ladder (TP1 / TP2)**: Configurable ATR or percentage targets
   - **Automatic Break-Even**: Moves SL to `Entry + fee_buffer` once unrealized gain reaches `break_even_trigger_r`
   - **ATR Trailing Stop**: Monotonically ratchets SL once `trailing_activation_r` is reached

5. **Granular Toggle for Every Feature (`[features]`)**
   - Independently enable/disable automated trading, manual trading, signal generator, WebSocket primary feed, REST fallback, individual indicators (`EMA`, `RSI`, `ADX`, `VWAP`), exit modules (`ATR Exits`, `TP Ladder`, `Break-Even`, `Trailing Stop`), circuit breaker, Spot/Futures venues, and Git auto-backup.

6. **Institutional Risk Management & Strict Paper vs Live Isolation**
   - Cumulative max daily drawdown, per-pair daily drawdown quarantine, max daily profit lock, win/lose streak cooldowns, and global Circuit Breaker.
   - Isolated Paper Sandbox (`paper_trading = true`) vs Armed Live Execution (`armed_for_live_orders = true` + server-side secrets only).

7. **Git Sync Ready for Backup**
   - Built-in `bot-engine::git_sync` module and `deploy/git-backup.sh` snapshot sanitized TOML/JSON configs and execution metrics to Git while strictly ignoring `.env`, `*.pem`, and `config/bot.toml`.

---

## Quick Start on Linux Desktop

### 1. Prerequisites
- Rust `1.86+` (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
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

### 4. Install as Linux `systemd` Service & Backup via Git
```bash
sudo cp deploy/rust-quant-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rust-quant-bot
./deploy/git-backup.sh
```
