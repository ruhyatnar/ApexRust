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
        if self.trading.initial_equity_usdt <= 0.0 || !self.trading.initial_equity_usdt.is_finite() {
            return Err(crate::BotError::Config("trading.initial_equity_usdt must be > 0".into()));
        }
        if self.trading.max_concurrent_positions == 0 {
            return Err(crate::BotError::Config("trading.max_concurrent_positions must be > 0".into()));
        }
        if self.exits.atr_sl_multiplier <= 0.0 {
            return Err(crate::BotError::Config("exits.atr_sl_multiplier must be > 0".into()));
        }
        if !(0.0..=1.0).contains(&self.exits.tp1_close_ratio) || self.exits.tp1_close_ratio <= 0.0 {
            return Err(crate::BotError::Config("exits.tp1_close_ratio must be in (0, 1]".into()));
        }
        if self.risk.max_daily_drawdown_pct <= 0.0 || self.risk.max_pair_daily_drawdown_pct <= 0.0 {
            return Err(crate::BotError::Config("Drawdown limits must be positive".into()));
        }
        if self.exchange.rest_poll_interval_ms == 0 || self.exchange.ws_reconnect_initial_ms == 0 {
            return Err(crate::BotError::Config("Exchange poll and reconnect intervals must be > 0 ms".into()));
        }
        for win in &self.automation.session_windows {
            if parse_utc_hhmm_minutes(&win.start_utc).is_none()
                || parse_utc_hhmm_minutes(&win.end_utc).is_none()
            {
                return Err(crate::BotError::Config(format!(
                    "Invalid HH:MM UTC session window '{}' ({}-{})",
                    win.id, win.start_utc, win.end_utc
                )));
            }
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
    #[serde(rename = "LIMIT_MAKER", alias = "LIMITMAKER")]
    LimitMaker,
    Oco,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PositionSizingMode {
    #[default]
    FixedUsdt,
    FixedRiskPct,
    QuarterKelly,
    HalfKelly,
    FullKelly,
}

fn default_time_in_force() -> String {
    "GTC".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UtcSessionWindow {
    pub id: String,
    pub label: String,
    pub start_utc: String,
    pub end_utc: String,
    pub enabled: bool,
}

fn default_session_windows() -> Vec<UtcSessionWindow> {
    vec![
        UtcSessionWindow {
            id: "london-open".into(),
            label: "London Open".into(),
            start_utc: "07:00".into(),
            end_utc: "11:00".into(),
            enabled: true,
        },
        UtcSessionWindow {
            id: "london-ny-overlap".into(),
            label: "London / NY Overlap".into(),
            start_utc: "12:30".into(),
            end_utc: "16:30".into(),
            enabled: true,
        },
        UtcSessionWindow {
            id: "us-close-auction".into(),
            label: "US Equities Close".into(),
            start_utc: "19:00".into(),
            end_utc: "21:00".into(),
            enabled: false,
        },
    ]
}

fn parse_utc_hhmm_minutes(hhmm: &str) -> Option<u32> {
    let mut parts = hhmm.trim().split(':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationConfig {
    pub enabled: bool,
    pub strategy_profile: StrategyProfile,
    pub direction_policy: DirectionPolicy,
    pub order_method: OrderExecutionMethod,
    pub limit_offset_bps: f64,
    #[serde(default = "default_time_in_force")]
    pub time_in_force: String,
    pub signal_cooldown_bars: u32,
    pub auto_order_notional_usdt: f64,
    pub auto_close_on_exit: bool,
    #[serde(default = "default_session_windows")]
    pub session_windows: Vec<UtcSessionWindow>,
}

impl AutomationConfig {
    /// Returns true if `now` falls inside at least one enabled daily UTC liquidity window.
    pub fn is_within_session_windows(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        use chrono::Timelike;
        let minute_of_day = now.hour() * 60 + now.minute();
        let enabled: Vec<&UtcSessionWindow> =
            self.session_windows.iter().filter(|w| w.enabled).collect();
        if enabled.is_empty() {
            return false;
        }
        for win in enabled {
            if let (Some(start), Some(end)) = (
                parse_utc_hhmm_minutes(&win.start_utc),
                parse_utc_hhmm_minutes(&win.end_utc),
            ) {
                let inside = if start == end {
                    true
                } else if start < end {
                    minute_of_day >= start && minute_of_day < end
                } else {
                    minute_of_day >= start || minute_of_day < end
                };
                if inside {
                    return true;
                }
            }
        }
        false
    }
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strategy_profile: StrategyProfile::TrendPullback,
            direction_policy: DirectionPolicy::LongOnly,
            order_method: OrderExecutionMethod::Market,
            limit_offset_bps: 5.0,
            time_in_force: "GTC".into(),
            signal_cooldown_bars: 2,
            auto_order_notional_usdt: 150.0,
            auto_close_on_exit: true,
            session_windows: default_session_windows(),
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
    #[serde(default)]
    pub volume_confirmation_filter: bool,
    #[serde(default)]
    pub session_window_filter: bool,
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
            volume_confirmation_filter: false,
            session_window_filter: false,
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
    #[serde(default)]
    pub position_sizing_mode: PositionSizingMode,
    pub initial_equity_usdt: f64,
    pub taker_fee_bps: f64,
}

fn default_true() -> bool {
    true
}
fn default_min_volume_expansion_mult() -> f64 {
    1.5
}
fn default_atr_spike_pct_threshold() -> f64 {
    0.45
}
fn default_atr_expansion_ratio_threshold() -> f64 {
    1.25
}
fn default_volatility_alert_cooldown_sec() -> u64 {
    60
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
    #[serde(default = "default_min_volume_expansion_mult")]
    pub min_volume_expansion_mult: f64,
    #[serde(default = "default_true")]
    pub volatility_alerts_enabled: bool,
    #[serde(default = "default_atr_spike_pct_threshold")]
    pub atr_spike_pct_threshold: f64,
    #[serde(default = "default_atr_expansion_ratio_threshold")]
    pub atr_expansion_ratio_threshold: f64,
    #[serde(default = "default_volatility_alert_cooldown_sec")]
    pub volatility_alert_cooldown_sec: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_maker_serde_and_config_validation() {
        assert_eq!(
            serde_json::to_string(&OrderExecutionMethod::LimitMaker).unwrap(),
            "\"LIMIT_MAKER\""
        );
        assert_eq!(
            serde_json::from_str::<OrderExecutionMethod>("\"LIMIT_MAKER\"").unwrap(),
            OrderExecutionMethod::LimitMaker
        );
        assert_eq!(
            serde_json::from_str::<OrderExecutionMethod>("\"LIMITMAKER\"").unwrap(),
            OrderExecutionMethod::LimitMaker
        );

        let base = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        assert!(base.validate().is_ok());

        let mut bad_eq = base.clone();
        bad_eq.trading.initial_equity_usdt = 0.0;
        assert!(bad_eq.validate().is_err());

        let mut bad_pos = base.clone();
        bad_pos.trading.max_concurrent_positions = 0;
        assert!(bad_pos.validate().is_err());

        let mut bad_tp = base.clone();
        bad_tp.exits.tp1_close_ratio = 0.0;
        assert!(bad_tp.validate().is_err());

        let mut bad_win = base;
        bad_win.automation.session_windows.push(UtcSessionWindow {
            id: "bad".into(),
            label: "bad".into(),
            start_utc: "25:99".into(),
            end_utc: "23:59".into(),
            enabled: true,
        });
        assert!(bad_win.validate().is_err());
    }
}
