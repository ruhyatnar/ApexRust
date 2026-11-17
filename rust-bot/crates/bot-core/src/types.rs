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
    pub rsi: Option<f64>,
    pub prev_rsi: Option<f64>,
    pub adx: Option<f64>,
    pub plus_di: Option<f64>,
    pub minus_di: Option<f64>,
    pub atr: Option<f64>,
    pub vwap: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Long,
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

/// Active ATR-driven exit brackets attached to every open position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitPlan {
    pub initial_stop_loss: f64,
    pub active_stop_loss: f64,
    pub take_profit_1: f64,
    pub take_profit_2: f64,
    pub tp1_hit: bool,
    pub break_even_armed: bool,
    pub trailing_active: bool,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSnapshot {
    pub symbol: String,
    pub last_price: f64,
    pub daily_pnl_usdt: f64,
    pub daily_pnl_pct: f64,
    pub indicators: IndicatorSnapshot,
    pub open_position: Option<Position>,
}

/// Complete immutable snapshot streamed to WebApp clients (`bot-web`) and Desktop UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSnapshot {
    pub running: bool,
    pub transport_mode: TransportMode,
    pub failover_count: u64,
    pub last_ws_age_ms: u64,
    pub risk: RiskStatus,
    pub pairs: Vec<PairSnapshot>,
    pub recent_trades: Vec<ClosedTrade>,
    pub updated_at: DateTime<Utc>,
}
