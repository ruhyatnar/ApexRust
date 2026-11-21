# Spesifikasi Arsitektur Sistem Trading Otomatis Berbasis Rust di Binance

Dokumen ini mendefinisikan arsitektur rekayasa perangkat lunak dan spesifikasi kuantitatif untuk sistem perdagangan otomatis berbasis bahasa pemrograman Rust. Sistem ini dirancang untuk mendeteksi pergerakan tren dan momentum pada pasangan perdagangan yang berubah secara dinamis melalui antarmuka Binance WebSocket, serta mengeksekusi strategi berbasis mikrostruktur buku pesanan dengan latensi rendah.

---

## 1. Ikhtisar Arsitektur dan Model Konkurensi

Sistem mengadopsi model aktor terisolasi (*isolated actor pattern*) di atas runtime asinkron Tokio. Arsitektur memisahkan tugas komputasi dan jaringan ke dalam beberapa subsistem independen:

* **Market Scanner**: Menganalisis ringkasan statistik pasar secara simultan melalui aliran WebSocket global untuk menyaring instrumen yang mengalami lonjakan volume dan momentum harga.
* **Subscription Supervisor**: Mengelola alokasi pekerja (*worker pool*) dan siklus hidup langganan data buku pesanan dan kandil secara dinamis berdasarkan peringkat aset.
* **Microstructure Signal Engine**: Memelihara buku pesanan lokal Level-2 dalam memori dan menghitung indikator teknikal serta rasio ketidakseimbangan buku pesanan (*Order Book Imbalance*).
* **Execution & Router**: Menangani pengiriman pesanan cepat dan pesanan pelindung (*bracket orders*) ke antarmuka Binance WebSocket API.
* **Risk Controller**: Mengontrol kepatuhan aturan pra-transaksi (*pre-trade checks*), ukuran posisi dinamis, dan mekanisme pemutus sirkuit (*circuit breaker*).

Komunikasi antar-aktor menggunakan saluran transmisi pesan bebas kunci (*crossbeam-channel* dan *tokio mpsc*) guna menjamin latensi deterministik tanpa jeda pengumpulan sampah memori.

---

## 2. Konfigurasi Proyek dan Ekosistem Dependensi Rust (Cargo.toml)

Sistem memanfaatkan pustaka murni Rust berkinerja tinggi untuk pemrosesan asinkron, deserialisasi cepat, dan presisi numerik finansial:

```toml
[package]
name = "binance-dynamic-autotrade"
version = "0.1.0"
edition = "2021"

[dependencies]
# Runtime Asinkron dan Konkurensi
tokio = { version = "1.38", features = ["full", "parking_lot"] }
tokio-tungstenite = { version = "0.23", features = ["rustls-tls-native-roots"] }
futures-util = "0.3"
crossbeam-channel = "0.5"
dashmap = "5.5"

# Deserialisasi Kinerja Tinggi
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
simd-json = "0.13"

# Autentikasi dan Protokol Jaringan
ed25519-dalek = { version = "2.1" }
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }

# Matematika Presisi dan Analisis Kuantitatif
rust_decimal = { version = "1.35", features = ["serde-float"] }
rust_decimal_macros = "1.35"
yata = "0.7"

# Utilitas Diagnostik dan Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
chrono = { version = "0.4", features = ["serde"] }

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
strip = true
```

---

## 3. Modul Pemindai Pasangan Dinamis (Dynamic Market Scanner)

### 3.1. Penyerapan Aliran Data Pasar Global

Pemindai terhubung ke siaran ringkas seluruh instrumen pasar yang dipancarkan bursa setiap 1.000 milidetik:
* Pasar Spot: Aliran miniTicker agregat global
* Pasar Futures: Aliran miniTicker kontraktual global

Aliran ini menyediakan statistik harga penutupan, volume transaksi dasar, dan volume kuotasi tanpa menimbulkan beban batas kuota permintaan REST.

### 3.2. Model Kualifikasi dan Skor Komposit Tren (CTS)

Setiap detik, paket data yang masuk dideserialisasi ke dalam memori menggunakan pustaka deserialisasi cepat dan diuji melalui filter kuantitatif bertingkat:

1. **Ambang Batas Likuiditas**: Volume perdagangan 24 jam pasangan kuotasi (USDT) wajib mencukupi:
   $$\text{Volume}_{24\text{h}} \ge \$15.000.000\text{ USDT}$$

2. **Lonjakan Volume Relatif (Relative Volume / RVOL)**:
   $$\text{RVOL} = \frac{\text{Volume}_{1\text{h}}}{\text{Volume Rata-rata 1h dalam 24h}}$$
   Kriteria anomali minat pasar terpenuhi jika $\text{RVOL} \ge 2,5$.

3. **Momentum Kinetik Harga 1 Jam**:
   $$\Delta P_{1\text{h}} = \frac{P_{\text{current}} - P_{1\text{h ago}}}{P_{1\text{h ago}}} \times 100\%$$
   Kriteria momentum terpenuhi apabila $\Delta P_{1\text{h}} \ge +3,0\%$.

4. **Formula Skor Komposit Tren (Composite Trend Score / CTS)**:
   $$\text{CTS} = (0,4 \times \text{RVOL}) + (0,4 \times \Delta P_{1\text{h}}) + \left(0,2 \times \frac{\text{Volume}_{24\text{h}}}{\text{Median Market Volume}}\right)$$

Sebanyak 3 hingga 5 instrumen dengan skor CTS tertinggi dialokasikan ke subsistem pengawasan langganan dinamis.

---

## 4. Siklus Hidup Langganan Dinamis (Dynamic Subscription Supervisor)

Untuk menghemat penggunaan CPU dan lebar pita jaringan, instrumen pasar dikelola berdasarkan siklus transisi status:

* **Idle**: Dipantau secara pasif pada aliran ringkas global.
* **Discovered**: Memenuhi skor CTS; memicu inisialisasi modul pekerja.
* **Warming Up**: Berlangganan data detail (kline dan depth), mengambil data historis singkat untuk mengisi buffer indikator.
* **Active Trading**: Memproses data secara real-time dan mengevaluasi aturan pemicu entri posisi.
* **Cooling Down**: Menghapus langganan detail jika momentum memudar di bawah ambang batas retensi.

Perintah pendaftaran dan pelepasan stream dikirim melalui format JSON-RPC WebSocket dinamis (metode SUBSCRIBE dan UNSUBSCRIBE).

---

## 5. Algoritma Pendeteksian Sinyal dan Aturan Eksekusi

Pada instrumen yang aktif, sistem menggabungkan tiga lapisan validasi sinyal:

### 5.1. Filter Tren Makro (Kerangka Waktu 1 Jam)

* Harga penutupan berada di atas rata-rata bergerak eksponensial 200 periode (EMA 200).
* EMA 20 periode berada di atas EMA 50 periode.
* Indikator Average Directional Index (ADX 14) berada pada level $\ge 25$, memastikan pasar berada dalam kondisi tren terarah yang kuat.

### 5.2. Pemicu Penembusan Volatilitas (Kerangka Waktu 5 Menit)

* Penembusan batas atas Donchian Channel 20 periode.
* Konfirmasi ekspansi volatilitas: Average True Range (ATR 14) berada di atas atau sama dengan 1,5 kali rata-rata bergerak sederhana ATR 50 periode:
  $$\text{ATR}_{14} \ge 1,5 \times \text{SMA}_{50}(\text{ATR}_{14})$$

### 5.3. Konfirmasi Mikrostruktur Order Book Imbalance (OBI)

Sebelum transmisi order, sistem mengevaluasi rasio likuiditas pada 10 tingkat harga teratas buku pesanan:

$$\text{OBI} = \frac{\sum_{i=1}^{10} V_{\text{bid}, i} - \sum_{i=1}^{10} V_{\text{ask}, i}}{\sum_{i=1}^{10} V_{\text{bid}, i} + \sum_{i=1}^{10} V_{\text{ask}, i}}$$

Order beli hanya diizinkan apabila $\text{OBI} \ge +0,35$, menandakan dominasi likuiditas beli di pasar.

---

## 6. Protokol Transmisi Order dan Manajemen Presisi

Eksekusi transaksi menggunakan WebSocket API terautentikasi:

* **Autentikasi Sesi**: Menggunakan pasangan kunci kriptografis asimetris untuk inisialisasi sesi masuk (metode session.logon), sehingga pesanan berikutnya dieksekusi tanpa perlu penandatanganan berulang pada tiap payload pesan.
* **Bracket Orders**: Setiap posisi beli disertai dengan batas henti rugi tegas (hard stop-loss pada $1,5 \times \text{ATR}_{14}$ di bawah harga beli) dan target keuntungan bergerak (trailing profit pada $3,0 \times \text{ATR}_{14}$).
* **Presisi Desimal**: Semua kalkulasi kuantitas dan harga menggunakan tipe data desimal presisi tinggi guna mematuhi aturan filter bursa (LOT_SIZE, PRICE_FILTER, MIN_NOTIONAL) tanpa pembulatan mengambang.

---

## 7. Engine Manajemen Risiko Kuantitatif

Tabel berikut merangkum batasan risiko operasional yang dijalankan pengawas portofolio:

| Parameter Kontrol Risiko | Batas Ambang | Aksi Otomatis |
| :--- | :--- | :--- |
| **Risiko Per Posisi** | 1,0% - 1,5% Ekuitas | Ukuran kuantitas dihitung dinamis dari jarak Stop-Loss ATR |
| **Maksimum Posisi Aktif** | 3 Pasangan Simultan | Mengunci slot transaksi baru hingga ada posisi yang ditutup |
| **Maksimum Leverage** | Maksimal 3x (Futures) / 1x (Spot) | Mengendalikan eksposur margin |
| **Proteksi Penurunan Pasar Induk** | Koreksi BTC > 1,5% dalam 15 menit | Menunda eksekusi posisi baru pada seluruh altcoin |
| **Batas Penurunan Modal Harian** | 4,0% dari Ekuitas Awal Hari | Pemutus sirkuit: menutup posisi aktif dan menghentikan bot |

Perhitungan ukuran posisi dinamis mengikuti model pecahan tetap (*Fixed Fractional Model*):
$$\text{Position Size (USDT)} = \frac{\text{Total Equity} \times \text{Risk Percentage}}{\text{Entry Price} - \text{Stop Loss Price}}$$

---

## 8. Tata Letak Modul Proyek dan Rencana Eksekusi

Struktur repositori kode sumber direkomendasikan mengadopsi hierarki modul berikut:

```text
src/
├── main.rs                 # Inisialisasi runtime Tokio dan penanganan sinyal OS
├── config.rs               # Parser konfigurasi lingkungan
├── types.rs                # Definisi struct data pasar dan sinyal
├── network/
│   ├── mod.rs
│   ├── ws_market.rs        # Penanganan stream publik (miniTicker, depth)
│   ├── ws_api.rs           # Penanganan WebSocket API (eksekusi order)
│   └── signer.rs           # Penandatanganan sesi terotentikasi
├── engine/
│   ├── mod.rs
│   ├── scanner.rs          # Komputasi RVOL, momentum 1 jam, pemeringkatan CTS
│   ├── supervisor.rs       # Dynamic subscription manager dan alokasi worker
│   ├── orderbook.rs        # Struktur data BTreeMap L2 order book lokal dan OBI
│   └── signals.rs          # Indikator teknikal (yata) dan logika penembusan
└── risk/
    ├── mod.rs
    ├── sizing.rs           # Kalkulasi ukuran posisi berbasis risiko
    └── circuit_breaker.rs  # Proteksi korelasi BTC dan pembatasan drawdown
```

### 8.1. Panduan Pengujian dan Penerapan bagi Agen Pengembang

1. **Validasi Lingkungan Testnet**: Uji coba alur konektivitas dan eksekusi pada Testnet resmi sebelum beralih ke lingkungan produksi.
2. **Sinkronisasi Waktu Server**: Pastikan sinkronisasi jam sistem operasi dengan NTP beroperasi secara kontinu dengan deviasi waktu di bawah 50 milidetik terhadap peladen bursa.
3. **Simulasi Paper Trading**: Jalankan modul pemindai dan sinyal dalam mode simulasi (*dry-run*) minimal 72 jam untuk mengevaluasi stabilitas dan kinerja sinyal sebelum alokasi modal langsung.
