use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// OHLCV candlestick bar.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Candle {
    pub open_time_ms: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub is_closed: bool,
}

/// Real-time market event delivered by WebSocket primary or REST fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketEvent {
    pub symbol: String,
    pub price: f64,
    pub candle: Candle,
    pub source: TransportMode,
    pub received_at: DateTime<Utc>,
}

/// Current active transport path in the exchange gateway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportMode {
    WsPrimary,
    RestFallback,
    Reconnecting,
}

/// Snapshot of technical indicators computed on the latest bar for a pair.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct IndicatorSnapshot {
    pub ema_fast: Option<f64>,
    pub ema_mid: Option<f64>,
    pub ema_slow: Option<f64>,
    pub ema_macro: Option<f64>,
    #[serde(default)]
    pub prev_ema_mid: Option<f64>,
    pub rsi: Option<f64>,
    pub prev_rsi: Option<f64>,
    pub adx: Option<f64>,
    #[serde(default)]
    pub prev_adx: Option<f64>,
    pub plus_di: Option<f64>,
    pub minus_di: Option<f64>,
    pub atr: Option<f64>,
    pub prev_atr: Option<f64>,
    pub vwap: Option<f64>,
    pub avg_volume_20: Option<f64>,
    #[serde(default)]
    pub volume_ratio: Option<f64>,
    /// SMA(50) of ATR — regime baseline for the ATR expansion filter.
    #[serde(default)]
    pub atr_sma_50: Option<f64>,
    /// Closed 1h candle close for the higher-timeframe trend gate.
    #[serde(default)]
    pub htf_close: Option<f64>,
    /// EMA(`htf_ema_period`) computed on closed 1h candles.
    #[serde(default)]
    pub htf_ema_macro: Option<f64>,
    /// Order-book imbalance in [-1, 1] from the top depth levels.
    #[serde(default)]
    pub obi: Option<f64>,
    #[serde(default)]
    pub warmup_bars_count: usize,
    #[serde(default)]
    pub has_bar_gap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    #[serde(alias = "long", alias = "LONG")]
    Long,
    #[serde(alias = "short", alias = "SHORT")]
    Short,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntrySignal {
    pub symbol: String,
    pub side: Side,
    pub entry_price: f64,
    pub atr: f64,
    pub adx: f64,
    pub rsi: f64,
    pub rationale: String,
    pub timestamp: DateTime<Utc>,
}

fn default_true_flag() -> bool {
    true
}

/// Active ATR-driven exit brackets attached to every open position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitPlan {
    pub initial_stop_loss: f64,
    pub active_stop_loss: f64,
    pub take_profit_1: f64,
    pub take_profit_2: f64,
    pub tp1_hit: bool,
    pub break_even_armed: bool,
    #[serde(default = "default_true_flag")]
    pub break_even_enabled: bool,
    pub trailing_active: bool,
    #[serde(default = "default_true_flag")]
    pub trailing_enabled: bool,
    #[serde(default = "default_true_flag")]
    pub tp_ladder_enabled: bool,
    pub risk_distance_r: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    pub symbol: String,
    pub side: Side,
    pub entry_price: f64,
    pub quantity: f64,
    pub remaining_quantity: f64,
    pub unrealized_pnl_usdt: f64,
    pub realized_pnl_usdt: f64,
    pub highest_favorable_price: f64,
    pub exit_plan: ExitPlan,
    pub opened_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExitReason {
    StopLoss,
    BreakEvenStop,
    TrailingStop,
    TakeProfit1,
    TakeProfit2,
    SignalReversal,
    MomentumExhaustion,
    CircuitBreakerFlatten,
    ManualClose,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedTrade {
    pub id: String,
    pub symbol: String,
    pub side: Side,
    pub entry_price: f64,
    pub exit_price: f64,
    pub quantity: f64,
    pub pnl_usdt: f64,
    pub r_multiple: f64,
    pub reason: ExitReason,
    pub closed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CircuitBreakerState {
    Active,
    Cooldown,
    Halted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskStatus {
    pub state: CircuitBreakerState,
    pub halt_reason: Option<String>,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub starting_daily_equity: f64,
    pub current_equity: f64,
    pub cumulative_daily_pnl_usdt: f64,
    pub cumulative_daily_pnl_pct: f64,
    pub win_streak: u32,
    pub lose_streak: u32,
    pub quarantined_pairs: Vec<String>,
    /// BTC move (%) across the guard window, absent until two samples exist.
    #[serde(default)]
    pub btc_change_pct_window: Option<f64>,
    #[serde(default)]
    pub btc_window_minutes: u64,
    #[serde(default)]
    pub btc_guard_blocking: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PairSourceTag {
    #[default]
    Pinned,
    Trending,
    ProtectedPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSnapshot {
    pub symbol: String,
    pub last_price: f64,
    pub daily_pnl_usdt: f64,
    pub daily_pnl_pct: f64,
    pub indicators: IndicatorSnapshot,
    pub open_position: Option<Position>,
    #[serde(default)]
    pub source_tag: Option<PairSourceTag>,
    #[serde(default)]
    pub tradable_on_active_venue: Option<bool>,
    #[serde(default)]
    pub quote_volume_24h_usdt: Option<f64>,
    #[serde(default)]
    pub best_bid: Option<f64>,
    #[serde(default)]
    pub best_ask: Option<f64>,
    #[serde(default)]
    pub spread_bps: Option<f64>,
    #[serde(default)]
    pub bars_warmed_up: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingOrderSnapshot {
    pub order_id: String,
    pub symbol: String,
    pub side: Side,
    pub order_method: crate::OrderExecutionMethod,
    pub quantity: f64,
    pub limit_price: f64,
    pub is_live: bool,
    pub is_manual: bool,
    pub created_bar_idx: u64,
    pub age_bars: u64,
    pub rationale: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketTicker24h {
    pub symbol: String,
    #[serde(with = "serde_exchange_venue")]
    pub venue: crate::ExchangeVenue,
    pub last_price: f64,
    pub open_price_24h: f64,
    pub high_price_24h: f64,
    pub low_price_24h: f64,
    pub price_change_percent: f64,
    pub base_volume: f64,
    pub quote_volume: f64,
    pub range_pct_24h: f64,
    pub tradable_on_active_env: bool,
    #[serde(default)]
    pub in_watchlist: bool,
    #[serde(default)]
    pub source_tag: Option<PairSourceTag>,
    pub updated_at_ms: i64,
    /// CTS screener metrics (1h RVOL / 1h momentum / blended score).
    #[serde(default)]
    pub rvol_1h: Option<f64>,
    #[serde(default)]
    pub momentum_1h_pct: Option<f64>,
    #[serde(default)]
    pub cts_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerSnapshotPayload {
    #[serde(with = "serde_exchange_venue")]
    pub venue: crate::ExchangeVenue,
    pub environment: String,
    pub ranking_source_used: String,
    pub stream_connected: bool,
    pub total_tradable_symbols: usize,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub rate_weight_used_1m: Option<u64>,
    pub tickers: Vec<MarketTicker24h>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolatilitySpikeAlert {
    pub id: String,
    pub symbol: String,
    pub price: f64,
    pub atr: f64,
    pub atr_pct: f64,
    pub expansion_ratio: f64,
    pub message: String,
    pub triggered_at: DateTime<Utc>,
}

/// Complete immutable snapshot streamed to WebApp clients (`bot-web`) and Desktop UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSnapshot {
    pub running: bool,
    pub venue: crate::ExchangeVenue,
    pub transport_mode: TransportMode,
    pub failover_count: u64,
    pub last_ws_age_ms: u64,
    pub risk: RiskStatus,
    pub pairs: Vec<PairSnapshot>,
    #[serde(default)]
    pub pending_orders: Vec<PendingOrderSnapshot>,
    #[serde(default)]
    pub pair_selection_mode: crate::PairSelectionMode,
    pub recent_trades: Vec<ClosedTrade>,
    #[serde(default)]
    pub recent_volatility_alerts: Vec<VolatilitySpikeAlert>,
    pub updated_at: DateTime<Utc>,
}

/// Supported lookback windows for Binance historical order & trade synchronization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncLookbackPreset {
    #[serde(rename = "1d")]
    D1,
    #[serde(rename = "3d")]
    D3,
    #[serde(rename = "7d")]
    D7,
    #[serde(rename = "30d")]
    D30,
}

impl SyncLookbackPreset {
    pub fn duration_ms(&self) -> i64 {
        match self {
            Self::D1 => 86_400_000,
            Self::D3 => 3 * 86_400_000,
            Self::D7 => 7 * 86_400_000,
            Self::D30 => 30 * 86_400_000,
        }
    }
}

/// Generates official Binance-compliant `(start_time_ms, end_time_ms)` query slices:
/// - Spot (`/api/v3/allOrders`, `/api/v3/myTrades`): `< 24h` (`86,399,999 ms`) per slice.
/// - USD-M Futures (`/fapi/v1/allOrders`, `/fapi/v1/userTrades`): `<= 7d` (`6 days` per slice).
pub fn build_sync_time_windows(
    venue: crate::ExchangeVenue,
    lookback: SyncLookbackPreset,
    now_ms: i64,
) -> Vec<(i64, i64)> {
    let start_bound = (now_ms - lookback.duration_ms()).max(0);
    let max_slice = match venue {
        crate::ExchangeVenue::Spot => 86_399_999,
        crate::ExchangeVenue::Futures => 6 * 86_400_000,
    };
    let mut windows = Vec::new();
    let mut cursor = start_bound;
    while cursor < now_ms {
        let seg_end = (cursor + max_slice).min(now_ms);
        windows.push((cursor, seg_end));
        if seg_end >= now_ms {
            break;
        }
        cursor = seg_end + 1;
    }
    windows
}

fn default_both_pos_side() -> String {
    "BOTH".into()
}

fn default_usdt_asset() -> String {
    "USDT".into()
}

mod serde_exchange_venue {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(venue: &crate::ExchangeVenue, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match venue {
            crate::ExchangeVenue::Spot => serializer.serialize_str("Spot"),
            crate::ExchangeVenue::Futures => serializer.serialize_str("Futures"),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<crate::ExchangeVenue, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        if raw.trim().eq_ignore_ascii_case("futures") {
            Ok(crate::ExchangeVenue::Futures)
        } else {
            Ok(crate::ExchangeVenue::Spot)
        }
    }
}

/// Official Binance-aligned Order Execution Log persisted in `.apexrust-orders.sqlite`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderExecutionLog {
    pub id: String,
    pub order_id: String,
    pub client_order_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_list_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algo_order_ids: Option<Vec<String>>,
    pub symbol: String,
    #[serde(with = "serde_exchange_venue")]
    pub venue: crate::ExchangeVenue,
    pub environment: String,
    pub account_mode: String,
    pub source: String,
    pub lifecycle: String,
    pub side: Side,
    pub binance_side: String,
    #[serde(default = "default_both_pos_side")]
    pub position_side: String,
    pub order_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_type: Option<String>,
    pub time_in_force: String,
    pub status: String,
    pub price: f64,
    #[serde(default)]
    pub avg_price: f64,
    #[serde(default)]
    pub stop_price: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activate_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_rate: Option<f64>,
    pub executed_qty: f64,
    pub orig_qty: f64,
    pub quote_qty: f64,
    #[serde(default)]
    pub commission: f64,
    #[serde(default = "default_usdt_asset")]
    pub commission_asset: String,
    #[serde(default)]
    pub is_maker: bool,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub close_position: bool,
    #[serde(default)]
    pub price_protect: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_trade_prevention_mode: Option<String>,
    pub realized_pnl_usdt: Option<f64>,
    pub r_multiple: Option<f64>,
    pub exit_reason: Option<String>,
    pub latency_ms: Option<i64>,
    pub endpoint: String,
    pub rationale: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default)]
    pub order_time_ms: i64,
    #[serde(default)]
    pub update_time_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_time_ms: Option<i64>,
    pub timestamp_ms: i64,
}

impl OrderExecutionLog {
    pub fn composite_key(&self) -> String {
        format!(
            "{}:{}:{:?}:{}:{}:{}",
            self.account_mode,
            self.environment,
            self.venue,
            self.symbol,
            self.order_id,
            self.lifecycle
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSyncWatermark {
    pub key: String,
    pub symbol: String,
    #[serde(with = "serde_exchange_venue")]
    pub venue: crate::ExchangeVenue,
    pub environment: String,
    pub last_synced_at_ms: i64,
    pub oldest_synced_start_ms: i64,
    pub last_lookback: String,
    pub last_synced_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDatabaseSummary {
    pub engine: String,
    pub db_path: String,
    pub total_count: usize,
    pub live_count: usize,
    pub paper_count: usize,
    pub max_live_quota: usize,
    pub max_paper_quota: usize,
    pub distinct_symbols: Vec<String>,
    pub watermarks: Vec<SymbolSyncWatermark>,
    pub last_updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanPairRecord {
    pub symbol: String,
    #[serde(with = "serde_exchange_venue")]
    pub venue: crate::ExchangeVenue,
    pub environment: String,
    pub kinds: Vec<String>,
    pub in_configured_pairs: bool,
    pub exchange_open_orders_count: usize,
    pub exchange_algo_orders_count: usize,
    pub exchange_position_amt: f64,
    pub exchange_unrealized_pnl_usdt: f64,
    pub exchange_spot_free_balance: f64,
    pub exchange_spot_locked_balance: f64,
    pub local_db_order_count: usize,
    pub local_stale_open_order_ids: Vec<String>,
    pub summary: String,
    pub detected_at_ms: i64,
}

/// SQLite WAL Order History Database shared between `rust-bot` and `server.ts`.
pub struct OrderHistoryStore {
    db_path: std::path::PathBuf,
    max_live_quota: usize,
    max_paper_quota: usize,
}

impl OrderHistoryStore {
    pub fn new(db_path: impl Into<std::path::PathBuf>) -> crate::Result<Self> {
        let store = Self {
            db_path: db_path.into(),
            max_live_quota: 5000,
            max_paper_quota: 1000,
        };
        store.init_schema()?;
        Ok(store)
    }

    fn open_conn(&self) -> crate::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open(&self.db_path)
            .map_err(|e| crate::BotError::Config(format!("SQLite open error: {e}")))?;
        let _ = conn.execute_batch(
            "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        );
        Ok(conn)
    }

    fn init_schema(&self) -> crate::Result<()> {
        let conn = self.open_conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS order_history (
                id TEXT PRIMARY KEY,
                composite_key TEXT NOT NULL UNIQUE,
                account_mode TEXT NOT NULL,
                venue TEXT NOT NULL,
                environment TEXT NOT NULL,
                symbol TEXT NOT NULL,
                order_id TEXT NOT NULL,
                lifecycle TEXT NOT NULL,
                status TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_order_history_query
                ON order_history (account_mode, venue, environment, symbol, status, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_order_history_ts
                ON order_history (timestamp_ms DESC);
            CREATE TABLE IF NOT EXISTS sync_watermarks (
                key TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                venue TEXT NOT NULL,
                environment TEXT NOT NULL,
                last_synced_at_ms INTEGER NOT NULL,
                oldest_synced_start_ms INTEGER NOT NULL,
                last_lookback TEXT NOT NULL,
                last_synced_count INTEGER NOT NULL
            );",
        )
        .map_err(|e| crate::BotError::Config(format!("SQLite schema error: {e}")))?;
        Ok(())
    }

    pub fn upsert_logs(&self, entries: &[OrderExecutionLog]) -> crate::Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }
        let mut conn = self.open_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| crate::BotError::Config(format!("SQLite tx error: {e}")))?;
        let mut upserted = 0usize;
        {
            let mut del_by_id_stmt = tx
                .prepare("DELETE FROM order_history WHERE id = ?1")
                .map_err(|e| crate::BotError::Config(format!("SQLite prepare delete error: {e}")))?;
            let mut stmt = tx
                .prepare(
                    "INSERT INTO order_history (
                        id, composite_key, account_mode, venue, environment, symbol, order_id, lifecycle, status, timestamp_ms, payload_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                    ON CONFLICT(composite_key) DO UPDATE SET
                        id = excluded.id,
                        status = excluded.status,
                        timestamp_ms = excluded.timestamp_ms,
                        payload_json = excluded.payload_json",
                )
                .map_err(|e| crate::BotError::Config(format!("SQLite prepare error: {e}")))?;

            for item in entries {
                let venue_str = match item.venue {
                    crate::ExchangeVenue::Spot => "Spot",
                    crate::ExchangeVenue::Futures => "Futures",
                };
                let json = serde_json::to_string(item)?;
                del_by_id_stmt
                    .execute(rusqlite::params![item.id])
                    .map_err(|e| crate::BotError::Config(format!("SQLite id pre-delete error: {e}")))?;
                stmt.execute(rusqlite::params![
                    item.id,
                    item.composite_key(),
                    item.account_mode,
                    venue_str,
                    item.environment,
                    item.symbol,
                    item.order_id,
                    item.lifecycle,
                    item.status,
                    item.timestamp_ms,
                    json
                ])
                .map_err(|e| crate::BotError::Config(format!("SQLite upsert error: {e}")))?;
                upserted += 1;
            }
        }
        // Enforce partitioned retention quotas for Live vs Paper
        let _ = tx.execute(
            "DELETE FROM order_history WHERE account_mode = 'Live' AND id NOT IN (
                SELECT id FROM order_history WHERE account_mode = 'Live' ORDER BY timestamp_ms DESC LIMIT ?1
            )",
            rusqlite::params![self.max_live_quota as i64],
        );
        let _ = tx.execute(
            "DELETE FROM order_history WHERE account_mode = 'Paper' AND id NOT IN (
                SELECT id FROM order_history WHERE account_mode = 'Paper' ORDER BY timestamp_ms DESC LIMIT ?1
            )",
            rusqlite::params![self.max_paper_quota as i64],
        );
        tx.commit()
            .map_err(|e| crate::BotError::Config(format!("SQLite commit error: {e}")))?;
        Ok(upserted)
    }

    pub fn query_logs(&self, limit: usize) -> crate::Result<Vec<OrderExecutionLog>> {
        let conn = self.open_conn()?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM order_history ORDER BY timestamp_ms DESC LIMIT ?1")
            .map_err(|e| crate::BotError::Config(format!("SQLite query error: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![limit.clamp(1, 50_000) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| crate::BotError::Config(format!("SQLite map error: {e}")))?;
        let mut out = Vec::new();
        for json in rows.flatten() {
            if let Ok(parsed) = serde_json::from_str::<OrderExecutionLog>(&json) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    fn query_all_logs_internal(&self, conn: &rusqlite::Connection) -> crate::Result<Vec<OrderExecutionLog>> {
        let mut stmt = conn
            .prepare("SELECT payload_json FROM order_history ORDER BY timestamp_ms DESC")
            .map_err(|e| crate::BotError::Config(format!("SQLite query error: {e}")))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| crate::BotError::Config(format!("SQLite map error: {e}")))?;
        let mut out = Vec::new();
        for json in rows.flatten() {
            if let Ok(parsed) = serde_json::from_str::<OrderExecutionLog>(&json) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    pub fn summary(&self) -> crate::Result<OrderDatabaseSummary> {
        let conn = self.open_conn()?;
        let logs = self.query_all_logs_internal(&conn)?;
        let mut live_count = 0usize;
        let mut paper_count = 0usize;
        let mut symbols = std::collections::BTreeSet::new();
        for l in &logs {
            if l.account_mode == "Live" {
                live_count += 1;
            } else {
                paper_count += 1;
            }
            symbols.insert(l.symbol.clone());
        }
        let mut watermarks = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT key, symbol, venue, environment, last_synced_at_ms, oldest_synced_start_ms, last_lookback, last_synced_count
             FROM sync_watermarks ORDER BY last_synced_at_ms DESC",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| {
                let venue_raw: String = r.get(2)?;
                let lb_raw: String = r.get(6)?;
                Ok(SymbolSyncWatermark {
                    key: r.get(0)?,
                    symbol: r.get(1)?,
                    venue: if venue_raw == "Futures" {
                        crate::ExchangeVenue::Futures
                    } else {
                        crate::ExchangeVenue::Spot
                    },
                    environment: r.get(3)?,
                    last_synced_at_ms: r.get(4)?,
                    oldest_synced_start_ms: r.get(5)?,
                    last_lookback: lb_raw,
                    last_synced_count: r.get::<_, i64>(7)?.max(0) as usize,
                })
            }) {
                for wm in rows.flatten() {
                    watermarks.push(wm);
                }
            }
        }
        Ok(OrderDatabaseSummary {
            engine: "sqlite_wal".into(),
            db_path: self
                .db_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(".apexrust-orders.sqlite")
                .to_string(),
            total_count: logs.len(),
            live_count,
            paper_count,
            max_live_quota: self.max_live_quota,
            max_paper_quota: self.max_paper_quota,
            distinct_symbols: symbols.into_iter().collect(),
            watermarks,
            last_updated_at_ms: Utc::now().timestamp_millis(),
        })
    }

    /// Transitions an existing `ENTRY` order row (`NEW` / `PARTIALLY_FILLED`) to `CANCELED`
    /// in place on the matching `composite_key`, preventing duplicate or ghost `NEW` records.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_entry_canceled(
        &self,
        account_mode: &str,
        venue: crate::ExchangeVenue,
        environment: &str,
        symbol: &str,
        order_id: &str,
        update_time_ms: i64,
        rationale: &str,
    ) -> crate::Result<bool> {
        let venue_str = match venue {
            crate::ExchangeVenue::Spot => "Spot",
            crate::ExchangeVenue::Futures => "Futures",
        };
        let key = format!(
            "{}:{}:{}:{}:{}:ENTRY",
            account_mode.trim(),
            environment.trim(),
            venue_str,
            symbol.trim().to_ascii_uppercase(),
            order_id.trim()
        );
        let conn = self.open_conn()?;
        let existing_json: Option<String> = conn
            .prepare("SELECT payload_json FROM order_history WHERE composite_key = ?1 LIMIT 1")
            .and_then(|mut s| s.query_row(rusqlite::params![key], |r| r.get(0)))
            .ok();
        let Some(raw) = existing_json else {
            return Ok(false);
        };
        let Ok(mut log) = serde_json::from_str::<OrderExecutionLog>(&raw) else {
            return Ok(false);
        };
        log.status = "CANCELED".into();
        log.update_time_ms = update_time_ms.max(log.update_time_ms);
        log.timestamp_ms = update_time_ms.max(log.timestamp_ms);
        if !rationale.trim().is_empty() {
            log.rationale = rationale.to_string();
        }
        let updated_json = serde_json::to_string(&log)?;
        conn.execute(
            "UPDATE order_history SET status = 'CANCELED', timestamp_ms = ?1, payload_json = ?2 WHERE composite_key = ?3",
            rusqlite::params![log.timestamp_ms, updated_json, key],
        )
        .map_err(|e| crate::BotError::Config(format!("SQLite cancel update error: {e}")))?;
        Ok(true)
    }

    pub fn delete_logs(
        &self,
        account_mode: Option<&str>,
        symbol: Option<&str>,
        older_than_days: Option<u32>,
        now_ms: i64,
    ) -> crate::Result<usize> {
        let mut conn = self.open_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| crate::BotError::Config(format!("SQLite delete tx error: {e}")))?;
        let mode = account_mode.unwrap_or("ALL").trim();
        let sym = symbol.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
        let cutoff_ms = older_than_days
            .filter(|&d| d > 0)
            .map(|d| now_ms - (d as i64) * 86_400_000);

        let all = self.query_all_logs_internal(&tx)?;
        let mut ids_to_delete = Vec::new();
        let mut remaining_sym_rows = false;
        for l in &all {
            let match_mode = mode.eq_ignore_ascii_case("ALL") || l.account_mode.eq_ignore_ascii_case(mode);
            let match_sym = sym.as_ref().is_none_or(|s| l.symbol.eq_ignore_ascii_case(s));
            let match_age = cutoff_ms.is_none_or(|cut| l.timestamp_ms < cut);
            if match_mode && match_sym && match_age {
                ids_to_delete.push(l.id.clone());
            } else if sym.as_ref().is_some_and(|s| l.symbol.eq_ignore_ascii_case(s)) {
                remaining_sym_rows = true;
            }
        }
        let mut deleted = 0usize;
        for id in &ids_to_delete {
            if let Ok(rows_changed) = tx.execute("DELETE FROM order_history WHERE id = ?1", rusqlite::params![id]) {
                deleted += rows_changed;
            }
        }
        if mode.eq_ignore_ascii_case("ALL") && sym.is_none() && cutoff_ms.is_none() {
            let _ = tx.execute("DELETE FROM sync_watermarks", []);
        } else if let Some(ref s) = sym {
            if !mode.eq_ignore_ascii_case("Paper") && cutoff_ms.is_none() && !remaining_sym_rows {
                let _ = tx.execute(
                    "DELETE FROM sync_watermarks WHERE symbol = ?1",
                    rusqlite::params![s],
                );
            }
        }
        tx.commit()
            .map_err(|e| crate::BotError::Config(format!("SQLite delete commit error: {e}")))?;
        Ok(deleted)
    }

    pub fn detect_local_orphans(
        &self,
        configured_pairs: &[String],
        venue: crate::ExchangeVenue,
        environment: &str,
    ) -> crate::Result<Vec<OrphanPairRecord>> {
        let configured: std::collections::HashSet<String> = configured_pairs
            .iter()
            .map(|s| s.trim().to_uppercase())
            .collect();
        let conn = self.open_conn()?;
        let logs = self.query_all_logs_internal(&conn)?;
        let mut by_sym: std::collections::BTreeMap<String, (usize, Vec<String>)> =
            std::collections::BTreeMap::new();
        for l in logs {
            if l.account_mode != "Live" || l.venue != venue || l.environment != environment {
                continue;
            }
            let entry = by_sym.entry(l.symbol.to_uppercase()).or_insert((0, Vec::new()));
            entry.0 += 1;
            if (l.status == "NEW" || l.status == "PARTIALLY_FILLED")
                && !entry.1.contains(&l.order_id)
            {
                entry.1.push(l.order_id);
            }
        }
        let now_ms = Utc::now().timestamp_millis();
        let mut out = Vec::new();
        for (symbol, (count, stale_ids)) in by_sym {
            let in_cfg = configured.contains(&symbol);
            let mut kinds = Vec::new();
            if !stale_ids.is_empty() {
                kinds.push("stale_local_open_order".to_string());
            }
            if !in_cfg && count > 0 {
                kinds.push("db_unconfigured_pair".to_string());
            }
            if kinds.is_empty() {
                continue;
            }
            out.push(OrphanPairRecord {
                symbol: symbol.clone(),
                venue,
                environment: environment.to_string(),
                kinds,
                in_configured_pairs: in_cfg,
                exchange_open_orders_count: 0,
                exchange_algo_orders_count: 0,
                exchange_position_amt: 0.0,
                exchange_unrealized_pnl_usdt: 0.0,
                exchange_spot_free_balance: 0.0,
                exchange_spot_locked_balance: 0.0,
                local_db_order_count: count,
                local_stale_open_order_ids: stale_ids,
                summary: format!("{count} local DB record(s)"),
                detected_at_ms: now_ms,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_time_windows_and_sqlite_order_history_store_parity() {
        let now_ms = 1_763_400_000_000_i64;
        let spot_windows = build_sync_time_windows(crate::ExchangeVenue::Spot, SyncLookbackPreset::D7, now_ms);
        assert!(spot_windows.len() >= 7);
        for (start, end) in spot_windows {
            assert!(end - start < 86_400_000, "Spot window must be < 24h");
        }

        let fut_windows = build_sync_time_windows(crate::ExchangeVenue::Futures, SyncLookbackPreset::D30, now_ms);
        assert_eq!(fut_windows.len(), 5);
        for (start, end) in fut_windows {
            assert!(end - start <= 7 * 86_400_000, "Futures window must be <= 7d");
        }

        let tmp_path = std::env::temp_dir().join(format!(
            "apexrust-test-orders-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or(1)
        ));
        let store = OrderHistoryStore::new(&tmp_path).unwrap();
        let sample = OrderExecutionLog {
            id: "rust-ord-1".into(),
            order_id: "1001".into(),
            client_order_id: "apex_1001".into(),
            order_list_id: None,
            algo_id: None,
            algo_order_ids: None,
            symbol: "DOGEUSDT".into(),
            venue: crate::ExchangeVenue::Futures,
            environment: "Testnet".into(),
            account_mode: "Live".into(),
            source: "live_proxy".into(),
            lifecycle: "ENTRY".into(),
            side: Side::Long,
            binance_side: "BUY".into(),
            position_side: "BOTH".into(),
            order_type: "LIMIT".into(),
            orig_type: Some("LIMIT".into()),
            time_in_force: "GTC".into(),
            status: "NEW".into(),
            price: 0.35,
            avg_price: 0.0,
            stop_price: 0.0,
            activate_price: None,
            price_rate: None,
            executed_qty: 0.0,
            orig_qty: 100.0,
            quote_qty: 0.0,
            commission: 0.0,
            commission_asset: "USDT".into(),
            is_maker: true,
            reduce_only: false,
            close_position: false,
            price_protect: false,
            working_type: Some("MARK_PRICE".into()),
            self_trade_prevention_mode: Some("NONE".into()),
            realized_pnl_usdt: None,
            r_multiple: None,
            exit_reason: None,
            latency_ms: Some(15),
            endpoint: "POST /fapi/v1/order".into(),
            rationale: "test".into(),
            error_message: None,
            order_time_ms: now_ms,
            update_time_ms: now_ms,
            working_time_ms: None,
            timestamp_ms: now_ms,
        };
        store.upsert_logs(&[sample]).unwrap();
        let summary = store.summary().unwrap();
        assert_eq!(summary.live_count, 1);

        // Verify serde reads both "Futures" (TypeScript) and "futures" (legacy Rust) identically
        let serialized = serde_json::to_string(&store.query_logs(10).unwrap()[0]).unwrap();
        assert!(serialized.contains("\"venue\":\"Futures\""));
        let legacy_json = serialized.replace("\"venue\":\"Futures\"", "\"venue\":\"futures\"");
        let parsed_legacy: OrderExecutionLog = serde_json::from_str(&legacy_json).unwrap();
        assert_eq!(parsed_legacy.venue, crate::ExchangeVenue::Futures);

        let orphans = store
            .detect_local_orphans(
                &["BTCUSDT".to_string()],
                crate::ExchangeVenue::Futures,
                "Testnet",
            )
            .unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].symbol, "DOGEUSDT");
        assert!(orphans[0].kinds.contains(&"stale_local_open_order".to_string()));
        assert!(orphans[0].kinds.contains(&"db_unconfigured_pair".to_string()));

        let deleted = store.delete_logs(Some("Live"), Some("DOGEUSDT"), None, now_ms).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(store.summary().unwrap().total_count, 0);

        let _ = std::fs::remove_file(&tmp_path);
        let _ = std::fs::remove_file(format!("{}-wal", tmp_path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", tmp_path.display()));
    }

    #[test]
    fn side_deserializes_case_variants() {
        for raw in ["\"Long\"", "\"long\"", "\"LONG\""] {
            let parsed: Side = serde_json::from_str(raw).unwrap();
            assert_eq!(parsed, Side::Long);
        }
        for raw in ["\"Short\"", "\"short\"", "\"SHORT\""] {
            let parsed: Side = serde_json::from_str(raw).unwrap();
            assert_eq!(parsed, Side::Short);
        }
    }
}
