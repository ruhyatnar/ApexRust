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
    #[serde(default)]
    pub automation: AutomationConfig,
    #[serde(default)]
    pub features: FeatureToggles,
    #[serde(default)]
    pub git_backup: GitBackupConfig,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExchangeVenue {
    #[default]
    Spot,
    Futures,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum MarginType {
    #[default]
    Isolated,
    Crossed,
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
    #[serde(default)]
    pub venue: ExchangeVenue,
    #[serde(default = "default_leverage")]
    pub leverage: u8,
    #[serde(default)]
    pub margin_type: MarginType,
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

fn default_leverage() -> u8 {
    3
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrategyMode {
    Scalping,
    Intraday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StrategyProfile {
    #[default]
    TrendPullback,
    EmaBreakout,
    VwapReversion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DirectionPolicy {
    #[default]
    LongOnly,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderExecutionMethod {
    #[default]
    Market,
    Limit,
    LimitMaker,
    Oco,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationConfig {
    pub enabled: bool,
    pub strategy_profile: StrategyProfile,
    pub direction_policy: DirectionPolicy,
    pub order_method: OrderExecutionMethod,
    pub limit_offset_bps: f64,
    pub signal_cooldown_bars: u32,
    pub auto_order_notional_usdt: f64,
    pub auto_close_on_exit: bool,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strategy_profile: StrategyProfile::TrendPullback,
            direction_policy: DirectionPolicy::LongOnly,
            order_method: OrderExecutionMethod::Market,
            limit_offset_bps: 5.0,
            signal_cooldown_bars: 2,
            auto_order_notional_usdt: 150.0,
            auto_close_on_exit: true,
        }
    }
}

/// Granular runtime feature toggles enabling operators to switch any subsystem independently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureToggles {
    pub automated_trading: bool,
    pub manual_trading: bool,
    pub signal_generator: bool,
    pub ws_primary_feed: bool,
    pub rest_fallback: bool,
    pub ema_trend_filter: bool,
    pub rsi_momentum_filter: bool,
    pub adx_strength_filter: bool,
    pub vwap_bias_filter: bool,
    pub atr_dynamic_exits: bool,
    pub take_profit_ladder: bool,
    pub break_even_stop: bool,
    pub trailing_stop: bool,
    pub circuit_breaker: bool,
    pub spot_market: bool,
    pub futures_market: bool,
    pub git_auto_backup: bool,
}

impl Default for FeatureToggles {
    fn default() -> Self {
        Self {
            automated_trading: true,
            manual_trading: true,
            signal_generator: true,
            ws_primary_feed: true,
            rest_fallback: true,
            ema_trend_filter: true,
            rsi_momentum_filter: true,
            adx_strength_filter: true,
            vwap_bias_filter: true,
            atr_dynamic_exits: true,
            take_profit_ladder: true,
            break_even_stop: true,
            trailing_stop: true,
            circuit_breaker: true,
            spot_market: true,
            futures_market: true,
            git_auto_backup: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBackupConfig {
    pub enabled: bool,
    pub remote_name: String,
    pub branch: String,
    pub auto_push: bool,
    pub backup_dir: String,
}

impl Default for GitBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            remote_name: "origin".into(),
            branch: "main".into(),
            auto_push: false,
            backup_dir: "backups".into(),
        }
    }
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
