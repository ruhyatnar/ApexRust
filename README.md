# ApexRust Quant

Platform trading kuantitatif Binance dengan dua runtime yang dijaga **parity** satu sama lain:

1. **WebApp / Desktop PWA** — React 19 + TypeScript + Tailwind v4, mesin simulasi `SimulationRuntime`, dan proxy Express (`server.ts`) untuk signing order, ledger SQLite, backup Git, serta relay WebSocket.
2. **Rust Workspace** (`rust-bot/`) — 9 crate Tokio di atas `binance-sdk 78.3.0` untuk Spot & USD-M Futures, dapat dijalankan sebagai daemon 24/7 di VPS atau CLI desktop.

Setiap field konfigurasi, toggle fitur, aturan risiko, dan jalur eksekusi diimplementasikan di kedua runtime dengan unit test masing-masing (lihat `AGENTS.md`).

> **Peringatan:** perangkat lunak ini dapat mengirim order nyata. Gunakan Testnet, `paper_trading = true`, dan `armed_for_live_orders = false` sampai strategi tervalidasi. Tidak ada jaminan profit; kerugian sepenuhnya tanggung jawab pengguna.

---

## Daftar Isi

1. [Fitur Utama](#fitur-utama)
2. [Instalasi Cepat](#instalasi-cepat)
3. [Menjalankan](#menjalankan)
4. [Struktur Proyek](#struktur-proyek)
5. [Kredensial, Ed25519 & WebSocket API](#kredensial-ed25519--websocket-api)
6. [Konfigurasi (`bot.toml`)](#konfigurasi-bottoml)
7. [Gate Entry & Screener](#gate-entry--screener)
8. [Manajemen Risiko & Exit](#manajemen-risiko--exit)
9. [Arsitektur Runtime](#arsitektur-runtime)
10. [Environment Variables](#environment-variables)
11. [Verifikasi & Pengujian](#verifikasi--pengujian)
12. [Dokumentasi Lain](#dokumentasi-lain)

---

## Fitur Utama

**Screening & pemilihan pair**

- `static`, `hybrid`, dan `dynamic` watchlist dengan hysteresis ranking + dwell time untuk mencegah churn.
- Kategori trending: `hot_volume`, `top_gainers`, `top_losers`, `volatility_leaders`, dan `cts_momentum`.
- **CTS score** = RVOL 1 jam + momentum 1 jam + volume, masing-masing dinormalisasi ke `[0,1]` agar pair bervolume besar tidak otomatis menang. Metrik dihitung dari kandil 1 jam dan di-refresh tiap 5 menit di kedua runtime, dengan konkurensi fetch dibatasi.
- Filter minat: quote volume minimum, RVOL minimum (`cts_min_rvol`), spread maksimum.

**Gate entry (semua opsional dan dapat dimatikan)**

| Gate | Field | Default |
| :--- | :--- | :--- |
| Tren EMA (fast/mid/slow/macro) | `ema_trend_filter` + `require_macro_ema_in_scalping` | aktif |
| Momentum RSI pullback | `rsi_momentum_filter` | aktif |
| Kekuatan ADX / DI spread / rising ADX | `adx_strength_filter` | aktif |
| Bias VWAP | `vwap_bias_filter` | aktif |
| Konfirmasi volume | `volume_confirmation_filter` | nonaktif |
| **Tren HTF (EMA 1 jam)** | `htf_trend_filter`, `htf_ema_period` | nonaktif |
| **Order Book Imbalance** | `obi_entry_filter`, `obi_levels`, `obi_min_imbalance` | nonaktif |
| **Ekspansi ATR** | `atr_expansion_filter_enabled`, `atr_expansion_min_ratio` | nonaktif |
| Donchian breakout | `donchian_lookback` (default **20**) | dipakai profil `ema_breakout` |
| Sesi UTC | `session_window_filter` + `[[automation.session_windows]]` | nonaktif |

**Eksekusi**

- Order MARKET / LIMIT / LIMIT_MAKER, TP/SL bracket, dan OCO Spot sesuai aturan Binance.
- USD-M Futures memakai `newOrderRespType=RESULT`; TP/SL kondisional dirutekan ke `POST /fapi/v1/algoOrder` dan direkonsiliasi lewat `GET /fapi/v1/openAlgoOrders`.
- Exit `reduceOnly` melewati `marginType`/`leverage` agar error `-4048` tidak memblokir proteksi.
- Rekonsiliasi order menggantung memverifikasi status exchange sebelum menghapus order lokal, dan mempromosikan `FILLED` menjadi posisi.
- Failover WS → REST dengan watchdog heartbeat, backoff reconnect, dan batas kegagalan REST.
- **WebSocket API** (`session.logon`) untuk entry tanpa bracket, dengan fallback REST otomatis.

**Manajemen posisi**

- Exit plan ATR: SL, TP1 (partial), TP2, break-even, trailing stop monoton.
- Break-even dan trailing dievaluasi **sebelum** partial close TP1 sehingga runner tetap terlindungi.
- Dynamic cancel pending order (runaway ATR, exhaustion, reversal), opsi flip posisi.
- Exit berjalan 24/7; filter sesi hanya membatasi entry otomatis baru.

**Risiko**

- Circuit breaker harian: drawdown harian/pair, target profit harian, win/lose streak + cooldown, karantina pair.
- **BTC crash guard**: memblokir entry baru saat BTC turun melewati ambang dalam jendela waktu tertentu. Feed basi (> `btc_crash_max_staleness_sec`) = fail-open; exit tidak pernah diblokir.
- **Cap leverage**: `max_leverage` (default **3**) di-clamp pada config, TOML tersinkron, dan setiap jalur order.
- Position sizing: fixed USDT, fixed risk %, dan Kelly (quarter/half/full) dengan blok expectancy negatif.
- Volatility spike alert (ATR) + notifikasi Web Notification API.

---

## Instalasi Cepat

Prasyarat: Node.js `^20.19.0 || >=22.12.0`, Rust `>= 1.85.0`, header build C/OpenSSL.

```bash
git clone <repo-url> ApexRust
cd ApexRust

./install.sh          # Linux / macOS
.\install.ps1         # Windows PowerShell (atau install.cmd)
```

Installer memeriksa/memasang toolchain user-local, membangun WebApp dan/atau daemon Rust, menulis `.env` serta `rust-bot/config/bot.toml` dengan `paper_trading = true`, dan opsional mendaftarkan service auto-start.

Setup non-interaktif:

```bash
./install.sh --yes --non-interactive --components both \
  --env testnet --venue spot --pair-mode hybrid \
  --trending-category hot_volume --no-service
```

### Instalasi manual

```bash
npm install
cp .env.example .env
cp rust-bot/config/bot.example.toml rust-bot/config/bot.toml
npm run build
cd rust-bot && cargo build --release --workspace
```

---

## Menjalankan

```bash
./apexrust start | stop | restart | status | logs -f | doctor | update
./apexrust token [status|show|generate|rotate|clear]
./apexrust remote [status|connect|use-local|use-vps]
./apexrust service install     # systemd --user, launchd, atau Scheduled Tasks
./apexrust uninstall [--purge]
```

Pengembangan WebApp (Vite middleware + Express pada port `3000`):

```bash
npm run dev        # tsx server.ts
npm run lint
npm run build
```

Daemon Rust:

```bash
cd rust-bot
cargo run --release -p bot-desktop -- --config config/bot.toml
cargo run --release -p bot-desktop -- --config config/bot.toml --web-port 8080
```

Subcommand `bot-desktop` mencakup `connect` (profil VPS remote), `snapshot`, `watch`, `orders`, `trending`, `manual-order`, `trip-cb`/`reset-cb`, `flatten-all`, dan utilitas operasional lain; jalankan `cargo run -p bot-desktop -- --help`.

---

## Struktur Proyek

```text
.
├── src/                     # React PWA: engine TS, komponen UI, adapter
│   ├── engine/              # SimulationRuntime, indikator, strategi, risiko, storage
│   ├── server/              # Screener hub, order ledger, relay WS
│   └── components/          # Command Center
├── server.ts                # Express: signing, /api/live/*, /api/market/*, /api/git/*
├── rust-bot/
│   ├── crates/
│   │   ├── bot-core/        # BotConfig, 21 FeatureToggles, tipe domain, watchlist/CTS
│   │   ├── bot-indicators/  # EMA, RSI, ADX, ATR, VWAP, Donchian, SMA50(ATR), OBI
│   │   ├── bot-strategy/    # 3 profil + gate entry + exit plan
│   │   ├── bot-risk/        # Circuit breaker, sizing, BTC guard
│   │   ├── bot-exchange/    # binance-sdk, WS market, WS API, failover, depth
│   │   ├── bot-engine/      # Orkestrasi Tokio, HTF/CTS refresh, paper/live
│   │   ├── bot-web/         # Axum REST + WS telemetry
│   │   ├── bot-desktop/     # CLI & daemon 24/7
│   │   └── bot-keygen/      # Generator kunci Ed25519
│   ├── config/bot.example.toml
│   └── docs/ARCHITECTURE.md
├── arsitektur-trading-bot-rust.md   # Spesifikasi + status implementasi (§9)
└── AGENTS.md                        # Aturan parity & verifikasi
```

---

## Kredensial, Ed25519 & WebSocket API

### Penyimpanan kredensial

- Kunci yang disimpan dari UI ditulis ke `.apexrust/secrets.env` (mode `0600`, gitignored) bila `APEXRUST_PERSIST_VAULT=true`; selain itu hanya di memori proses.
- Variabel environment proses selalu menang atas file.
- Jangan pernah commit `.env*`, `*.pem`, `*.key`, `rust-bot/config/bot.toml`, `rust-bot/keys/`, atau `.apexrust-order-logs.json`.

### Generate kunci Ed25519

Dua jalur, keduanya menulis private key PKCS#8 (mode `0600`) dan public key:

```bash
# Rust (butuh cargo)
cd rust-bot
cargo run -p bot-keygen -- --environment testnet --out-dir keys --label main
# -> keys/ed25519-testnet-main.pem, keys/ed25519-testnet-main.pub.pem
```

```bash
# WebApp proxy (menulis ke .apexrust/keys/, mode 0700)
curl -X POST http://127.0.0.1:3000/api/live/ed25519-keygen \
  -H 'Content-Type: application/json' \
  -d '{"environment":"Testnet","label":"main","overwrite":false}'
```

Respons berisi `privateKeyPath`, `publicKeyPath`, `publicKeyPem`, `publicKeyBase64`, dan `fingerprint`. Daftarkan **public key** di Binance API Management, lalu set:

```toml
[exchange]
use_ws_api_orders = true

[exchange.credentials]
auth_method = "ed25519"
ed25519_key_path = "keys/ed25519-testnet-main.pem"
```

`.gitignore` sudah mengecualikan `rust-bot/keys/`; `.apexrust/` juga gitignored.

### Cara kerja WS API

- `session.logon` hanya berlaku untuk kunci **Ed25519**. Kunci HMAC tidak memakai sesi; setiap request ditandatangani (`sign_request_params`, query string terurut).
- Hanya **entry tanpa bracket** yang dirutekan ke `order.place` melalui WS. Entry ber-bracket dan semua order protektif/exit tetap REST agar SL/TP tidak pernah hilang bila sesi WS terputus.
- Kegagalan WS apa pun (logon, timeout, error ack) otomatis jatuh ke REST.
- URL default: Futures testnet `wss://testnet.binancefuture.com/ws-fapi/v1`, Spot testnet `wss://ws-api.testnet.binance.vision/ws-api/v3`; ubah lewat `exchange.ws_api_url`.
- Gunakan `use_ws_api_orders = false` untuk memaksa seluruh jalur lewat REST.

---

## Konfigurasi (`bot.toml`)

Sumber contoh lengkap: `rust-bot/config/bot.example.toml`. WebApp menyimpan konfigurasi setara di `localStorage` dan menulis TOML tersanitasi ke `rust-bot/config/bot.synced.toml` lewat `POST /api/git/backup` (payload `config`).

### Field baru / penting

| Section | Field | Arti |
| :--- | :--- | :--- |
| `[exchange]` | `max_leverage` | Batas keras leverage (1..=20), default 3. `leverage` di-clamp ke nilai ini. |
| `[exchange]` | `use_ws_api_orders` | Aktifkan jalur WebSocket API untuk entry tanpa bracket. |
| `[exchange]` | `ws_api_url` | Endpoint WS API (testnet/production). |
| `[exchange.credentials]` | `ed25519_key_path` | Path PKCS#8 PEM untuk `session.logon`. |
| `[trading]` | `trending_category` | Termasuk `cts_momentum`. |
| `[trading]` | `cts_screener_enabled`, `cts_rvol_weight`, `cts_momentum_weight`, `cts_volume_weight`, `cts_min_rvol` | Bobot & ambang CTS (total bobot dinormalisasi saat runtime). |
| `[indicators]` | `donchian_lookback` | Window breakout Donchian, default 20. |
| `[indicators]` | `atr_expansion_filter_enabled`, `atr_expansion_min_ratio` | Gate ekspansi volatilitas (ATR vs SMA50 ATR), default nonaktif. |
| `[indicators]` | `htf_ema_period`, `obi_levels`, `obi_min_imbalance` | Parameter gate HTF dan OBI. |
| `[features]` | `htf_trend_filter`, `obi_entry_filter` | Dua toggle baru (total **21**). Default `false`. |
| `[risk]` | `btc_crash_guard_enabled`, `btc_crash_threshold_pct`, `btc_crash_window_minutes`, `btc_crash_max_staleness_sec` | Guard korelasi BTC; hanya memblokir entry. |
| `[risk]` | `flatten_on_circuit_breaker` | Tutup semua posisi saat breaker aktif. |

Semua field divalidasi di Rust (`BotConfig::validate`) dan di-clamp ulang saat load/save di TypeScript, sehingga nilai manual yang tidak masuk akal tidak lolos ke jalur order.

---

## Gate Entry & Screener

Alur keputusan satu bar tertutup:

1. **Warmup & kualitas data** — minimal `min_warmup_bars`, tanpa gap kandil, spread ≤ `max_spread_bps`.
2. **Regime** — tren EMA + macro, ADX/DI, RSI pullback, VWAP, volume; opsional HTF 1 jam, OBI, dan ekspansi ATR.
3. **Struktur** — Donchian breakout (`ema_breakout`) atau pullback ke EMA mid (`trend_pullback`) / reversion VWAP (`vwap_reversion`).
4. **Sesi** — `session_window_filter` hanya untuk entry otomatis.
5. **Risiko** — circuit breaker, BTC guard, streak/quarantine, sizing, notional cap, preflight test order.
6. **Eksekusi** — WS API (bila aktif dan tanpa bracket) atau REST dengan bracket.

Diagnostik setiap gate tersedia di `evaluateSignalDiagnostics` (TS) dan padanannya di Rust, sehingga UI dapat menampilkan alasan penolakan sinyal.

---

## Manajemen Risiko & Exit

- **Exit plan**: SL `atr_sl_multiplier`, TP1 `atr_tp1_multiplier` (partial `tp1_close_ratio`), TP2 `atr_tp2_multiplier`.
- **Break-even** pada `break_even_trigger_r` plus buffer fee; **trailing** aktif pada `trailing_activation_r` dengan `atr_trailing_multiplier`, hanya bergerak searah profit.
- **Urutan evaluasi**: break-even → trailing → partial TP1 → full exit, sehingga posisi yang langsung menyentuh TP1 tetap memiliki proteksi runner.
- **Circuit breaker**: drawdown harian & per pair, target profit, streak, karantina pair; `reset` membersihkan `quarantined_pairs` di kedua runtime.
- **BTC guard**: sampel harga BTC disimpan dalam jendela; anchor adalah sampel tertua yang masih dalam jendela. Data lebih tua dari `btc_crash_max_staleness_sec` dianggap tidak ada (fail-open).

---

## Arsitektur Runtime

```text
                    +-----------------------------+
                    |  Web Command Center (PWA)   |
                    |  Paper / Live Simulation    |
                    +--------------+--------------+
                                   | /api/live/*, /api/market/*, /api/git/*
                    +--------------v--------------+
                    |  Express Proxy (server.ts)  |  signing, ledger, Git backup, WS relay
                    +--------------+--------------+
                                   | HTTP / WS (opsional, VPS)
                    +--------------v--------------+
                    |  bot-web (Axum)  <->  bot-engine (Tokio)
                    +--------------+--------------+
              +--------------------+--------------------+
              |                    |                    |
      bot-exchange          bot-indicators        bot-strategy
      (Spot/Futures,        (EMA/RSI/ADX/ATR/    (profil + gate +
       WS market, WS API,    VWAP/Donchian/OBI)   exit plan)
       failover, depth)             |
              +---------------------+--------------------+
                                    |
                              bot-risk (CB, sizing, BTC guard)
                                    |
                              bot-core (config, tipe, watchlist/CTS)
```

- **Paper mode** berjalan penuh di memori tanpa kredensial; **Live mode** memerlukan kredensial + `armed_for_live_orders = true` + preflight.
- **Single-writer authority**: `APEXRUST_ENGINE_AUTHORITY=browser` (default) atau `daemon`; hanya satu yang boleh mengirim order.
- **Remote VPS**: WebApp dapat bertindak sebagai gateway ke daemon Rust (`APEXRUST_ENGINE_URL`), termasuk di belakang Cloudflare One / Zero Trust (`APEXRUST_TRUST_ZERO_TRUST_MESH`, `APEXRUST_PROXY_TOKEN`).
- **Rate limiting & token**: token ≥32 karakter wajib saat bind `0.0.0.0`; klien WS mengambil tiket sekali pakai dari `POST /api/ws-ticket`.

---

## Environment Variables

Lihat `.env.example` untuk daftar lengkap. Yang paling sering dipakai:

| Variabel | Default | Fungsi |
| :--- | :--- | :--- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Bind Express. |
| `BINANCE_ENVIRONMENT` | `Testnet` | `Testnet` atau `Production`. |
| `BINANCE_VENUE` | `Spot` | `Spot` atau `Futures`. |
| `BINANCE_AUTH_METHOD` | `HMAC-SHA256` | `HMAC-SHA256` atau `Ed25519`. |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | — | Kredensial HMAC. |
| `BINANCE_PRIVATE_KEY_PATH` | — | Path/inline PEM Ed25519. |
| `APEXRUST_MAX_ORDER_NOTIONAL_USDT` | `250` | Cap notional per order. |
| `APEXRUST_REQUIRE_PREFLIGHT` | `true` | Wajib test order sebelum live. |
| `APEXRUST_ORDER_DB_PATH` | `.apexrust-orders.sqlite` | Ledger SQLite. |
| `APEXRUST_ENGINE_AUTHORITY` | `browser` | `browser` atau `daemon`. |
| `APEXRUST_ENGINE_URL` | — | Upstream daemon Rust. |
| `APEXRUST_PROXY_TOKEN` | — | Token akses proxy (wajib di `0.0.0.0`). |
| `APEXRUST_PERSIST_VAULT` | `false` | Simpan kunci UI ke `.apexrust/secrets.env`. |
| `APEXRUST_TRUST_PROXY` | — | `loopback`/`true` di belakang reverse proxy. |

---

## Verifikasi & Pengujian

Wajib dijalankan sebelum menyelesaikan perubahan (lihat `AGENTS.md`):

```bash
# Rust
cd rust-bot
cargo test --workspace
cargo clippy --workspace

# WebApp / TypeScript
npm run lint
npm run build
npx --yes tsx --test src/engine/*.test.ts
```

Cakupan test engine TS mencakup parity config storage, gate strategi, exit lifecycle, BTC guard, cap leverage, CTS ranking, ledger SQLite, dan adapter snapshot. Sisi Rust mencakup `bot-core` (config/watchlist), `bot-risk` (breaker + BTC guard), `bot-strategy`, `bot-indicators`, `bot-exchange` (WS market/WS API/depth/failover), serta smoke test `bot-engine`/`bot-web`.

---

## Dokumentasi Lain

- `AGENTS.md` — aturan parity WebApp ↔ Rust dan perintah verifikasi.
- `rust-bot/docs/ARCHITECTURE.md` — graf dependency crate dan alur runtime.
- `arsitektur-trading-bot-rust.md` — spesifikasi lengkap; **§9 berisi tabel status Implemented/Partial/Not planned** dan catatan penyimpangan yang disengaja.
