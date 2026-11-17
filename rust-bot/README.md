# ApexRust Quant — Multi-Pair Binance Trading Bot (Linux Desktop & WebApp Ready)

A modular, production-structured **Rust** cryptocurrency trading bot built on top of the **official Binance Rust SDK (`binance-sdk`)** (`https://developers.binance.com/en/docs/sdks-tools/connectors/rust`).

## Key Capabilities

1. **WebSocket-First Architecture with Automatic REST Fallback**
   - Primary real-time market data (`@kline_<tf>`, `@bookTicker`) and order execution via **Binance WebSocket Streams / SpotWsApi**.
   - Automatic stale-stream watchdog (`heartbeat_timeout_ms`) that transparently degrades to **`SpotRestApi`** polling and order placement without dropping position management.
   - Exponential backoff reconnection automatically promotes the engine back to `WsPrimary` once stream health stabilizes.

2. **Multi-Pair Trend-Following Scalping & Intraday Engine**
   - Concurrent per-symbol state machines (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `AVAXUSDT`, configurable).
   - **Technical Indicator Pipeline**:
     - Triple EMA (`EMA 9`, `EMA 21`, `EMA 50`, plus `EMA 200` macro bias filter)
     - **ADX (14)** with `+DI / -DI` directional confirmation (`ADX >= 25.0` prevents sideways chop)
     - **Wilder RSI (14)** pullback-and-curl timing around the trend zone
     - **ATR (14)** volatility measurement for adaptive stops and targets
     - **Session VWAP** institutional bias confirmation

3. **ATR-Based Exit Lifecycle (SL, TP, Break-Even, Trailing Stop)**
   - **Initial Stop Loss**: `Entry ± (atr_sl_mult × ATR)`
   - **Partial Take Profit (TP1)** & **Runner Target (TP2)**: `1.5R` / `2.5R` or ATR multiples
   - **Automatic Break-Even**: Moves Stop Loss to `Entry + fee_buffer` once unrealized gain reaches `break_even_trigger_r` (e.g., `1.0R`)
   - **ATR Trailing Stop**: Ratchets monotonically in trade direction at `Price ∓ (atr_trail_mult × ATR)` once `trailing_activation_r` is reached

4. **Institutional Risk Management & Circuit Breakers**
   - **Cumulative Max Daily Drawdown (%)** — halts all new entries & optionally flattens open positions
   - **Per-Pair Max Daily Drawdown (%)** — quarantines underperforming symbols for the remainder of the UTC day
   - **Max Daily Profit Target (%)** — locks in daily gains and stops over-trading
   - **Max Win Streak & Max Lose Streak** — enforces cooldowns or session halts to prevent revenge trading or euphoria sizing
   - **Global Circuit Breaker** — triggered automatically on drawdown breach, consecutive API errors, or manual panic button

5. **Linux Desktop & WebApp Ready**
   - `bot-desktop`: Native Linux binary with CLI/daemon mode, XDG config loading, graceful `SIGINT`/`SIGTERM` shutdown, and `systemd` service unit.
   - `bot-web`: Embedded **Axum** REST + WebSocket telemetry server (`:8080`) so any web frontend (including the accompanying React Command Center) can monitor live positions, risk gauges, and issue pause/resume/circuit-breaker commands.

---

## Quick Start on Linux Desktop

### 1. Prerequisites
- Rust `1.86+` (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Binance Spot API Key & Ed25519 / HMAC Secret (Testnet recommended first!)

### 2. Configure Environment & Strategy
```bash
cd rust-bot
cp config/bot.example.toml config/bot.toml

export BINANCE_API_KEY="your_api_key"
export BINANCE_API_SECRET="your_api_secret"
# Optional: for Ed25519 signing with official binance-sdk
# export BINANCE_PRIVATE_KEY_PATH="/home/$USER/.config/apexrust/ed25519.pem"
```

### 3. Build & Run (Testnet + Web Telemetry Bridge)
```bash
cargo test --workspace
cargo run --release -p bot-desktop -- --config config/bot.toml --web-port 8080
```

### 4. Install as Linux `systemd` Service
```bash
sudo cp deploy/rust-quant-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rust-quant-bot
journalctl -u rust-quant-bot -f
```
