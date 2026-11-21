//! `apexrust doctor` — one screen of environment, config and connectivity checks.

use crate::client::DaemonClient;
use crate::config_path::{daemon_url, load, market_base};
use crate::ui::Ui;
use bot_core::BotConfig;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

impl Check {
    fn ok(name: &str, detail: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            status: CheckStatus::Ok,
            detail: detail.into(),
        }
    }

    fn warn(name: &str, detail: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            status: CheckStatus::Warn,
            detail: detail.into(),
        }
    }

    fn fail(name: &str, detail: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            status: CheckStatus::Fail,
            detail: detail.into(),
        }
    }

    fn symbol(&self) -> &'static str {
        match self.status {
            CheckStatus::Ok => "OK",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
        }
    }
}

async fn rest_ping(config: &BotConfig) -> Check {
    let base = market_base(config);
    let prefix = match config.exchange.venue {
        bot_core::ExchangeVenue::Spot => "/api/v3",
        bot_core::ExchangeVenue::Futures => "/fapi/v1",
    };
    let url = format!("{base}{prefix}/ping");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(err) => return Check::fail("REST ping", err.to_string()),
    };
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Check::ok("REST ping", format!("{url} → 200")),
        Ok(resp) => Check::fail("REST ping", format!("{url} → HTTP {}", resp.status())),
        Err(err) => Check::fail("REST ping", format!("{url} → {err}")),
    }
}

fn credential_checks(config: &BotConfig) -> Vec<Check> {
    // In paper mode missing credentials are expected; surface them as warnings so
    // `doctor` stays green for a fresh install.
    let soft = config.exchange.paper_trading;
    let soft_check = |soft: bool, name: &str, detail: String| {
        if soft {
            Check::warn(name, detail)
        } else {
            Check::fail(name, detail)
        }
    };
    let mut checks = Vec::new();
    match config.exchange.credentials.as_ref() {
        None => checks.push(Check::warn(
            "Credentials",
            "belum dikonfigurasi (paper trading tetap bisa jalan)",
        )),
        Some(creds) => {
            let key_set = std::env::var(&creds.api_key_env)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if key_set {
                checks.push(Check::ok(
                    "API key env",
                    format!("{} terisi", creds.api_key_env),
                ));
            } else {
                checks.push(soft_check(
                    soft,
                    "API key env",
                    format!(
                        "{} kosong{}",
                        creds.api_key_env,
                        if soft { " (paper mode)" } else { "" }
                    ),
                ));
            }
            if let Some(path) = creds.ed25519_key_path.as_deref() {
                let file = Path::new(path);
                if file.exists() {
                    checks.push(Check::ok("Ed25519 key", format!("{path} ditemukan")));
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(meta) = std::fs::metadata(file) {
                            let mode = meta.permissions().mode() & 0o777;
                            if mode & 0o077 != 0 {
                                checks.push(Check::warn(
                                    "Key permissions",
                                    format!("{path} mode {mode:o}; sebaiknya 600"),
                                ));
                            } else {
                                checks.push(Check::ok(
                                    "Key permissions",
                                    format!("{mode:o} (private)"),
                                ));
                            }
                        }
                    }
                } else {
                    checks.push(soft_check(
                        soft,
                        "Ed25519 key",
                        format!(
                            "{path} tidak ditemukan{}",
                            if soft { " (paper mode)" } else { "" }
                        ),
                    ));
                }
            }
        }
    }
    checks
}

async fn daemon_check(config: &BotConfig, url: Option<&str>) -> Check {
    let base = daemon_url(url, Some(config));
    match DaemonClient::new(&base, None) {
        Ok(client) => match client.get("/api/health").await {
            Ok(_) => Check::ok("Daemon", format!("{base} reachable")),
            Err(_) => Check::warn(
                "Daemon",
                format!("{base} belum berjalan (normal jika baru akan start)"),
            ),
        },
        Err(err) => Check::fail("Daemon", err.to_string()),
    }
}

fn binary_check() -> Check {
    match crate::cmd_run::locate_daemon_binary() {
        Some(path) => Check::ok("bot-desktop", path.display().to_string()),
        None => Check::fail(
            "bot-desktop",
            "belum di-build — jalankan `./apexrust setup` atau `cargo build --release -p bot-desktop`",
        ),
    }
}

pub async fn doctor(
    ui: Ui,
    config_path: &Path,
    url: Option<&str>,
    json_out: bool,
) -> anyhow::Result<bool> {
    let mut checks = Vec::new();

    let config = match load(config_path) {
        Ok(config) => {
            checks.push(Check::ok("Config", config_path.display().to_string()));
            Some(config)
        }
        Err(err) => {
            checks.push(Check::fail("Config", err.to_string()));
            None
        }
    };

    checks.push(binary_check());
    if let Some(config) = config.as_ref() {
        checks.push(rest_ping(config).await);
        checks.extend(credential_checks(config));
        checks.push(daemon_check(config, url).await);
    }

    let failures = checks
        .iter()
        .filter(|check| check.status == CheckStatus::Fail)
        .count();
    let warnings = checks
        .iter()
        .filter(|check| check.status == CheckStatus::Warn)
        .count();

    if json_out {
        println!(
            "{}",
            serde_json::json!({
                "ok": failures == 0,
                "failures": failures,
                "warnings": warnings,
                "checks": checks.iter().map(|c| serde_json::json!({
                    "name": c.name,
                    "status": c.symbol(),
                    "detail": c.detail,
                })).collect::<Vec<_>>(),
            })
        );
        return Ok(failures == 0);
    }

    ui.title("ApexRust doctor");
    let rows = checks
        .iter()
        .map(|check| {
            vec![
                check.symbol().to_string(),
                check.name.clone(),
                check.detail.clone(),
            ]
        })
        .collect::<Vec<_>>();
    ui.table(&["Status", "Check", "Detail"], &rows);

    if failures == 0 {
        ui.ok(&format!(
            "Semua pemeriksaan penting lolos{}.",
            if warnings > 0 {
                format!(" ({warnings} peringatan)")
            } else {
                String::new()
            }
        ));
    } else {
        ui.error(&format!("{failures} pemeriksaan gagal."));
        ui.hint("Perbaiki item FAIL di atas; WARN tidak menghalangi paper trading.");
    }
    Ok(failures == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_symbols_are_stable() {
        assert_eq!(Check::ok("a", "b").symbol(), "OK");
        assert_eq!(Check::warn("a", "b").symbol(), "WARN");
        assert_eq!(Check::fail("a", "b").symbol(), "FAIL");
    }

    #[test]
    fn credential_check_warns_without_credentials() {
        let path = crate::config_path::repo_root().join("rust-bot/config/bot.example.toml");
        let mut config = load(&path).unwrap();
        config.exchange.credentials = None;
        let checks = credential_checks(&config);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, CheckStatus::Warn);
    }

    #[test]
    fn missing_credentials_only_fail_outside_paper_mode() {
        let path = crate::config_path::repo_root().join("rust-bot/config/bot.example.toml");
        let mut config = load(&path).unwrap();
        config.exchange.paper_trading = true;
        std::env::remove_var("BINANCE_API_KEY");
        let paper = credential_checks(&config);
        assert!(paper.iter().all(|check| check.status != CheckStatus::Fail));

        config.exchange.paper_trading = false;
        let live = credential_checks(&config);
        assert!(live.iter().any(|check| check.status == CheckStatus::Fail));
    }
}
