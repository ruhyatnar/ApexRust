//! `apexrust config ...` — validate, inspect and export a secret-free TOML snapshot.

use crate::config_path::{load, sanitized_toml};
use crate::ui::{mask, Ui};
use anyhow::Context;
use bot_core::BotConfig;
use std::path::{Path, PathBuf};

fn feature_counts(config: &BotConfig) -> (usize, usize) {
    let value = serde_json::to_value(&config.features).unwrap_or_default();
    let object = value.as_object().cloned().unwrap_or_default();
    let total = object.len();
    let enabled = object
        .values()
        .filter(|v| v.as_bool() == Some(true))
        .count();
    (enabled, total)
}

fn credential_state(config: &BotConfig) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    match config.exchange.credentials.as_ref() {
        Some(creds) => {
            let key_present = std::env::var(&creds.api_key_env)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            rows.push((
                "Auth method".to_string(),
                format!("{:?}", creds.auth_method).to_lowercase(),
            ));
            rows.push((
                format!("Env {}", creds.api_key_env),
                if key_present {
                    "set".to_string()
                } else {
                    "not set".to_string()
                },
            ));
            if let Some(path) = creds.ed25519_key_path.as_ref() {
                let exists = Path::new(path).exists();
                rows.push((
                    "Ed25519 key".to_string(),
                    format!("{path} ({})", if exists { "found" } else { "missing" }),
                ));
            }
            rows.push((
                "Armed for live".to_string(),
                if creds.armed_for_live_orders {
                    "yes".to_string()
                } else {
                    "no".to_string()
                },
            ));
            rows.push((
                "Max order notional".to_string(),
                format!("{} USDT", creds.max_order_notional_usdt),
            ));
        }
        None => rows.push(("Credentials".to_string(), "not configured".to_string())),
    }
    rows
}

fn print_summary(ui: Ui, config: &BotConfig, path: &Path) {
    let (enabled, total) = feature_counts(config);
    ui.kv("Config file", &path.display().to_string());
    ui.kv(
        "Environment",
        &format!("{:?}", config.exchange.environment).to_lowercase(),
    );
    ui.kv(
        "Venue",
        &format!("{:?}", config.exchange.venue).to_lowercase(),
    );
    ui.kv(
        "Leverage",
        &format!(
            "{}x (max {}x)",
            config.exchange.leverage, config.exchange.max_leverage
        ),
    );
    ui.kv(
        "Paper trading",
        if config.exchange.paper_trading {
            "on"
        } else {
            "OFF (live)"
        },
    );
    ui.kv("Pairs", &format!("{} tracked", config.trading.pairs.len()));
    ui.kv("Timeframe", &config.trading.timeframe);
    ui.kv(
        "Strategy",
        &format!(
            "{:?} / {:?}",
            config.automation.strategy_profile, config.automation.direction_policy
        ),
    );
    ui.kv("Feature toggles", &format!("{enabled}/{total} enabled"));
    ui.kv(
        "Risk limits",
        &format!(
            "{}% daily DD, {}% pair DD, {}% profit lock",
            config.risk.max_daily_drawdown_pct,
            config.risk.max_pair_daily_drawdown_pct,
            config.risk.max_daily_profit_pct
        ),
    );
    ui.kv(
        "BTC crash guard",
        &if config.risk.btc_crash_guard_enabled {
            format!(
                "on ({}% / {}m, stale {}s)",
                config.risk.btc_crash_threshold_pct,
                config.risk.btc_crash_window_minutes,
                config.risk.btc_crash_max_staleness_sec
            )
        } else {
            "off".to_string()
        },
    );
    ui.kv(
        "WebSocket API",
        &if config.exchange.use_ws_api_orders {
            "on (session.logon)".to_string()
        } else {
            "off (REST signing)".to_string()
        },
    );
    let token = config.web.resolved_auth_token();
    ui.kv(
        "Web bridge",
        &format!(
            "{} {}",
            config.web.bind_addr,
            match token {
                Some(t) => format!("token {}", mask(&t)),
                None => "no token".to_string(),
            }
        ),
    );
    for (label, value) in credential_state(config) {
        ui.kv(&label, &value);
    }
}

pub fn validate(ui: Ui, path: &Path, json: bool) -> anyhow::Result<()> {
    let config = load(path)?;
    let (enabled, total) = feature_counts(&config);
    let warnings = validation_warnings(&config);
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "config": path,
                "features_enabled": enabled,
                "features_total": total,
                "warnings": warnings,
            })
        );
        return Ok(());
    }
    ui.ok("Config valid.");
    ui.kv("Path", &path.display().to_string());
    ui.kv("Feature toggles", &format!("{enabled}/{total} enabled"));
    ui.kv(
        "Session windows",
        &format!(
            "{} configured",
            config
                .automation
                .session_windows
                .iter()
                .filter(|w| w.enabled)
                .count()
        ),
    );
    for warning in warnings {
        ui.warn(&warning);
    }
    Ok(())
}

fn validation_warnings(config: &BotConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    if config.exchange.paper_trading
        && config
            .exchange
            .credentials
            .as_ref()
            .map(|c| c.armed_for_live_orders)
            .unwrap_or(false)
    {
        warnings.push(
            "armed_for_live_orders = true tetapi paper_trading = true; order tetap simulasi."
                .to_string(),
        );
    }
    if !config.exchange.paper_trading && config.exchange.credentials.is_none() {
        warnings.push(
            "paper_trading = false tanpa [exchange.credentials]; engine tidak bisa sign order."
                .to_string(),
        );
    }
    if config.exchange.use_ws_api_orders && config.exchange.ws_api_url.trim().is_empty() {
        warnings
            .push("ws_api_url kosong; default endpoint venue/testnet akan dipakai.".to_string());
    }
    if config.risk.btc_crash_guard_enabled && config.risk.btc_crash_max_staleness_sec == 0 {
        warnings
            .push("btc_crash_max_staleness_sec = 0 membuat guard selalu fail-open.".to_string());
    }
    warnings
}

pub fn show(ui: Ui, path: &Path, json: bool) -> anyhow::Result<()> {
    let config = load(path)?;
    if json {
        let mut safe = config.clone();
        safe.exchange.credentials = None;
        safe.web.auth_token = String::new();
        println!("{}", serde_json::to_string_pretty(&safe)?);
        return Ok(());
    }
    ui.title("ApexRust configuration");
    print_summary(ui, &config, path);
    ui.hint("Nilai rahasia tidak pernah ditampilkan; hanya status presence-nya.");
    Ok(())
}

pub fn sync(ui: Ui, path: &Path, out: Option<&Path>, json: bool) -> anyhow::Result<()> {
    let config = load(path)?;
    let out = out
        .map(Path::to_path_buf)
        .unwrap_or_else(default_synced_path);
    let rendered = sanitized_toml(&config)?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Tidak bisa membuat {}", parent.display()))?;
    }
    std::fs::write(&out, rendered)
        .with_context(|| format!("Tidak bisa menulis {}", out.display()))?;

    if json {
        println!(
            "{}",
            serde_json::json!({ "ok": true, "source": path, "output": out })
        );
        return Ok(());
    }
    ui.ok("Snapshot TOML tersanitasi ditulis.");
    ui.kv("Source", &path.display().to_string());
    ui.kv("Output", &out.display().to_string());
    ui.hint("Credentials dan web.auth_token dihapus dari file ini; aman untuk di-commit.");
    Ok(())
}

/// Convenience for tests and callers that need the default export path.
pub fn default_synced_path() -> PathBuf {
    crate::config_path::repo_root().join("rust-bot/config/bot.synced.toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_config() -> BotConfig {
        load(&crate::config_path::repo_root().join("rust-bot/config/bot.example.toml"))
            .expect("example config loads")
    }

    #[test]
    fn counts_21_switches_with_expected_defaults() {
        let config = example_config();
        let (enabled, total) = feature_counts(&config);
        assert_eq!(total, 21, "FeatureToggles count must stay 21");
        assert!(enabled < total, "example config keeps some toggles off");
    }

    #[test]
    fn credential_state_never_leaks_secret_values() {
        let config = example_config();
        let rows = credential_state(&config);
        let joined = rows
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("|");
        assert!(joined.contains("not set") || joined.contains("set"));
        assert!(!joined.contains("BINANCE_API_SECRET"));
    }

    #[test]
    fn validation_flags_paper_with_armed_credentials() {
        let mut config = example_config();
        if let Some(creds) = config.exchange.credentials.as_mut() {
            creds.armed_for_live_orders = true;
        }
        let warnings = validation_warnings(&config);
        assert!(warnings.iter().any(|w| w.contains("paper_trading")));
    }
}
