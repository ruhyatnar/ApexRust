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
        if self.trading.pairs.is_empty() && self.trading.pair_selection_mode != PairSelectionMode::Dynamic {
            return Err(crate::BotError::Config("trading.pairs must not be empty unless pair_selection_mode = dynamic".into()));
        }
        if self.trading.max_watchlist_pairs == 0 || self.trading.max_watchlist_pairs > 40 {
            return Err(crate::BotError::Config("trading.max_watchlist_pairs must be in 1..=40".into()));
        }
        if self.exchange.leverage == 0 || self.exchange.leverage > 20 {
            return Err(crate::BotError::Config("exchange.leverage must be in 1..=20".into()));
        }
        if self.exchange.max_leverage == 0 || self.exchange.max_leverage > 20 {
            return Err(crate::BotError::Config(
                "exchange.max_leverage must be in 1..=20".into(),
            ));
        }
        if self.exchange.leverage > self.exchange.max_leverage {
            return Err(crate::BotError::Config(format!(
                "exchange.leverage ({}) exceeds exchange.max_leverage ({})",
                self.exchange.leverage, self.exchange.max_leverage
            )));
        }
        if self.exchange.ws_heartbeat_timeout_ms == 0 {
            return Err(crate::BotError::Config("exchange.ws_heartbeat_timeout_ms must be > 0".into()));
        }
        if self.trading.initial_equity_usdt <= 0.0 || !self.trading.initial_equity_usdt.is_finite() {
            return Err(crate::BotError::Config("trading.initial_equity_usdt must be > 0".into()));
        }
        if self.trading.base_risk_per_trade_pct <= 0.0 || !self.trading.base_risk_per_trade_pct.is_finite() {
            return Err(crate::BotError::Config("trading.base_risk_per_trade_pct must be > 0".into()));
        }
        if self.trading.max_concurrent_positions == 0 {
            return Err(crate::BotError::Config("trading.max_concurrent_positions must be > 0".into()));
        }
        if self.exits.atr_sl_multiplier <= 0.0
            || self.exits.atr_tp1_multiplier <= 0.0
            || self.exits.atr_tp2_multiplier <= 0.0
            || self.exits.atr_trailing_multiplier <= 0.0
        {
            return Err(crate::BotError::Config("Exit ATR multipliers must all be > 0".into()));
        }
        if !(0.0..=1.0).contains(&self.exits.tp1_close_ratio) || self.exits.tp1_close_ratio <= 0.0 {
            return Err(crate::BotError::Config("exits.tp1_close_ratio must be in (0, 1]".into()));
        }
        if self.risk.max_daily_drawdown_pct <= 0.0
            || self.risk.max_pair_daily_drawdown_pct <= 0.0
            || self.risk.max_daily_profit_pct <= 0.0
            || !self.risk.max_daily_profit_pct.is_finite()
        {
            return Err(crate::BotError::Config("Drawdown and profit limits must be positive".into()));
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
        self.web.validate_bind_safety()?;
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
    /// Hard ceiling applied to `leverage` on every config, TOML and order path.
    #[serde(default = "default_leverage")]
    pub max_leverage: u8,
    #[serde(default)]
    pub margin_type: MarginType,
    pub paper_trading: bool,
    pub credentials: Option<LiveCredentialsConfig>,
    pub ws_stream_url: String,
    /// Binance WebSocket API endpoint used for `session.logon` / `order.place`.
    #[serde(default)]
    pub ws_api_url: String,
    /// Route entry orders over the WebSocket API when credentials allow it.
    #[serde(default)]
    pub use_ws_api_orders: bool,
    /// Subscribe to `<symbol>@depth10@100ms` for the order-book imbalance gate.
    /// Derived at boot from `features.obi_entry_filter`.
    #[serde(default)]
    pub depth_stream_enabled: bool,
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

/// Effective leverage after the hard `max_leverage` ceiling.
impl ExchangeConfig {
    pub fn effective_leverage(&self) -> u8 {
        self.leverage.min(self.max_leverage.max(1)).clamp(1, 20)
    }
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
    ShortOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PairSelectionMode {
    Static,
    #[default]
    Hybrid,
    Dynamic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TrendingCategory {
    #[default]
    HotVolume,
    TopGainers,
    TopLosers,
    VolatilityLeaders,
    CtsMomentum,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TrendingRankingSource {
    #[default]
    Auto,
    Production,
    Environment,
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

fn default_max_pending_order_bars() -> u32 {
    6
}
fn default_max_pending_runaway_atr() -> f64 {
    1.8
}
fn default_exhaustion_min_profit_r() -> f64 {
    1.0
}
fn default_exhaustion_trail_factor() -> f64 {
    0.55
}
fn default_exhaustion_rsi_high() -> f64 {
    76.0
}
fn default_exhaustion_rsi_low() -> f64 {
    24.0
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
    #[serde(default = "default_true")]
    pub cancel_pending_on_signal_reversal: bool,
    #[serde(default = "default_true")]
    pub cancel_pending_on_exhaustion: bool,
    #[serde(default = "default_max_pending_order_bars")]
    pub max_pending_order_bars: u32,
    #[serde(default = "default_max_pending_runaway_atr")]
    pub max_pending_runaway_atr: f64,
    #[serde(default)]
    pub apply_dynamic_cancel_to_manual_orders: bool,
    #[serde(default = "default_true")]
    pub exit_position_on_signal_reversal: bool,
    #[serde(default = "default_true")]
    pub tighten_trailing_on_exhaustion: bool,
    #[serde(default = "default_exhaustion_min_profit_r")]
    pub exhaustion_min_profit_r: f64,
    #[serde(default = "default_exhaustion_trail_factor")]
    pub exhaustion_trail_factor: f64,
    #[serde(default = "default_exhaustion_rsi_high")]
    pub exhaustion_rsi_high: f64,
    #[serde(default = "default_exhaustion_rsi_low")]
    pub exhaustion_rsi_low: f64,
    #[serde(default)]
    pub auto_flip_on_reversal: bool,
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
            cancel_pending_on_signal_reversal: true,
            cancel_pending_on_exhaustion: true,
            max_pending_order_bars: 6,
            max_pending_runaway_atr: 1.8,
            apply_dynamic_cancel_to_manual_orders: false,
            exit_position_on_signal_reversal: true,
            tighten_trailing_on_exhaustion: true,
            exhaustion_min_profit_r: 1.0,
            exhaustion_trail_factor: 0.55,
            exhaustion_rsi_high: 76.0,
            exhaustion_rsi_low: 24.0,
            auto_flip_on_reversal: false,
        }
    }
}

fn default_true_toggle() -> bool {
    true
}

/// Granular runtime feature toggles enabling operators to switch any subsystem independently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureToggles {
    #[serde(default = "default_true_toggle")]
    pub automated_trading: bool,
    #[serde(default = "default_true_toggle")]
    pub manual_trading: bool,
    #[serde(default = "default_true_toggle")]
    pub signal_generator: bool,
    #[serde(default = "default_true_toggle")]
    pub ws_primary_feed: bool,
    #[serde(default = "default_true_toggle")]
    pub rest_fallback: bool,
    #[serde(default = "default_true_toggle")]
    pub ema_trend_filter: bool,
    #[serde(default = "default_true_toggle")]
    pub rsi_momentum_filter: bool,
    #[serde(default = "default_true_toggle")]
    pub adx_strength_filter: bool,
    #[serde(default = "default_true_toggle")]
    pub vwap_bias_filter: bool,
    #[serde(default)]
    pub volume_confirmation_filter: bool,
    #[serde(default)]
    pub htf_trend_filter: bool,
    #[serde(default)]
    pub obi_entry_filter: bool,
    #[serde(default)]
    pub session_window_filter: bool,
    #[serde(default = "default_true_toggle")]
    pub atr_dynamic_exits: bool,
    #[serde(default = "default_true_toggle")]
    pub take_profit_ladder: bool,
    #[serde(default = "default_true_toggle")]
    pub break_even_stop: bool,
    #[serde(default = "default_true_toggle")]
    pub trailing_stop: bool,
    #[serde(default = "default_true_toggle")]
    pub circuit_breaker: bool,
    #[serde(default = "default_true_toggle")]
    pub spot_market: bool,
    #[serde(default = "default_true_toggle")]
    pub futures_market: bool,
    #[serde(default)]
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
            htf_trend_filter: false,
            obi_entry_filter: false,
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

fn default_quote_asset() -> String {
    "USDT".into()
}
fn default_max_watchlist_pairs() -> usize {
    20
}
fn default_trending_top_n() -> usize {
    5
}
fn default_trending_min_quote_volume_usdt() -> f64 {
    10_000_000.0
}
fn default_trending_min_dwell_minutes() -> u64 {
    15
}
fn default_trending_hysteresis_rank_buffer() -> usize {
    3
}
fn default_max_same_direction_positions() -> usize {
    2
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
    #[serde(default)]
    pub pair_selection_mode: PairSelectionMode,
    #[serde(default = "default_quote_asset")]
    pub quote_asset: String,
    #[serde(default = "default_max_watchlist_pairs")]
    pub max_watchlist_pairs: usize,
    #[serde(default)]
    pub trending_category: TrendingCategory,
    #[serde(default = "default_trending_top_n")]
    pub trending_top_n: usize,
    #[serde(default = "default_trending_min_quote_volume_usdt")]
    pub trending_min_quote_volume_usdt: f64,
    #[serde(default = "default_trending_min_dwell_minutes")]
    pub trending_min_dwell_minutes: u64,
    #[serde(default = "default_trending_hysteresis_rank_buffer")]
    pub trending_hysteresis_rank_buffer: usize,
    #[serde(default)]
    pub ranking_source: TrendingRankingSource,
    #[serde(default = "default_max_same_direction_positions")]
    pub max_same_direction_positions: usize,
    #[serde(default)]
    pub cts_screener_enabled: bool,
    #[serde(default = "default_cts_rvol_weight")]
    pub cts_rvol_weight: f64,
    #[serde(default = "default_cts_momentum_weight")]
    pub cts_momentum_weight: f64,
    #[serde(default = "default_cts_volume_weight")]
    pub cts_volume_weight: f64,
    #[serde(default = "default_cts_min_rvol")]
    pub cts_min_rvol: f64,
}

fn default_cts_rvol_weight() -> f64 {
    0.4
}
fn default_cts_momentum_weight() -> f64 {
    0.4
}
fn default_cts_volume_weight() -> f64 {
    0.2
}
fn default_cts_min_rvol() -> f64 {
    1.2
}

impl Default for TradingConfig {
    fn default() -> Self {
        Self {
            mode: StrategyMode::Scalping,
            timeframe: "5m".into(),
            pairs: vec![
                "BTCUSDT".into(),
                "ETHUSDT".into(),
                "SOLUSDT".into(),
                "BNBUSDT".into(),
                "AVAXUSDT".into(),
            ],
            max_concurrent_positions: 3,
            base_risk_per_trade_pct: 0.75,
            position_sizing_mode: PositionSizingMode::FixedUsdt,
            initial_equity_usdt: 10_000.0,
            taker_fee_bps: 10.0,
            pair_selection_mode: PairSelectionMode::Hybrid,
            quote_asset: "USDT".into(),
            max_watchlist_pairs: 20,
            trending_category: TrendingCategory::HotVolume,
            trending_top_n: 5,
            trending_min_quote_volume_usdt: 10_000_000.0,
            trending_min_dwell_minutes: 15,
            trending_hysteresis_rank_buffer: 3,
            ranking_source: TrendingRankingSource::Auto,
            max_same_direction_positions: 2,
            cts_screener_enabled: false,
            cts_rvol_weight: 0.4,
            cts_momentum_weight: 0.4,
            cts_volume_weight: 0.2,
            cts_min_rvol: 1.2,
        }
    }
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
fn default_min_warmup_bars() -> usize {
    50
}
fn default_max_ema_mid_extension_atr() -> f64 {
    2.2
}
fn default_max_vwap_extension_atr() -> f64 {
    2.8
}
fn default_min_close_strength_ratio() -> f64 {
    0.55
}
fn default_min_candle_body_ratio() -> f64 {
    0.30
}
fn default_min_di_spread() -> f64 {
    3.0
}
fn default_max_spread_bps() -> f64 {
    20.0
}
fn default_donchian_lookback() -> usize {
    20
}
fn default_atr_expansion_min_ratio() -> f64 {
    1.15
}
fn default_htf_ema_period() -> usize {
    200
}
fn default_obi_levels() -> usize {
    10
}
fn default_obi_min_imbalance() -> f64 {
    0.35
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
    #[serde(default = "default_min_warmup_bars")]
    pub min_warmup_bars: usize,
    #[serde(default = "default_max_ema_mid_extension_atr")]
    pub max_ema_mid_extension_atr: f64,
    #[serde(default = "default_max_vwap_extension_atr")]
    pub max_vwap_extension_atr: f64,
    #[serde(default = "default_min_close_strength_ratio")]
    pub min_close_strength_ratio: f64,
    #[serde(default = "default_min_candle_body_ratio")]
    pub min_candle_body_ratio: f64,
    #[serde(default = "default_true")]
    pub require_rising_adx: bool,
    #[serde(default = "default_min_di_spread")]
    pub min_di_spread: f64,
    #[serde(default = "default_true")]
    pub require_macro_ema_in_scalping: bool,
    #[serde(default = "default_max_spread_bps")]
    pub max_spread_bps: f64,
    #[serde(default = "default_donchian_lookback")]
    pub donchian_lookback: usize,
    #[serde(default)]
    pub atr_expansion_filter_enabled: bool,
    #[serde(default = "default_atr_expansion_min_ratio")]
    pub atr_expansion_min_ratio: f64,
    #[serde(default = "default_htf_ema_period")]
    pub htf_ema_period: usize,
    #[serde(default = "default_obi_levels")]
    pub obi_levels: usize,
    #[serde(default = "default_obi_min_imbalance")]
    pub obi_min_imbalance: f64,
}

impl Default for IndicatorConfig {
    fn default() -> Self {
        Self {
            ema_fast: 9,
            ema_mid: 21,
            ema_slow: 50,
            ema_macro: 200,
            rsi_period: 14,
            rsi_long_pullback_min: 42.0,
            rsi_long_pullback_max: 58.0,
            rsi_short_pullback_min: 42.0,
            rsi_short_pullback_max: 58.0,
            adx_period: 14,
            adx_min_trend: 25.0,
            atr_period: 14,
            require_vwap_alignment: true,
            min_volume_expansion_mult: 1.5,
            volatility_alerts_enabled: true,
            atr_spike_pct_threshold: 0.45,
            atr_expansion_ratio_threshold: 1.25,
            volatility_alert_cooldown_sec: 60,
            min_warmup_bars: 50,
            max_ema_mid_extension_atr: 2.2,
            max_vwap_extension_atr: 2.8,
            min_close_strength_ratio: 0.55,
            min_candle_body_ratio: 0.30,
            require_rising_adx: true,
            min_di_spread: 3.0,
            require_macro_ema_in_scalping: true,
            max_spread_bps: 20.0,
            donchian_lookback: 20,
            atr_expansion_filter_enabled: false,
            atr_expansion_min_ratio: 1.15,
            htf_ema_period: 200,
            obi_levels: 10,
            obi_min_imbalance: 0.35,
        }
    }
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
    /// Block new entries when BTC drops faster than the threshold inside the window.
    #[serde(default = "default_true")]
    pub btc_crash_guard_enabled: bool,
    #[serde(default = "default_btc_crash_threshold_pct")]
    pub btc_crash_threshold_pct: f64,
    #[serde(default = "default_btc_crash_window_minutes")]
    pub btc_crash_window_minutes: u64,
    /// Fail open after this many seconds without a fresh BTC price sample.
    #[serde(default = "default_btc_crash_max_staleness_sec")]
    pub btc_crash_max_staleness_sec: u64,
}

fn default_btc_crash_threshold_pct() -> f64 {
    1.5
}
fn default_btc_crash_window_minutes() -> u64 {
    15
}
fn default_btc_crash_max_staleness_sec() -> u64 {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebConfig {
    pub bind_addr: String,
    pub allowed_origin: String,
    #[serde(default)]
    pub auth_token: String,
}

impl WebConfig {
    /// Resolve active authentication token (`APEXRUST_WEB_TOKEN` or `APEXRUST_ENGINE_TOKEN` env overrides `web.auth_token`).
    pub fn resolved_auth_token(&self) -> Option<String> {
        if let Ok(env_tok) = std::env::var("APEXRUST_WEB_TOKEN") {
            let trimmed = env_tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Ok(env_tok) = std::env::var("APEXRUST_ENGINE_TOKEN") {
            let trimmed = env_tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        let trimmed = self.auth_token.trim();
        if !trimmed.is_empty() {
            Some(trimmed.to_string())
        } else {
            None
        }
    }

    pub fn validate_bind_safety(&self) -> crate::Result<()> {
        let bind = self.bind_addr.trim();
        let token = self.resolved_auth_token();
        if let Some(ref t) = token {
            if t.len() < 32 {
                return Err(crate::BotError::Config(
                    "web.auth_token / APEXRUST_WEB_TOKEN must be at least 32 characters when set".into(),
                ));
            }
        }
        if bind.is_empty() || is_private_or_zero_trust_bind_addr(bind) {
            return Ok(());
        }
        let trust_mesh = std::env::var("APEXRUST_TRUST_ZERO_TRUST_MESH")
            .ok()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"));
        if trust_mesh || token.as_ref().is_some_and(|t| t.len() >= 32) {
            return Ok(());
        }
        Err(crate::BotError::Config(format!(
            "Refusing to bind non-private web.bind_addr '{}' without a >= 32 character APEXRUST_WEB_TOKEN or web.auth_token (use 127.0.0.1:8080 or Cloudflare One WARP IP 100.96.x.y:8080)",
            bind
        )))
    }
}

/// Returns true if the `host:port` or `host` string targets loopback (`127.0.0.0/8`, `::1`, `localhost`),
/// RFC1918 private IPs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), or CGNAT / Cloudflare One WARP mesh (`100.64.0.0/10`).
pub fn is_private_or_zero_trust_bind_addr(raw: &str) -> bool {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() {
        return true;
    }
    let host = if trimmed.starts_with('[') {
        trimmed
            .find(']')
            .map(|idx| &trimmed[1..idx])
            .unwrap_or(trimmed.as_str())
    } else if let Some((h, _port)) = trimmed.rsplit_once(':') {
        if h.contains(':') {
            trimmed.as_str()
        } else {
            h
        }
    } else {
        trimmed.as_str()
    };
    if host == "localhost" {
        return true;
    }
    if host == "0.0.0.0" || host == "::" {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let is_priv_v4 = |v4: std::net::Ipv4Addr| {
            let [a, b, _, _] = v4.octets();
            if a == 0 {
                return false;
            }
            a == 127
                || a == 10
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
        };
        return match ip {
            std::net::IpAddr::V4(v4) => is_priv_v4(v4),
            std::net::IpAddr::V6(v6) => {
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return is_priv_v4(mapped);
                }
                if v6.is_loopback() {
                    return true;
                }
                if v6.is_unspecified() {
                    return false;
                }
                let seg0 = v6.segments()[0];
                // IPv6 ULA fc00::/7 or link-local fe80::/10
                (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
            }
        };
    }
    host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".ts.net")
        || host.ends_with(".cfargotunnel.com")
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

    #[test]
    fn cloudflare_zero_trust_and_web_bind_safety_validation() {
        assert!(is_private_or_zero_trust_bind_addr("127.0.0.1:8080"));
        assert!(is_private_or_zero_trust_bind_addr("localhost:8080"));
        assert!(is_private_or_zero_trust_bind_addr("100.96.1.10:8080"));
        assert!(is_private_or_zero_trust_bind_addr("10.1.2.3:8080"));
        assert!(!is_private_or_zero_trust_bind_addr("0.0.0.0:8080"));
        assert!(!is_private_or_zero_trust_bind_addr("203.0.113.10:8080"));
        assert!(!is_private_or_zero_trust_bind_addr("fc-public.example.com:8080"));
        assert!(is_private_or_zero_trust_bind_addr("[::ffff:127.0.0.1]:8080"));
        assert!(is_private_or_zero_trust_bind_addr("[fd12:3456:789a::1]:8080"));

        let safe_loopback = WebConfig {
            bind_addr: "127.0.0.1:8080".into(),
            allowed_origin: "http://localhost:3000".into(),
            auth_token: "".into(),
        };
        assert!(safe_loopback.validate_bind_safety().is_ok());

        let safe_cf_warp = WebConfig {
            bind_addr: "100.96.5.20:8080".into(),
            allowed_origin: "http://localhost:3000".into(),
            auth_token: "".into(),
        };
        assert!(safe_cf_warp.validate_bind_safety().is_ok());

        let unsafe_wildcard = WebConfig {
            bind_addr: "0.0.0.0:8080".into(),
            allowed_origin: "http://localhost:3000".into(),
            auth_token: "".into(),
        };
        assert!(unsafe_wildcard.validate_bind_safety().is_err());

        let short_token = WebConfig {
            bind_addr: "0.0.0.0:8080".into(),
            allowed_origin: "http://localhost:3000".into(),
            auth_token: "too-short".into(),
        };
        assert!(short_token.validate_bind_safety().is_err());

        let strong_token = WebConfig {
            bind_addr: "0.0.0.0:8080".into(),
            allowed_origin: "http://localhost:3000".into(),
            auth_token: "0123456789abcdef0123456789abcdef".into(),
        };
        assert!(strong_token.validate_bind_safety().is_ok());
    }
}
