//! Config discovery, loading and safe (secret-free) serialization.

use bot_core::BotConfig;
use std::path::{Path, PathBuf};

const CONFIG_CANDIDATES: [&str; 4] = [
    "rust-bot/config/bot.toml",
    "rust-bot/config/bot.example.toml",
    "config/bot.toml",
    "config/bot.example.toml",
];

/// Walks up from the current directory looking for the repository root.
pub fn repo_root() -> PathBuf {
    if let Ok(mut cur) = std::env::current_dir() {
        for _ in 0..6 {
            if cur.join("rust-bot").join("Cargo.toml").exists()
                || cur.join("package.json").exists()
                || cur.join(".git").exists()
            {
                return cur;
            }
            if !cur.pop() {
                break;
            }
        }
    }
    PathBuf::from(".")
}

/// Resolves the config path from `--config`, then `APEXRUST_CONFIG`, then the
/// first existing candidate next to the caller or the repository root.
pub fn resolve_config(explicit: Option<&Path>) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if let Ok(env_path) = std::env::var("APEXRUST_CONFIG") {
        let trimmed = env_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let root = repo_root();
    let search_roots = [PathBuf::from("."), root.clone()];
    for base in search_roots {
        for candidate in CONFIG_CANDIDATES {
            let path = base.join(candidate);
            if path.exists() {
                return path;
            }
        }
    }
    root.join("rust-bot/config/bot.toml")
}

pub fn load(path: &Path) -> anyhow::Result<BotConfig> {
    if !path.exists() {
        anyhow::bail!(
            "Config not found: {}\n       Copy rust-bot/config/bot.example.toml to {} first, or pass --config <path>.",
            path.display(),
            path.display()
        );
    }
    BotConfig::from_toml_file(path).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Serializes a sanitized snapshot: credentials and the web auth token removed.
pub fn sanitized_toml(config: &BotConfig) -> anyhow::Result<String> {
    let mut safe = config.clone();
    safe.exchange.credentials = None;
    safe.web.auth_token = String::new();
    let mut rendered = toml::to_string_pretty(&safe)?;
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    Ok(rendered)
}

/// Normalizes a user supplied daemon URL (`:8080`, `127.0.0.1:8080`, `http://…`).
pub fn normalize_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "http://127.0.0.1:8080".to_string();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.starts_with(':') {
        format!("http://127.0.0.1{trimmed}")
    } else {
        format!("http://{trimmed}")
    }
}

/// Resolves the daemon base URL: `--url` > env > `web.bind_addr` > `:8080`.
pub fn daemon_url(cli_url: Option<&str>, config: Option<&BotConfig>) -> String {
    if let Some(url) = cli_url {
        return normalize_url(url);
    }
    for env_key in ["APEXRUST_ENGINE_URL", "APEXRUST_REMOTE_URL"] {
        if let Ok(url) = std::env::var(env_key) {
            if !url.trim().is_empty() {
                return normalize_url(&url);
            }
        }
    }
    if let Some(cfg) = config {
        let bind = cfg.web.bind_addr.trim();
        if !bind.is_empty() {
            let host = bind
                .replace("0.0.0.0", "127.0.0.1")
                .replace("[::]", "127.0.0.1");
            return normalize_url(&host);
        }
    }
    "http://127.0.0.1:8080".to_string()
}

/// API base used for public market data (klines / 24h tickers).
pub fn market_base(config: &BotConfig) -> String {
    let configured = config.exchange.rest_base_url.trim();
    if !configured.is_empty() {
        return configured.trim_end_matches('/').to_string();
    }
    match (config.exchange.venue, config.exchange.environment) {
        (bot_core::ExchangeVenue::Spot, bot_core::ExchangeEnvironment::Production) => {
            "https://api.binance.com".to_string()
        }
        (bot_core::ExchangeVenue::Spot, bot_core::ExchangeEnvironment::Testnet) => {
            "https://testnet.binance.vision".to_string()
        }
        (bot_core::ExchangeVenue::Futures, bot_core::ExchangeEnvironment::Production) => {
            "https://fapi.binance.com".to_string()
        }
        (bot_core::ExchangeVenue::Futures, bot_core::ExchangeEnvironment::Testnet) => {
            "https://testnet.binancefuture.com".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_daemon_urls() {
        assert_eq!(normalize_url(":8081"), "http://127.0.0.1:8081");
        assert_eq!(normalize_url("127.0.0.1:9000/"), "http://127.0.0.1:9000");
        assert_eq!(normalize_url("https://vps:443"), "https://vps:443");
        assert_eq!(normalize_url("  "), "http://127.0.0.1:8080");
    }

    #[test]
    fn sanitized_toml_drops_credentials_and_token() {
        let path = repo_root().join("rust-bot/config/bot.example.toml");
        let cfg = load(&path).expect("example config should load");
        let rendered = sanitized_toml(&cfg).expect("serialize");
        assert!(!rendered.contains("api_key_env"));
        assert!(!rendered.contains("BINANCE_API_KEY"));
        assert!(!rendered.contains("ed25519_key_path"));
        assert!(rendered.contains("[exchange]"));
        assert!(rendered.contains("paper_trading"));
    }

    #[test]
    fn daemon_url_prefers_explicit_flag() {
        assert_eq!(daemon_url(Some(":9999"), None), "http://127.0.0.1:9999");
        assert_eq!(daemon_url(None, None), "http://127.0.0.1:8080");
    }
}
