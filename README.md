# ApexRust Quant

Platform trading kuantitatif **Binance (Spot & USD-M Futures)** yang menggabungkan **Web Command Center (PWA)** dan **Rust Engine 24/7** dengan **parity penuh** di kedua sisi: setiap konfigurasi, 21 feature toggle, aturan manajemen risiko, indikator, dan jalur eksekusi identik antara TypeScript dan Rust.

> **Peringatan Risiko:** Perangkat lunak ini dapat mengirim order nyata ke bursa. Selalu mulai dengan `environment = "testnet"`, `paper_trading = true`, dan `armed_for_live_orders = false` hingga strategi dan konfigurasi Anda tervalidasi. Tidak ada jaminan profit; seluruh risiko finansial menjadi tanggung jawab pengguna.

---

## Daftar Isi

1. [Gambaran Umum & Cara Kerja](#gambaran-umum--cara-kerja)
2. [Instalasi Cepat](#instalasi-cepat)
3. [Menjalankan & Mengelola Layanan](#menjalankan--mengelola-layanan)
4. [Mengenal Web Command Center](#mengenal-web-command-center)
5. [Kredensial Binance, Ed25519 & WebSocket API](#kredensial-binance-ed25519--websocket-api)
6. [Strategi, Screener & 21 Feature Toggles](#strategi-screener--21-feature-toggles)
7. [Manajemen Risiko & Exit Lifecycle](#manajemen-risiko--exit-lifecycle)
8. [Konfigurasi (`bot.toml` & `.env`)](#konfigurasi-bottoml--env)
9. [Mode VPS 24/7 & Remote Access](#mode-vps-247--remote-access)
10. [Arsitektur & Struktur Proyek](#arsitektur--struktur-proyek)
11. [Verifikasi & Pengujian](#verifikasi--pengujian)
12. [Troubleshooting (Mengatasi Masalah)](#troubleshooting-mengatasi-masalah)
13. [Dokumentasi Tambahan](#dokumentasi-tambahan)

---

## Gambaran Umum & Cara Kerja

ApexRust Quant memiliki dua runtime yang saling melengkapi:

| Komponen | Teknologi | Kegunaan Utama |
| :--- | :--- | :--- |
| **Web Command Center + Proxy** | React 19, TypeScript, Tailwind v4, Express (`server.ts`, port `3000`) | Dashboard visual, grafik candlestick, simulasi Paper/Live di browser, signing API server-side, ledger SQLite, backup Git, serta gateway ke VPS. |
| **Rust Engine (`rust-bot/`)** | 10 crate Rust + Tokio + Axum (`bot-web` port `8080`) di atas `binance-sdk 78.3.0` | Mesin trading native berkinerja tinggi untuk berjalan 24/7 di VPS/desktop (`bot-desktop`), lengkap dengan CLI terpadu (`apexrust`). |

### Tiga Skenario Pemakaian
1. **Lokal (Komputer Sendiri):** Jalankan WebApp + Rust daemon di komputer yang sama untuk riset, paper trading, atau eksekusi lokal.
2. **VPS 24/7 + Client Desktop/HP:** Jalankan Rust daemon + Express gateway di VPS (`APEXRUST_ENGINE_AUTHORITY=daemon`), lalu akses dashboard PWA dari laptop/HP (termasuk lewat Cloudflare One / Zero Trust).
3. **Browser-Only Paper Sandbox:** Jalankan WebApp saja tanpa kredensial Binance untuk menguji strategi secara virtual di memori/browser.

---

## Instalasi Cepat

### Prasyarat
- **Node.js:** `^20.19.0` atau `>= 22.12.0`
- **Rust:** `>= 1.85.0` (diperlukan jika membangun engine Rust)
- **Build Tools:** Compiler C & header OpenSSL (Linux: `build-essential`, `pkg-config`, `libssl-dev`; macOS: Xcode CLT; Windows: MSVC Build Tools)

### Instalasi Otomatis (Direkomendasikan)

Skrip installer akan memeriksa toolchain, memasang dependensi, membangun aplikasi, membuat `.env` dan `rust-bot/config/bot.toml` (dalam mode aman `paper_trading = true`), serta menawarkan pendaftaran service auto-start:

```bash
git clone <repo-url> ApexRust
cd ApexRust

# Linux / macOS
./install.sh

# Windows (PowerShell atau Command Prompt)
.\install.ps1
# atau: install.cmd
```

**Mode non-interaktif (misal untuk VPS / CI):**

```bash
./install.sh --yes --non-interactive --components both \
  --env testnet --venue spot --pair-mode hybrid \
  --trending-category hot_volume --no-service
```

### Instalasi Manual

```bash
npm install
cp .env.example .env
cp rust-bot/config/bot.example.toml rust-bot/config/bot.toml

npm run build
cd rust-bot && cargo build --release --workspace
```

---

## Menjalankan & Mengelola Layanan

ApexRust menyediakan wrapper `./apexrust` (atau `apexrust.cmd` di Windows) untuk mengelola daemon, layanan OS, token akses, hingga diagnosis sistem tanpa harus mengingat perintah panjang.

### Perintah Manajemen Utama

```bash
./apexrust start [web|bot|both]     # Jalankan di background
./apexrust stop [web|bot|both]      # Hentikan layanan dengan aman
./apexrust restart [web|bot|both]   # Restart layanan
./apexrust status                   # Cek PID, health endpoint, URL, dan service OS
./apexrust logs [web|bot] -f        # Pantau log secara real-time (-n 100 untuk 100 baris)
./apexrust doctor                   # Cek toolchain, config, binary, port, dan konektivitas
./apexrust update                   # git pull, rebuild, dan restart layanan aktif
./apexrust service install          # Pasang auto-start (systemd --user / launchd / Task Scheduler)
./apexrust uninstall [--purge]      # Hentikan & hapus service (--purge hapus build & config)
```

Setelah berjalan, buka dashboard di browser: **`http://127.0.0.1:3000`**

### Mode Pengembangan (Development)

```bash
# Menjalankan Vite + Express proxy dengan hot-reload pada port 3000
npm run dev

# Menjalankan Rust daemon secara langsung
cd rust-bot
cargo run --release -p bot-desktop -- --config config/bot.toml --web-port 8080
```

### CLI Rust Terpadu (`./apexrust bot ...`)

Untuk operasional harian mesin Rust (key Ed25519, cek sinyal, validasi config, order manual, kontrol risiko), gunakan CLI Rust terpadu:

```bash
# Build binary CLI sekali (jika belum dibuild oleh installer)
(cd rust-bot && cargo build --release --bin apexrust)

# Akses lewat wrapper Node atau langsung dari target/release/apexrust
./apexrust bot --help
```

| Perintah | Fungsi |
| :--- | :--- |
| `apexrust bot status` / `snapshot` / `watch` | Lihat status kesehatan, tabel pair aktif, atau live dashboard terminal. |
| `apexrust bot keygen --label main` | Buat pasangan kunci Ed25519 baru di `rust-bot/keys/`. |
| `apexrust bot key inspect <path.pem>` | Pastikan public key dan private key cocok (mencegah error `-2015`). |
| `apexrust bot ws-api ping` / `ws-api logon` | Uji koneksi dan autentikasi WebSocket API sebelum bot dijalankan. |
| `apexrust bot config validate` / `show` / `sync` | Validasi `bot.toml`, tampilkan ringkasan aman, atau export `bot.synced.toml`. |
| `apexrust bot screen --category cts_momentum` | Jalankan screener pair dari public ticker Binance. |
| `apexrust bot indicators BTCUSDT` / `signal BTCUSDT` | Hitung indikator atau dry-run sinyal tanpa menjalankan daemon. |
| `apexrust bot risk pause\|resume\|trip\|reset` | Jeda entry baru atau trip/reset circuit breaker. |
| `apexrust bot order manual` / `order flatten` | Kirim order manual atau tutup semua posisi (dengan konfirmasi & batas notional). |
| `apexrust bot doctor` | Pemeriksaan cepat config, kredensial, REST ping, dan daemon. |

Semua subcommand Rust mendukung `--json`, `--no-color`, `--config <path>`, `--url <daemon>`, dan `--token <token>`.

---

## Mengenal Web Command Center

Dashboard Web (`http://127.0.0.1:3000`) terbagi menjadi beberapa tab utama:

- **Trade:** Grafik candlestick interaktif, ringkasan saldo/PnL, posisi terbuka, serta panel tiket order manual.
- **Markets:** Pemantauan watchlist (`static` / `hybrid` / `dynamic`), skor **CTS Momentum**, spread, dan indikator live per pair.
- **Orders:** Riwayat order, eksekusi fill, status order menggantung (resting), serta analitik performa.
- **Bot:** Pusat kendali konfigurasi dengan 6 sub-tab:
  - **Strategy:** Profil strategi, timeframe, pair selection, dan sizing.
  - **Features:** Saklar on/off untuk seluruh **21 Feature Toggles**.
  - **Risk:** Circuit breaker, leverage cap, BTC crash guard, dan batas drawdown.
  - **Credentials:** Pengaturan Environment (`Testnet`/`Production`), Venue (`Spot`/`Futures`), metode auth (`HMAC`/`Ed25519`), dan tombol arming live order.
  - **Git:** Backup konfigurasi tersanitasi (`bot-config-backup.json` & `bot.synced.toml`) tanpa membocorkan API key.
  - **VPS:** Penghubung ke daemon Rust lokal atau VPS remote.
- **Signal:** Diagnostik alasan sinyal diterima atau ditolak oleh tiap gate entry.
- **Rust:** Penjelajah kode sumber workspace Rust bawaan dari UI.

---

## Kredensial Binance, Ed25519 & WebSocket API

### Prinsip Penyimpanan Rahasia
- File `.env`, `.apexrust/secrets.env`, `*.pem`, `*.key`, `rust-bot/config/bot.toml`, `rust-bot/keys/`, dan `.apexrust-order-logs.json` sudah di-**gitignore**. **Jangan pernah commit file-file ini.**
- Kredensial yang disimpan dari UI ditulis ke `.apexrust/secrets.env` (izin `0600`) **hanya jika** `APEXRUST_PERSIST_VAULT=true`; jika `false` (default), kredensial hanya disimpan di memori selama proses berjalan.
- Environment variable sistem (`export BINANCE_API_KEY=...`) selalu memiliki prioritas tertinggi di atas file.

### Opsi 1: HMAC-SHA256 (Standar)
Cocok untuk pemakaian umum melalui REST API. Isi `BINANCE_API_KEY` dan `BINANCE_API_SECRET` di `.env` atau tab **Bot → Credentials**.

### Opsi 2: Ed25519 + WebSocket API (Direkomendasikan untuk Latensi Rendah)
Diperlukan jika ingin mengaktifkan `use_ws_api_orders = true` (`session.logon` untuk entry order via WebSocket).

1. **Generate Keypair:**
   ```bash
   ./apexrust bot keygen --environment testnet --label main
   # Menghasilkan:
   # - rust-bot/keys/ed25519-testnet-main.pem      (Private key - JANGAN dibagikan)
   # - rust-bot/keys/ed25519-testnet-main.pub.pem  (Public key - daftarkan ke Binance)
   ```
   *(Atau via WebApp proxy: `POST /api/live/ed25519-keygen`)*
2. **Daftarkan Public Key** di dashboard **Binance API Management** (atau Binance Testnet), aktifkan izin Spot/Futures sesuai kebutuhan, lalu simpan API Key yang diberikan Binance.
3. **Konfigurasi di `bot.toml` dan `.env`:**
   ```toml
   [exchange]
   use_ws_api_orders = true

   [exchange.credentials]
   auth_method = "ed25519"
   ed25519_key_path = "rust-bot/keys/ed25519-testnet-main.pem"
   ```
4. **Uji sebelum menyalakan bot:**
   ```bash
   ./apexrust bot key inspect rust-bot/keys/ed25519-testnet-main.pem
   ./apexrust bot ws-api logon
   ```

> **Catatan Jalur Order WS API:** Hanya **entry tanpa bracket** yang dikirim melalui WebSocket API. Entry yang membawa bracket TP/SL serta seluruh order protektif/exit selalu dikirim melalui REST API agar proteksi tidak pernah hilang jika koneksi WS terputus. Jika WS API gagal atau timeout, sistem otomatis fallback ke REST.

### Checklist Sebelum Mengaktifkan Live Trading
1. Pastikan `environment` (`testnet` vs `production`) sesuai dengan asal API Key Anda (key Testnet tidak berlaku di Production, dan sebaliknya).
2. Pastikan `paper_trading = false` dan `armed_for_live_orders = true`.
3. Pertahankan `require_preflight_test_order = true` agar order diuji ke `/order/test` sebelum dikirim nyata.
4. Atur `max_order_notional_usdt` dan `max_leverage` (default `3`) sesuai batas risiko Anda.

---

## Strategi, Screener & 21 Feature Toggles

### 1. Screener & Pemilihan Pair (`pair_selection_mode`)
- **`static`**: Hanya memantau daftar `trading.pairs` manual.
- **`hybrid`**: Menggabungkan `trading.pairs` dengan hasil screener trending.
- **`dynamic`**: Sepenuhnya memilih pair dari hasil screener dengan *hysteresis rank buffer* dan *dwell time* (`trending_min_dwell_minutes`) agar daftar pair tidak terus-terusan berganti.
- **Kategori Trending:** `hot_volume`, `top_gainers`, `top_losers`, `volatility_leaders`, dan **`cts_momentum`** (menggabungkan 1h Relative Volume + 1h Momentum + Volume yang dinormalisasi `[0, 1]` dan di-refresh tiap 5 menit).

### 2. Tiga Profil Strategi (`strategy_profile`)
1. **`trend_pullback` (Default):** Mencari pullback ke EMA mid saat tren EMA (`9/21/50/200`) searah, ADX kuat, RSI memantul dari zona pullback, dan harga searah VWAP.
2. **`ema_breakout`:** Masuk saat harga menembus channel Donchian (`donchian_lookback`, default `20`) yang dikonfirmasi tren EMA, ADX, dan volume.
3. **`vwap_reversion`:** Mencari pembalikan rata-rata (mean reversion) ketika harga meregang `>= 1.1x ATR` dari VWAP/EMA21 dengan RSI jenuh dan ADX terbatas.

### 3. Daftar Lengkap 21 Feature Toggles (`[features]`)

Semua fitur dapat dinyalakan/dimatikan secara independen tanpa mengubah kode:

| Kategori | Toggle | Default | Fungsi |
| :--- | :--- | :---: | :--- |
| **Eksekusi & Sesi** | `automated_trading` | `true` | Izinkan bot membuka posisi otomatis dari sinyal. |
| | `manual_trading` | `true` | Izinkan pengiriman order manual dari UI/CLI. |
| | `signal_generator` | `true` | Hitung indikator & evaluasi sinyal pada tiap bar tertutup. |
| | `session_window_filter` | `false` | Batasi entry otomatis hanya pada jam UTC `[[automation.session_windows]]` (exit tetap 24/7). |
| **Venue & Transport** | `spot_market` | `true` | Aktifkan dukungan Binance Spot (`long_only`). |
| | `futures_market` | `true` | Aktifkan dukungan Binance USD-M Futures (Long & Short). |
| | `ws_primary_feed` | `true` | Gunakan WebSocket stream sebagai sumber harga utama. |
| | `rest_fallback` | `true` | Otomatis pindah ke polling REST jika heartbeat WS timeout. |
| **Gate Entry** | `ema_trend_filter` | `true` | Filter arah tren menggunakan stack EMA 9/21/50/200. |
| | `rsi_momentum_filter` | `true` | Filter zona & arah pantulan RSI(14). |
| | `adx_strength_filter` | `true` | Cegah entry di market choppy (`ADX >= adx_min_trend`, DI spread). |
| | `vwap_bias_filter` | `true` | Wajibkan harga berada di sisi yang benar terhadap Session VWAP. |
| | `volume_confirmation_filter` | `false` | Wajibkan lonjakan volume terhadap rata-rata 20 bar. |
| | `htf_trend_filter` | `false` | Konfirmasi tren Higher Timeframe (EMA 1 jam). |
| | `obi_entry_filter` | `false` | Konfirmasi ketimpangan Order Book (Order Book Imbalance). |
| **Exit Lifecycle** | `atr_dynamic_exits` | `true` | Hitung jarak SL & TP secara dinamis berbasis ATR. |
| | `take_profit_ladder` | `true` | Tutup sebagian posisi pada TP1 (`tp1_close_ratio`) lalu biarkan runner ke TP2. |
| | `break_even_stop` | `true` | Geser SL ke harga entry + buffer fee saat profit mencapai `break_even_trigger_r`. |
| | `trailing_stop` | `true` | Aktifkan trailing stop ATR monoton setelah profit mencapai `trailing_activation_r`. |
| **Proteksi & Sync** | `circuit_breaker` | `true` | Hentikan entry baru jika batas rugi/target harian atau streak tercapai. |
| | `git_auto_backup` | `false` | Otomatis commit snapshot konfigurasi tersanitasi ke Git. |

---

## Manajemen Risiko & Exit Lifecycle

1. **Urutan Evaluasi Exit ATR (Anti-Celah):**
   Pada setiap tick, **Break-Even** dan **Trailing Stop** dievaluasi **sebelum** mengeksekusi partial close TP1. Dengan begitu, jika harga melonjak langsung menembus TP1, sisa posisi (runner) langsung terlindungi.
2. **Kepatuhan Eksekusi Binance:**
   - **USD-M Futures:** Menggunakan `newOrderRespType=RESULT`; order kondisional TP/SL dirutekan ke `/fapi/v1/algoOrder` (`algoType=CONDITIONAL`, `workingType=MARK_PRICE`, `priceProtect=true`, `closePosition=true`) dan dipantau lewat `/fapi/v1/openAlgoOrders`. Order exit `reduceOnly` melewati panggilan `marginType`/`leverage` agar error `-4048` tidak pernah memblokir penutupan posisi.
   - **Spot:** Bracket menggunakan `/api/v3/orderList/oco` dan menolak upaya buka posisi short.
3. **Circuit Breaker & Karantina Pair:**
   Mengawasi drawdown harian akun, drawdown per pair, target profit harian, serta batas *lose streak* (disertai cooldown dan karantina pair). Memanggil `reset` pada circuit breaker akan membersihkan daftar `quarantined_pairs` di kedua runtime.
4. **BTC Crash Guard:**
   Memantau penurunan tajam BTC dalam jendela waktu tertentu (`btc_crash_threshold_pct` dalam `btc_crash_window_minutes`). Jika terpicu, **hanya entry baru yang diblokir**—exit posisi terbuka tetap berjalan. Jika feed BTC basi melebihi `btc_crash_max_staleness_sec`, guard bersifat *fail-open* agar bot tidak lumpuh.
5. **Position Sizing & Kelly Guard:**
   Mendukung `fixed_usdt`, `fixed_risk_pct`, `quarter_kelly`, `half_kelly`, dan `full_kelly`. Pada mode Kelly, sistem otomatis memblokir ukuran posisi jika *expectancy* historis negatif (`f* <= 0`).
6. **Cap Leverage Keras:**
   `max_leverage` (default `3`, rentang `1..=20`) dipaksakan pada config, TOML tersinkron, dan setiap jalur pengiriman order.

---

## Konfigurasi (`bot.toml` & `.env`)

### File Konfigurasi Rust (`rust-bot/config/bot.toml`)
Salin dari `rust-bot/config/bot.example.toml`. Bagian utama:
- `[exchange]` — `environment`, `venue`, `leverage`, `max_leverage`, `paper_trading`, `use_ws_api_orders`, parameter failover WS/REST.
- `[exchange.credentials]` — `auth_method`, nama env var key/secret, `ed25519_key_path`, `max_order_notional_usdt`, `require_preflight_test_order`, `armed_for_live_orders`.
- `[trading]` — `mode`, `timeframe`, `pairs`, `position_sizing_mode`, `pair_selection_mode`, parameter screener & CTS.
- `[automation]` & `[[automation.session_windows]]` — `strategy_profile`, `direction_policy`, `order_method`, dynamic cancel, serta jadwal sesi UTC.
- `[features]` — 21 saklar fitur.
- `[indicators]`, `[exits]`, `[risk]` — parameter indikator, pengali ATR, circuit breaker, dan BTC crash guard.

### Environment Variables Penting (`.env`)
Salin dari `.env.example`:

| Variabel | Default | Fungsi |
| :--- | :--- | :--- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Port dan alamat bind Express proxy & UI. |
| `BINANCE_ENVIRONMENT` | `Testnet` | `Testnet` atau `Production`. |
| `BINANCE_VENUE` | `Spot` | `Spot` atau `Futures`. |
| `BINANCE_AUTH_METHOD` | `HMAC-SHA256` | `HMAC-SHA256` atau `Ed25519`. |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | — | Kredensial API Binance. |
| `BINANCE_PRIVATE_KEY_PATH` | — | Path ke file PKCS#8 PEM (untuk Ed25519). |
| `APEXRUST_MAX_ORDER_NOTIONAL_USDT` | `250` | Batas maksimum nilai per order (USDT). |
| `APEXRUST_REQUIRE_PREFLIGHT` | `true` | Wajibkan uji `/order/test` sebelum live order. |
| `APEXRUST_ORDER_DB_PATH` | `.apexrust-orders.sqlite` | Lokasi database ledger order SQLite. |
| `APEXRUST_ENGINE_AUTHORITY` | `browser` | `browser` (UI mengirim order) atau `daemon` (Rust VPS mengirim order). |
| `APEXRUST_ENGINE_URL` | — | URL daemon Rust upstream (misal `http://127.0.0.1:8080`). |
| `APEXRUST_PROXY_TOKEN` | — | Token akses minimal 32 karakter (wajib saat bind `0.0.0.0`). |
| `APEXRUST_PERSIST_VAULT` | `false` | Set `true` agar kunci dari UI disimpan ke `.apexrust/secrets.env`. |
| `APEXRUST_TRUST_PROXY` | — | Set `loopback` atau `true` jika berjalan di belakang reverse proxy / `cloudflared`. |

---

## Mode VPS 24/7 & Remote Access

Untuk menjalankan bot nonstop di VPS dan mengontrolnya dari laptop/HP:

1. **Di VPS:** Jalankan `./install.sh` dengan role VPS (atau set `APEXRUST_ENGINE_AUTHORITY=daemon`, `APEXRUST_ENGINE_URL=http://127.0.0.1:8080`, dan buat token akses via `./apexrust token generate`).
2. **Keamanan Jaringan:** Gunakan **Cloudflare One / Zero Trust** (`cloudflared` atau WARP mesh) atau bind `0.0.0.0` dengan `APEXRUST_PROXY_TOKEN` aktif.
3. **Di Komputer Lokal (Client):**
   ```bash
   ./apexrust remote connect --remote-url https://bot-anda.example.com --remote-token <TOKEN>
   ./apexrust remote status
   ```
4. **Single-Writer Authority:** Pastikan hanya satu pihak (`daemon` **atau** `browser`) yang memegang otoritas eksekusi agar tidak terjadi order ganda.

---

## Arsitektur & Struktur Proyek

```text
                    +-----------------------------+
                    |  Web Command Center (PWA)   |
                    |  Paper / Live Simulation    |
                    +--------------+--------------+
                                   | /api/live/*, /api/market/*, /api/git/*
                    +--------------v--------------+
                    |  Express Proxy (server.ts)  |  Signing, SQLite ledger,
                    |  Port 3000                  |  Git backup, WS relay
                    +--------------+--------------+
                                   | HTTP / WS (opsional, mode VPS)
                    +--------------v--------------+
                    |  bot-web (Axum :8080)       |
                    |  <-> bot-engine (Tokio)     |
                    +--------------+--------------+
              +--------------------+--------------------+
              |                    |                    |
      bot-exchange          bot-indicators        bot-strategy
      (binance-sdk,         (EMA, RSI, ADX,       (3 Profil, Gate,
       WS/REST failover)     ATR, VWAP, OBI)       Exit Plan ATR)
              |                    |                    |
              +--------------------+--------------------+
                                   |
                             bot-risk (Circuit Breaker, Sizing, BTC Guard)
                                   |
                             bot-core (BotConfig, 21 FeatureToggles, Watchlist/CTS)
```

### Struktur Direktori
- `src/` — Aplikasi React 19 + TypeScript (`engine/`, `server/`, `components/`).
- `server.ts` — Express server: API signing, ledger SQLite, market screener hub, WS relay, serta sinkronisasi `bot.synced.toml`.
- `scripts/` — CLI Node (`apexrust.mjs`) & installer lintas OS (`install.sh`, `install.ps1`, `install.cmd`).
- `rust-bot/crates/` — Workspace 10 crate:
  - `bot-core`, `bot-indicators`, `bot-strategy`, `bot-risk`, `bot-exchange`, `bot-engine`, `bot-web`, `bot-desktop`, `bot-keygen`, `bot-cli`.

---

## Verifikasi & Pengujian

Jalankan seluruh pengujian berikut sebelum melakukan commit atau deploy ke production:

```bash
# 1. Rust Workspace (Clippy strict + Unit/Integration Tests)
cd rust-bot
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# 2. WebApp / TypeScript (Type-check, Oxlint, Vite Build, Engine & Server Tests)
cd ..
npm run lint
npm run build
npx --yes tsx --test src/engine/*.test.ts src/server/*.test.ts

# 3. Installer & CLI Scripts
npm run test:installer
sh -n install.sh apexrust
```

---

## Troubleshooting (Mengatasi Masalah)

Langkah pertama saat menemui kendala apa pun, jalankan pemeriksaan otomatis:

```bash
./apexrust doctor
./apexrust bot doctor
```

### 1. Masalah Instalasi & Build

| Gejala | Penyebab Umum | Solusi |
| :--- | :--- | :--- |
| `Node.js version unsupported` | Versi Node < `20.19.0` atau `21.x`. | Pasang Node.js `20.19+` atau `22.12+` (gunakan `fnm` / `nvm`), lalu ulangi `./install.sh`. |
| Gagal compile crate Rust (`openssl` / `cc` not found) | Toolchain C atau header OpenSSL belum terpasang. | **Ubuntu/Debian:** `sudo apt install build-essential pkg-config libssl-dev`<br>**macOS:** `xcode-select --install`<br>**Windows:** Pasang Visual Studio Build Tools (C++ workload). |
| `Permission denied` saat menjalankan `./apexrust` atau `./install.sh` | Bit executable hilang setelah clone/copy. | Jalankan `chmod +x install.sh apexrust`. |

### 2. Masalah Kredensial & Error Binance API

| Gejala / Kode Error | Penyebab Umum | Solusi |
| :--- | :--- | :--- |
| **`-2015: Invalid API-key, IP, or permissions for action`** | 1. Key Testnet dipakai di Production (atau sebaliknya).<br>2. IP server belum di-whitelist di Binance API.<br>3. Izin Spot/Futures belum dicentang.<br>4. Pasangan key Ed25519 tertukar. | - Cocokkan `environment` (`Testnet` vs `Production`) dengan asal key.<br>- Cek izin API & whitelist IP di Binance.<br>- Untuk Ed25519, verifikasi key dengan `./apexrust bot key inspect <path.pem>`. |
| **`-1021: Timestamp for this request was 1000ms ahead/outside recvWindow`** | Jam sistem (OS clock) melenceng dari waktu server Binance. | Sinkronkan NTP sistem (`sudo timedatectl set-ntp true` di Linux) atau perbesar `recv_window_ms` (maksimal sesuai batas Binance, misal `5000`–`10000`). |
| **`-4048: Margin type cannot be changed if there exists position`** | Terjadi saat ingin menutup posisi di Futures. | ApexRust sudah otomatis melewati `/fapi/v1/marginType` pada order `reduceOnly`. Pastikan Anda menjalankan versi terbaru dan tidak mengubah margin type secara manual saat posisi terbuka. |
| **WS API `session.logon` gagal** | Menggunakan kunci HMAC untuk `use_ws_api_orders = true`, atau URL `ws_api_url` salah. | `session.logon` hanya mendukung **Ed25519**. Uji dengan `./apexrust bot ws-api logon`. Untuk sementara, set `use_ws_api_orders = false` agar seluruh order memakai REST. |

### 3. Bot Berjalan Tapi Tidak Membuka Posisi

Periksa berurutan (atau buka tab **Signal** di UI / jalankan `./apexrust bot signal BTCUSDT`):

1. **Mode Paper vs Live:** Jika ingin order nyata tapi tidak ada order di Binance, cek apakah `paper_trading = true` atau `armed_for_live_orders = false`.
2. **Toggle `automated_trading` mati:** Pastikan `[features] automated_trading = true`.
3. **Terblokir Gate Entry:** Beberapa gate opsional seperti `htf_trend_filter`, `obi_entry_filter`, `volume_confirmation_filter`, atau `atr_expansion_filter_enabled` cukup ketat. Cek alasan penolakan di tab **Signal** atau matikan gate yang tidak diperlukan.
4. **Filter Sesi UTC aktif:** Jika `session_window_filter = true`, entry baru hanya berjalan di dalam jam UTC pada `[[automation.session_windows]]`.
5. **BTC Crash Guard aktif:** Jika BTC baru turun tajam melewati `btc_crash_threshold_pct`, entry baru ditahan sementara hingga pasar stabil.
6. **Circuit Breaker / Pair Dikarantina:** Cek `./apexrust bot status`. Jika breaker aktif atau pair masuk karantina akibat *lose streak*, jalankan `./apexrust bot risk reset` setelah mengevaluasi penyebabnya.
7. **Kelly Negative Expectancy Block:** Jika memakai mode `*_kelly` dan data historis menunjukkan ekspektasi negatif (`f* <= 0`), bot sengaja menahan ukuran posisi ke `0`. Ganti sementara ke `fixed_usdt` atau `fixed_risk_pct` untuk mengumpulkan sampel trade.

### 4. Masalah WebSocket, Data & Sinkronisasi

| Gejala | Penyebab Umum | Solusi |
| :--- | :--- | :--- |
| Status transport berubah ke **`RestFallback`** | Koneksi WS ke Binance terputus atau terblokir firewall/ISP, melebihi `ws_heartbeat_timeout_ms`. | Sistem tetap aman berjalan lewat polling REST. Cek koneksi internet/DNS VPS; jika latensi tinggi, naikkan `ws_heartbeat_timeout_ms` (misal ke `8000`). |
| Tidak ada sinyal setelah baru menyalakan bot | Jumlah kandil belum memenuhi `min_warmup_bars`. | Tunggu beberapa detik hingga warmup historis via REST selesai (terlihat di log). |
| Order ganda / konflik UI vs Daemon | Otoritas penulis tidak jelas antara browser dan Rust daemon. | Pastikan `APEXRUST_ENGINE_AUTHORITY` diset tegas ke `browser` **atau** `daemon` (jangan jalankan auto-trading di keduanya sekaligus pada akun yang sama). |

### 5. Masalah WebApp, Proxy & Remote VPS

| Gejala | Penyebab Umum | Solusi |
| :--- | :--- | :--- |
| **Port `3000` atau `8080` sudah dipakai (`EADDRINUSE`)** | Ada proses ApexRust lama atau aplikasi lain di port yang sama. | Jalankan `./apexrust stop`, cek `lsof -i :3000`, atau ubah port lewat `--web-port` / `--bot-port` dan `.env`. |
| **Server menolak start saat bind `0.0.0.0`** | Pengaman wajib memblokir expose publik tanpa token. | Buat token akses dengan `./apexrust token generate` (otomatis mengisi `APEXRUST_PROXY_TOKEN` >= 32 karakter) lalu `./apexrust restart`. |
| **Error `CORS` atau `Origin not allowed` saat akses dari Remote Client** | Origin PWA belum terdaftar di VPS. | Tambahkan URL client ke `APEXRUST_ALLOWED_ORIGINS` di `.env` VPS, lalu restart `web`. |
| **Endpoint `/api/*` mengembalikan halaman HTML / cache PWA lama** | Service worker Workbox stale atau proxy salah arah. | Pastikan `vite.config.ts` mempertahankan `navigateFallbackDenylist: [/^\/api\//, /^\/_ah\//]`. Di browser, lakukan *Hard Reload* (`Ctrl+Shift+R`) atau *Unregister Service Worker* di DevTools. |
| **Gagal terhubung ke WebSocket UI (`ws-ticket` expired / 401)** | Tiket WS sekali pakai berumur 30 detik kedaluwarsa atau token tidak cocok. | Refresh halaman UI atau perbarui token remote via `./apexrust remote connect`. |

---

## Dokumentasi Tambahan

- `AGENTS.md` — Aturan wajib parity WebApp ↔ Rust dan standar verifikasi kode.
- `rust-bot/docs/ARCHITECTURE.md` — Detail graf dependensi crate dan state machine failover.
- `rust-bot/docs/STRATEGY_GUIDE.md` — Rumus matematis indikator, profil strategi, Kelly Criterion, dan audit pra-trade.
- `rust-bot/docs/AI_HANDOFF.md` — Checklist langkah demi langkah untuk menambah toggle, indikator, atau profil baru.
- `arsitektur-trading-bot-rust.md` — Spesifikasi lengkap proyek beserta tabel status implementasi (§9).
