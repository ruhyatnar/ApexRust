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
    |  (Axum REST + WS) |<--------->|  (Event Loop +    |
    +-------------------+           |   Paper/Live Sim) |
                                    +---------+---------+
                                              |
                 +--------------------+-------+-------+--------------------+
                 |                    |               |                    |
       +---------v---------+ +--------v--------+ +----v------------+ +-----v-----------+
       |   bot-exchange    | | bot-indicators  | |  bot-strategy   | |    bot-risk     |
       |  (binance-sdk WS  | | (EMA, RSI, ADX, | | (Trend Scalp &  | | (Drawdown, CB,  |
       |   + REST fallback)| |  ATR, VWAP)     | |  ATR Exit Plan) | |  Streak Guards) |
       +---------+---------+ +--------+--------+ +----+------------+ +-----+-----------+
                 |                    |               |                    |
                 +--------------------+---------------+--------------------+
                                              |
                                    +---------v---------+
                                    |     bot-core      |  Shared Models, Config, Errors
                                    +-------------------+
```

## 2. WebSocket Primary + REST Fallback State Machine

Official reference: [Binance Connectors — Rust](https://developers.binance.com/en/docs/sdks-tools/connectors/rust) (`binance-sdk`).

1. **Cold Start Warmup (`SpotRestApi`)**
   - On startup, `BinanceExchangeGateway` issues parallel `GET /api/v3/klines` requests (via `SpotRestApi`) for every configured pair to populate the 200+ candle ring buffer required for `EMA 200`, `ATR(14)`, and `ADX(14)`.
2. **Primary Real-Time Stream (`WsPrimary`)**
   - Connects to Binance combined WebSocket Stream (`/stream?streams=btcusdt@kline_5m/btcusdt@bookTicker/...`) and initializes `SpotWsApi` for low-latency authenticated order placement (`order.place`, `order.cancel`).
   - Updates `last_ws_message_at` on every tick, kline, or ping/pong frame.
3. **Heartbeat Watchdog & Automatic Degradation (`RestFallback`)**
   - A Tokio interval checks `Instant::now() - last_ws_message_at`.
   - If elapsed time exceeds `ws_heartbeat_timeout_ms` (default `4500ms`) or the socket closes/errors:
     - Gateway atomically transitions `TransportMode::WsPrimary -> TransportMode::RestFallback`.
     - Market data switches seamlessly to `SpotRestApi` polling (`rest_poll_interval_ms`) and order execution routes through `SpotRestApi::new_order` / `cancel_order`.
     - A background reconnect task runs exponential backoff (`1s -> 2s -> 4s ... max 30s`).
4. **Auto-Promotion**
   - Once WebSocket receives 3 consecutive healthy frames/heartbeats, `TransportMode` transitions back to `WsPrimary` and REST polling suspends.

## 3. Concurrency & Data Ownership

- **Single Writer, Broadcast Readers**: `bot-engine` owns mutable `Position` and `RiskManager` state inside a dedicated Tokio task (no lock contention on hot paths).
- **Telemetry Fan-Out**: Every tick, candle close, signal evaluation, or risk event publishes an immutable `EngineSnapshot` over `tokio::sync::broadcast::Sender` to `bot-web` (WebSocket clients) and `bot-desktop` (terminal logs / desktop HUD).
- **Graceful Shutdown**: On `SIGINT` / `SIGTERM`, `bot-engine` persists daily risk state, optionally cancels resting orders, and cleanly closes WebSocket streams.
