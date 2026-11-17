use serde::{Deserialize, Serialize};
use std::path::Path;

/// High-level root configuration loaded from `bot.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub exchange: ExchangeConfig,
    pub trading: TradingConfig,
    pub indicators: IndicatorConfig,
    pub exits: ExitConfig,
    pub risk: RiskConfig,
    pub web: WebConfig,
}

impl BotConfig {
    /// Load and validate configuration from a TOML file on disk.
    pub fn from_toml_file(path: impl AsRef<Path>) -> crate::Result<Self> {
        let raw = std::fs::read_to_string(path.as_ref())
            .map_err(|e| crate::BotError::Config(format!("Failed to read config: {e}")))?;
        let cfg: Self = toml::from_str(&raw)
            .map_err(|e| crate::BotError::Config(format!("Invalid TOML config: {e}")))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Perform invariant checks before the trading engine boots.
    pub fn validate(&self) -> crate::Result<()> {
        if self.trading.pairs.is_empty() {
            return Err(crate::BotError::Config("trading.pairs must not be empty".into()));
        }
        if self.exits.atr_sl_multiplier <= 0.0 {
            return Err(crate::BotError::Config("exits.atr_sl_multiplier must be > 0".into()));
        }
        if self.risk.max_daily_drawdown_pct <= 0.0 || self.risk.max_pair_daily_drawdown_pct <= 0.0 {
            return Err(crate::BotError::Config("Drawdown limits must be positive".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExchangeEnvironment {
    Testnet,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    HmacSha256,
    Ed25519,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveCredentialsConfig {
    pub auth_method: AuthMethod,
    pub api_key_env: String,
    pub api_secret_env: String,
    pub ed25519_key_path: Option<String>,
    pub recv_window_ms: u64,
    pub max_order_notional_usdt: f64,
    pub require_preflight_test_order: bool,
    pub armed_for_live_orders: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeConfig {
    pub environment: ExchangeEnvironment,
    pub paper_trading: bool,
    pub credentials: Option<LiveCredentialsConfig>,
    pub ws_stream_url: String,
    pub ws_api_url: String,
    pub rest_base_url: String,
    pub ws_heartbeat_timeout_ms: u64,
    pub rest_poll_interval_ms: u64,
    pub ws_reconnect_initial_ms: u64,
    pub ws_reconnect_max_ms: u64,
    pub max_consecutive_rest_failures: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrategyMode {
    Scalping,
    Intraday,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingConfig {
    pub mode: StrategyMode,
    pub timeframe: String,
    pub pairs: Vec<String>,
    pub max_concurrent_positions: usize,
    pub base_risk_per_trade_pct: f64,
    pub initial_equity_usdt: f64,
    pub taker_fee_bps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndicatorConfig {
    pub ema_fast: usize,
    pub ema_mid: usize,
    pub ema_slow: usize,
    pub ema_macro: usize,
    pub rsi_period: usize,
    pub rsi_long_pullback_min: f64,
    pub rsi_long_pullback_max: f64,
    pub rsi_short_pullback_min: f64,
    pub rsi_short_pullback_max: f64,
    pub adx_period: usize,
    pub adx_min_trend: f64,
    pub atr_period: usize,
    pub require_vwap_alignment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitConfig {
    pub atr_sl_multiplier: f64,
    pub atr_tp1_multiplier: f64,
    pub atr_tp2_multiplier: f64,
    pub tp1_close_ratio: f64,
    pub break_even_trigger_r: f64,
    pub break_even_fee_buffer_bps: f64,
    pub trailing_activation_r: f64,
    pub atr_trailing_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    pub max_daily_drawdown_pct: f64,
    pub max_pair_daily_drawdown_pct: f64,
    pub max_daily_profit_pct: f64,
    pub max_win_streak: u32,
    pub max_lose_streak: u32,
    pub streak_cooldown_minutes: u64,
    pub flatten_on_circuit_breaker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebConfig {
    pub bind_addr: String,
    pub allowed_origin: String,
}
