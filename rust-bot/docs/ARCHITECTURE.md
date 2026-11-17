# System Architecture

## 1. Crate Dependency Graph

```text
                    +-------------------+
                    |    bot-desktop    |  Linux Desktop CLI / systemd Daemon
                    +---------+---------+
                              |
              +---------------+---------------+
              |                               |
    +---------v---------+           +---------v---------+
    |      bot-web      |           |     bot-engine    |  Tokio Orchestrator
    |  (Axum REST + WS) |<--------->|  (Event Loop +    |  (+ git_sync Backup)
    +-------------------+           |   Paper/Live Sim) |
                                    +---------+---------+
                                              |
                 +--------------------+-------+-------+--------------------+
                 |                    |               |                    |
       +---------v---------+ +--------v--------+ +----v------------+ +-----v-----------+
       |   bot-exchange    | | bot-indicators  | |  bot-strategy   | |    bot-risk     |
       |  (binance-sdk     | | (EMA, RSI, ADX, | | (Trend Scalp &  | | (Drawdown, CB,  |
       |   Spot + Futures) | |  ATR, VWAP)     | |  ATR Exit Plan) | |  Streak Guards) |
       +---------+---------+ +--------+--------+ +----+------------+ +-----+-----------+
                 |                    |               |                    |
                 +--------------------+---------------+--------------------+
                                              |
                                    +---------v---------+
                                    |     bot-core      |  Shared Models, FeatureToggles, Config
                                    +-------------------+
```

## 2. Binance Spot & USD-M Futures Routing (`binance-sdk`)

Official reference: [Binance Connectors — Rust](https://developers.binance.com/en/docs/sdks-tools/connectors/rust) (`binance-sdk` `78.1.0` with `spot` and `derivatives_trading_usds_futures` features).

| Venue | Environment | REST Base URL | WebSocket Stream URL |
| :--- | :--- | :--- | :--- |
| **Spot** | Testnet | `https://testnet.binance.vision` | `wss://stream.testnet.binance.vision/stream` |
| **Spot** | Production | `https://api.binance.com` | `wss://stream.binance.com:9443/stream` |
| **Futures** | Testnet | `https://testnet.binancefuture.com` | `wss://stream.binancefuture.com/stream` |
| **Futures** | Production | `https://fapi.binance.com` | `wss://fstream.binance.com/stream` |

### Supported Order Types
- **MARKET**: Immediate execution (`BUY` via `quoteOrderQty` on Spot or rounded `quantity` on Futures).
- **LIMIT**: Passive resting entry with `GTC`, `IOC`, or `FOK`.
- **POST-ONLY MAKER**: `LIMIT_MAKER` on Spot; `LIMIT` + `timeInForce = GTX` on USD-M Futures.
- **OCO / Bracket**:
  - **Spot**: `/api/v3/orderList/oco` (`aboveType = LIMIT_MAKER`, `belowType = STOP_LOSS_LIMIT`) or entry + protective bracket.
  - **Futures**: Entry market/limit order paired with `TAKE_PROFIT_MARKET` and `STOP_MARKET` protective triggers.

## 3. WebSocket Primary + REST Fallback State Machine

1. **Cold Start Warmup**: `BinanceRestClient` / `BinanceFuturesClient` issues parallel kline requests (`/api/v3/klines` or `/fapi/v1/klines`) to warm up the 200+ candle ring buffer.
2. **Primary Real-Time Stream (`WsPrimary`)**: Connects to Binance combined WebSocket Stream when `features.ws_primary_feed = true`.
3. **Heartbeat Watchdog & Automatic Degradation (`RestFallback`)**: When `Instant::now() - last_ws_message_at > ws_heartbeat_timeout_ms` (and `features.rest_fallback = true`), `FailoverGateway` degrades transparently to REST polling and re-attempts WebSocket reconnection with exponential backoff.
4. **Auto-Promotion**: Once WebSocket frames stabilize, `TransportMode` returns to `WsPrimary`.

## 4. Granular Feature Gating (`FeatureToggles`)

Every subsystem checks `BotConfig.features` before executing:
- `signal_generator` and individual indicator switches (`ema_trend_filter`, `rsi_momentum_filter`, `adx_strength_filter`, `vwap_bias_filter`) shape `evaluate_entry_signal_with_options`.
- Exit switches (`atr_dynamic_exits`, `take_profit_ladder`, `break_even_stop`, `trailing_stop`) govern `manage_position_tick`.
- Execution switches (`automated_trading`, `manual_trading`, `spot_market`, `futures_market`, `circuit_breaker`) gate both `bot-engine` and the React/Express dashboard.

## 5. Sanitized Git Sync & Backup

- `bot_engine::git_sync` and `deploy/git-backup.sh` enforce `.gitignore` exclusions for `.env`, `*.pem`, `*.key`, and `config/bot.toml`.
- Only sanitized snapshots (`backups/bot-config-backup.json` and `rust-bot/config/bot.synced.toml`) are staged, committed, and optionally pushed to `origin`.

