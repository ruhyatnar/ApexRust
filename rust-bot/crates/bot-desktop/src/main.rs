//! Cross-Platform Desktop & Headless Server binary for ApexRust Quant (Windows, macOS, Linux).
//!
//! Operating modes:
//! 1. Local / 24/7 VPS Daemon mode (default when `activeMode == "local"` or `--daemon`):
//!    Launches the multi-pair WebSocket/REST trading engine and embeds the `bot-web` Axum server.
//! 2. Remote VPS Client mode (`bot-desktop connect ...`, `bot-desktop remote ...`, or automatically
//!    when `.apexrust/remote-profile.json` is set to `activeMode == "remote"`):
//!    Connects to a 24/7 Remote VPS over Cloudflare One (Zero Trust) to monitor and control the bot.

use anyhow::{anyhow, Context};
use bot_core::{is_private_or_zero_trust_bind_addr, BotConfig};
use bot_engine::{EngineCommand, TradingEngine};
use bot_web::WebState;
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tracing::info;

#[derive(Debug, Parser)]
#[command(
    name = "bot-desktop",
    version,
    about = "ApexRust Quant Cross-Platform Multi-Pair Binance Trading Bot & Remote VPS Client"
)]
struct Cli {
    /// Path to TOML configuration file (used in Local / VPS Daemon mode)
    #[arg(short, long, default_value = "config/bot.example.toml")]
    config: PathBuf,

    /// Optional WebApp telemetry bind port override (e.g. 8080). Set 0 to disable web server; omit to use config web.bind_addr.
    #[arg(long)]
    web_port: Option<u16>,

    /// Optional explicit web bind address override (e.g. 127.0.0.1:8080 or 100.96.1.10:8080)
    #[arg(long)]
    web_bind: Option<String>,

    /// Always boot the local/VPS trading engine daemon even if .apexrust/remote-profile.json is set to remote mode
    #[arg(long)]
    daemon: bool,

    #[command(subcommand)]
    command: Option<DesktopSubcommand>,
}

#[derive(Debug, Subcommand)]
enum DesktopSubcommand {
    /// Test connection to a 24/7 Remote VPS (Cloudflare One / Zero Trust) and save as active Remote profile
    Connect {
        /// Remote VPS server URL (e.g. http://100.96.1.10:3000)
        #[arg(long)]
        url: String,

        /// Friendly nickname for this VPS (e.g. "Tokyo VPS")
        #[arg(long, default_value = "Remote VPS")]
        name: String,

        /// Optional Access Token (APEXRUST_PROXY_TOKEN / APEXRUST_WEB_TOKEN)
        #[arg(long)]
        token: Option<String>,
    },
    /// Switch desktop startup mode back to This Computer (Local Engine)
    UseLocal,
    /// Switch desktop startup mode to Remote VPS (24/7 Server)
    UseRemote,
    /// Monitor and control a 24/7 Remote VPS trading engine
    Remote {
        /// Remote VPS URL override (defaults to saved .apexrust/remote-profile.json or APEXRUST_REMOTE_URL)
        #[arg(long, env = "APEXRUST_REMOTE_URL")]
        url: Option<String>,

        /// Access Token override (defaults to saved profile or APEXRUST_REMOTE_TOKEN)
        #[arg(long, env = "APEXRUST_REMOTE_TOKEN")]
        token: Option<String>,

        #[command(subcommand)]
        action: RemoteAction,
    },
}

#[derive(Debug, Subcommand)]
enum RemoteAction {
    /// Display 4-point VPS connection & Zero Trust health check
    Info,
    /// Check 24/7 VPS Rust daemon health
    Health,
    /// Fetch current 24/7 VPS trading engine snapshot
    Snapshot {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Live terminal dashboard polling 24/7 VPS positions, PnL, and circuit breaker state
    Watch {
        /// Poll interval in seconds
        #[arg(long, default_value_t = 2)]
        interval: u64,
    },
    /// List recent order history from the 24/7 VPS SQLite WAL database
    Orders {
        /// Max rows to display
        #[arg(long, default_value_t = 25)]
        limit: usize,
    },
    /// List detected orphan pairs on the 24/7 VPS
    Orphans,
    /// Print the active sanitized BotConfig running on the 24/7 VPS daemon
    Config,
    /// Pause automated entry scanning on the 24/7 VPS bot
    Pause,
    /// Resume automated entry scanning on the 24/7 VPS bot
    Resume,
    /// Trip the 24/7 VPS risk circuit breaker
    TripCb {
        /// Reason for tripping the circuit breaker
        #[arg(long, default_value = "Manual trip from bot-desktop CLI")]
        reason: String,
    },
    /// Reset the 24/7 VPS risk circuit breaker and clear pair quarantines
    ResetCb,
    /// Print live Binance WS trending screener candidates on the 24/7 VPS
    Trending {
        /// Category: hot_volume, top_gainers, top_losers, or volatility_leaders
        #[arg(long, default_value = "hot_volume")]
        category: String,
        /// Number of top pairs to show
        #[arg(long, default_value_t = 15)]
        limit: usize,
        /// Quote asset filter (e.g. USDT)
        #[arg(long)]
        quote: Option<String>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Update watchlist selection mode or pinned pairs on the 24/7 VPS bot
    Watchlist {
        /// Selection mode: static, hybrid, or dynamic
        #[arg(long)]
        mode: Option<String>,
        /// Comma-separated pinned pairs (e.g. BTCUSDT,ETHUSDT,SOLUSDT)
        #[arg(long)]
        pairs: Option<String>,
        /// Trending category: hot_volume, top_gainers, top_losers, or volatility_leaders
        #[arg(long)]
        category: Option<String>,
        /// Quote asset (e.g. USDT)
        #[arg(long)]
        quote: Option<String>,
        /// Max total pairs monitored simultaneously
        #[arg(long)]
        max_pairs: Option<usize>,
        /// Trending slots reserved in hybrid/dynamic mode
        #[arg(long)]
        top_n: Option<usize>,
    },
    /// Emergency flatten all open positions on the 24/7 VPS bot
    FlattenAll {
        /// Skip interactive confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Trigger an immediate sanitized Git backup on the 24/7 VPS
    BackupNow,
    /// Submit a manual order to the 24/7 VPS trading engine
    ManualOrder {
        /// Trading pair symbol (e.g. BTCUSDT)
        #[arg(long)]
        symbol: String,
        /// Direction: long or short
        #[arg(long, default_value = "long")]
        side: String,
        /// Order notional in USDT
        #[arg(long, default_value_t = 150.0)]
        notional: f64,
        /// Execution method: market, limit, limit_maker, or oco
        #[arg(long, default_value = "market")]
        method: String,
        /// Optional limit price (required for limit / limit_maker)
        #[arg(long)]
        limit_price: Option<f64>,
        /// Optional take-profit price (for oco)
        #[arg(long)]
        take_profit_price: Option<f64>,
        /// Optional stop-loss price (for oco)
        #[arg(long)]
        stop_loss_price: Option<f64>,
        /// Skip interactive confirmation prompt
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedRemoteProfile {
    active_mode: String,
    name: String,
    base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at_iso: Option<String>,
}

impl Default for SavedRemoteProfile {
    fn default() -> Self {
        Self {
            active_mode: "local".to_string(),
            name: "Remote VPS".to_string(),
            base_url: String::new(),
            token: None,
            updated_at_iso: None,
        }
    }
}

fn find_repo_root() -> PathBuf {
    if let Ok(mut cur) = std::env::current_dir() {
        for _ in 0..4 {
            if cur.join("package.json").exists() || cur.join(".git").exists() {
                return cur;
            }
            if !cur.pop() {
                break;
            }
        }
    }
    PathBuf::from(".")
}

fn remote_profile_path() -> PathBuf {
    find_repo_root().join(".apexrust").join("remote-profile.json")
}

fn load_saved_remote_profile(path: &Path) -> SavedRemoteProfile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SavedRemoteProfile>(&raw).ok())
        .unwrap_or_default()
}

fn save_remote_profile(path: &Path, profile: &SavedRemoteProfile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(profile)?;
    std::fs::write(path, format!("{json}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

struct RemoteClient {
    http: reqwest::Client,
    server_root: String,
    engine_api_base: String,
    token: Option<String>,
}

impl RemoteClient {
    fn new(raw_url: &str, token: Option<String>) -> anyhow::Result<Self> {
        let (server_root, engine_api_base) = Self::normalize_urls(raw_url)?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()?;
        Ok(Self {
            http,
            server_root,
            engine_api_base,
            token: token.filter(|s| !s.trim().is_empty()),
        })
    }

    /// Normalize a user-supplied VPS URL into:
    /// - `server_root` (e.g. `http://100.96.1.10:3000`)
    /// - `engine_api_base` (e.g. `http://100.96.1.10:3000/api/engine` for server.ts gateway, or `http://127.0.0.1:8080/api` for direct bot-web)
    fn normalize_urls(raw: &str) -> anyhow::Result<(String, String)> {
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return Err(anyhow!(
                "Remote VPS URL is empty. Run `bot-desktop connect --url http://100.96.x.y:3000` first."
            ));
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            return Err(anyhow!("Remote VPS URL must start with http:// or https://"));
        }
        if let Some(root) = trimmed.strip_suffix("/api/engine") {
            return Ok((root.to_string(), trimmed.to_string()));
        }
        if let Some(root) = trimmed.strip_suffix("/api") {
            return Ok((root.to_string(), trimmed.to_string()));
        }
        // If pointing directly to default bot-web port :8080, use /api; otherwise default to /api/engine
        // (and allow runtime fallback to /api if /api/connection/info is unavailable).
        let engine_base = if trimmed.ends_with(":8080") {
            format!("{trimmed}/api")
        } else {
            format!("{trimmed}/api/engine")
        };
        Ok((trimmed.to_string(), engine_base))
    }

    async fn resolve_custom_direct_port(&mut self) {
        if self.engine_api_base.ends_with("/api") {
            return;
        }
        let info_url = format!("{}/api/connection/info", self.server_root);
        if self.get_json(&info_url).await.is_ok() {
            return;
        }
        let direct_health = format!("{}/api/health", self.server_root);
        if self.get_json(&direct_health).await.is_ok() {
            self.engine_api_base = format!("{}/api", self.server_root);
        }
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(ref tok) = self.token {
            req.header("Authorization", format!("Bearer {tok}"))
                .header("X-ApexRust-Token", tok)
        } else {
            req
        }
    }

    fn get_json_sync_helper(&self, url: &str) -> reqwest::RequestBuilder {
        self.apply_auth(self.http.get(url))
    }

    async fn get_json(&self, url: &str) -> anyhow::Result<serde_json::Value> {
        let resp = self.get_json_sync_helper(url).send().await?;
        let status = resp.status();
        let val: serde_json::Value = resp
            .json()
            .await
            .unwrap_or_else(|_| serde_json::json!({ "error": format!("HTTP {status}") }));
        if !status.is_success() {
            let msg = val["error"]
                .as_str()
                .unwrap_or("Remote request failed");
            return Err(anyhow!("HTTP {status}: {msg}"));
        }
        Ok(val)
    }

    async fn post_json(&self, url: &str, payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .apply_auth(self.http.post(url))
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let val: serde_json::Value = resp
            .json()
            .await
            .unwrap_or_else(|_| serde_json::json!({ "error": format!("HTTP {status}") }));
        if !status.is_success() {
            let msg = val["error"]
                .as_str()
                .unwrap_or("Remote request failed");
            return Err(anyhow!("HTTP {status}: {msg}"));
        }
        Ok(val)
    }

    async fn post_control(&self, payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let url = format!("{}/control", self.engine_api_base);
        self.post_json(&url, payload).await
    }

    fn ws_telemetry_url(&self) -> String {
        let ws_root = if let Some(rest) = self.server_root.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.server_root.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.server_root.clone()
        };
        if let Some(ref tok) = self.token {
            let encoded = reqwest::Url::parse("http://localhost/")
                .map(|mut u| {
                    u.query_pairs_mut().append_pair("token", tok);
                    u.query().unwrap_or_default().to_string()
                })
                .unwrap_or_default();
            if !encoded.is_empty() {
                return format!("{ws_root}/ws/telemetry?{encoded}");
            }
        }
        format!("{ws_root}/ws/telemetry")
    }
}

fn next_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cli-{nanos}-{}", std::process::id())
}

async fn print_connection_info(client: &mut RemoteClient) -> anyhow::Result<()> {
    let start = std::time::Instant::now();
    let info_url = format!("{}/api/connection/info", client.server_root);
    match client.get_json(&info_url).await {
        Ok(info) => {
            let latency_ms = start.elapsed().as_millis();
            let env = info["environment"].as_str().unwrap_or("Testnet");
            let venue = info["venue"].as_str().unwrap_or("Spot");
            let eng_ok = info["engineReachable"].as_bool().unwrap_or(false);
            let eng_run = info["engineRunning"].as_bool().unwrap_or(false);
            let authority = info["engineAuthority"].as_str().unwrap_or("browser");
            let api_version = info["apiVersion"].as_str().unwrap_or("unknown");
            println!("=== ApexRust Remote VPS Connection Check ===");
            println!("  [OK] 1. VPS Server Reachable    : {} ({latency_ms} ms)", client.server_root);
            println!("  [OK] 2. Access Permission       : Verified (Cloudflare One / Token OK)");
            println!(
                "  [{}] 3. 24/7 VPS Trading Daemon : {}",
                if eng_ok { "OK" } else { "WARN" },
                if eng_ok {
                    if eng_run { "Online & Running" } else { "Online (Paused)" }
                } else {
                    "Not reachable on VPS (:8080)"
                }
            );
            println!("  [OK] 4. Binance Account Mode    : {venue} · {env} (authority={authority})");
            if api_version != "2.0.0" {
                println!(
                    "  [WARN] API Version Skew         : Server reports {api_version}, desktop expects 2.0.0"
                );
            }
            Ok(())
        }
        Err(_) => {
            // Fallback for direct bot-web connection on :8080 or any custom direct port
            client.resolve_custom_direct_port().await;
            let health = match client
                .get_json(&format!("{}/health", client.engine_api_base))
                .await
            {
                Ok(h) => h,
                Err(_) => {
                    client
                        .get_json(&format!("{}/api/health", client.server_root))
                        .await?
                }
            };
            let latency_ms = start.elapsed().as_millis();
            println!("=== ApexRust Direct Daemon Connection Check ===");
            println!("  [OK] 1. 24/7 VPS Daemon Reachable: {} ({latency_ms} ms)", client.engine_api_base);
            println!(
                "  [OK] 2. Engine Status            : running={} transport={}",
                health["running"], health["transport_mode"]
            );
            Ok(())
        }
    }
}

fn confirm_dangerous_cli_action(skip_confirm: bool, prompt_text: &str) -> anyhow::Result<()> {
    if skip_confirm {
        return Ok(());
    }
    use std::io::{IsTerminal, Write};
    if !std::io::stdin().is_terminal() {
        return Err(anyhow!(
            "Confirmation required for `{prompt_text}` in non-interactive mode (pass --yes to proceed)."
        ));
    }
    print!("{prompt_text} Continue? [y/N]: ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    let trimmed = answer.trim().to_ascii_lowercase();
    if trimmed == "y" || trimmed == "yes" {
        Ok(())
    } else {
        Err(anyhow!("Cancelled by operator."))
    }
}

async fn run_remote_action(
    raw_url: Option<String>,
    raw_token: Option<String>,
    action: RemoteAction,
) -> anyhow::Result<()> {
    let saved = load_saved_remote_profile(&remote_profile_path());
    let url = raw_url
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if !saved.base_url.trim().is_empty() {
                Some(saved.base_url.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "http://127.0.0.1:3000".to_string());
    let token = raw_token.or(saved.token);
    let mut client = RemoteClient::new(&url, token)?;
    if !matches!(action, RemoteAction::Info) {
        client.resolve_custom_direct_port().await;
    }

    match action {
        RemoteAction::Info => {
            print_connection_info(&mut client).await?;
        }
        RemoteAction::Health => {
            let val = client
                .get_json(&format!("{}/health", client.engine_api_base))
                .await?;
            println!("{}", serde_json::to_string_pretty(&val)?);
        }
        RemoteAction::Snapshot { json } => {
            let snap = client
                .get_json(&format!("{}/snapshot", client.engine_api_base))
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snap)?);
            } else {
                print_compact_snapshot(&snap, &client.server_root);
            }
        }
        RemoteAction::Watch { interval } => {
            let wait_sec = interval.max(1);
            let ws_url = client.ws_telemetry_url();
            let snap_url = format!("{}/snapshot", client.engine_api_base);
            println!(
                "Connecting to 24/7 Remote VPS ({}) — WebSocket /ws/telemetry with {}s HTTP fallback (Ctrl+C to exit)...",
                client.server_root, wait_sec
            );
            let shutdown = wait_for_shutdown_signal();
            tokio::pin!(shutdown);
            loop {
                let mut exit_requested = false;
                match connect_async(&ws_url).await {
                    Ok((mut ws_stream, _)) => {
                        println!("[OK] Real-time WebSocket telemetry stream connected.");
                        loop {
                            tokio::select! {
                                _ = &mut shutdown => {
                                    println!("\nDisconnected from Remote VPS monitor (24/7 VPS bot continues running on server).");
                                    exit_requested = true;
                                    break;
                                }
                                msg = ws_stream.next() => {
                                    match msg {
                                        Some(Ok(WsMessage::Text(text))) => {
                                            if let Ok(snap) = serde_json::from_str::<serde_json::Value>(&text) {
                                                let payload = snap.get("snapshot").unwrap_or(&snap);
                                                print_compact_snapshot(payload, &client.server_root);
                                            }
                                        }
                                        Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => {
                                            eprintln!("[WARN] Telemetry WS disconnected; falling back temporarily before reconnect...");
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    Err(ws_err) => {
                        eprintln!("[WARN] WS /ws/telemetry unavailable ({ws_err}) — polling HTTP every {wait_sec}s...");
                        match client.get_json(&snap_url).await {
                            Ok(snap) => print_compact_snapshot(&snap, &client.server_root),
                            Err(err) => eprintln!("[WARN] VPS snapshot poll error: {err}"),
                        }
                    }
                }
                if exit_requested {
                    break;
                }
                tokio::select! {
                    _ = &mut shutdown => {
                        println!("\nDisconnected from Remote VPS monitor (24/7 VPS bot continues running on server).");
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(wait_sec)) => {}
                }
            }
        }
        RemoteAction::Orders { limit } => {
            let val = client
                .get_json(&format!("{}/orders/history?limit={limit}", client.engine_api_base))
                .await?;
            if let Some(arr) = val["logs"].as_array() {
                println!("Showing {} of {} order(s) from Remote VPS:", arr.len().min(limit), arr.len());
                for item in arr.iter().take(limit) {
                    println!(
                        "  #{} | {} | {} {} {} | status={} | px={} | qty={}",
                        item["orderId"].as_str().unwrap_or("-"),
                        item["symbol"].as_str().unwrap_or("-"),
                        item["venue"].as_str().unwrap_or("-"),
                        item["binanceSide"].as_str().unwrap_or("-"),
                        item["orderType"].as_str().unwrap_or("-"),
                        item["status"].as_str().unwrap_or("-"),
                        item["avgPrice"].as_f64().unwrap_or(0.0),
                        item["executedQty"].as_f64().unwrap_or(0.0),
                    );
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&val)?);
            }
        }
        RemoteAction::Orphans => {
            let val = client
                .get_json(&format!("{}/orders/orphans", client.engine_api_base))
                .await?;
            println!("{}", serde_json::to_string_pretty(&val)?);
        }
        RemoteAction::Config => {
            let val = client
                .get_json(&format!("{}/config", client.engine_api_base))
                .await?;
            println!("{}", serde_json::to_string_pretty(&val)?);
        }
        RemoteAction::Pause => {
            let res = client
                .post_control(serde_json::json!({
                    "action": "pause",
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Bot Pause: {}", res);
        }
        RemoteAction::Resume => {
            let res = client
                .post_control(serde_json::json!({
                    "action": "resume",
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Bot Resume: {}", res);
        }
        RemoteAction::TripCb { reason } => {
            let res = client
                .post_control(serde_json::json!({
                    "action": "trip_cb",
                    "reason": reason,
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Circuit Breaker Trip: {}", res);
        }
        RemoteAction::ResetCb => {
            let res = client
                .post_control(serde_json::json!({
                    "action": "reset_cb",
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Circuit Breaker Reset: {}", res);
        }
        RemoteAction::Trending {
            category,
            limit,
            quote,
            json,
        } => {
            let mut url = format!(
                "{}/market/screener?category={}&limit={}",
                client.engine_api_base,
                category.trim(),
                limit.clamp(1, 100)
            );
            if let Some(q) = quote {
                let clean_q = q.trim().to_uppercase();
                if !clean_q.is_empty() {
                    url.push_str(&format!("&quoteAsset={clean_q}"));
                }
            }
            let val = client.get_json(&url).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&val)?);
            } else {
                let venue = val["venue"].as_str().unwrap_or("-");
                let stream_ok = val["streamConnected"].as_bool().unwrap_or(false);
                println!(
                    "=== Binance Live Screener ({category}, venue={venue}, ws={stream_ok}) ==="
                );
                if let Some(tickers) = val["tickers"].as_array() {
                    for (idx, t) in tickers.iter().take(limit).enumerate() {
                        let sym = t["symbol"].as_str().unwrap_or("-");
                        let px = t["lastPrice"].as_f64().unwrap_or(0.0);
                        let chg = t["priceChangePercent"].as_f64().unwrap_or(0.0);
                        let qvol = t["quoteVolume"].as_f64().unwrap_or(0.0) / 1_000_000.0;
                        let rng = t["rangePct24h"].as_f64().unwrap_or(0.0);
                        let src = t["sourceTag"].as_str().unwrap_or("screener");
                        println!(
                            "  {:>2}. {:<12} px=${:<12.4} chg={:+6.2}% vol=${:>8.1}M range={:>5.2}% [{}]",
                            idx + 1,
                            sym,
                            px,
                            chg,
                            qvol,
                            rng,
                            src
                        );
                    }
                }
            }
        }
        RemoteAction::Watchlist {
            mode,
            pairs,
            category,
            quote,
            max_pairs,
            top_n,
        } => {
            let mut body = serde_json::Map::new();
            if let Some(m) = mode {
                body.insert("pairSelectionMode".into(), serde_json::json!(m.trim().to_lowercase()));
            }
            if let Some(p) = pairs {
                let list: Vec<String> = p
                    .split(',')
                    .map(|s| s.trim().to_uppercase())
                    .filter(|s| !s.is_empty())
                    .collect();
                body.insert("pinnedPairs".into(), serde_json::json!(list));
            }
            if let Some(c) = category {
                body.insert("trendingCategory".into(), serde_json::json!(c.trim()));
            }
            if let Some(q) = quote {
                body.insert("quoteAsset".into(), serde_json::json!(q.trim().to_uppercase()));
            }
            if let Some(mx) = max_pairs {
                body.insert("maxWatchlistPairs".into(), serde_json::json!(mx));
            }
            if let Some(tn) = top_n {
                body.insert("trendingTopN".into(), serde_json::json!(tn));
            }
            let url = format!("{}/watchlist", client.engine_api_base);
            let res = client.post_json(&url, serde_json::Value::Object(body)).await?;
            println!("24/7 VPS Watchlist Updated: {}", serde_json::to_string_pretty(&res)?);
        }
        RemoteAction::FlattenAll { yes } => {
            confirm_dangerous_cli_action(yes, "Emergency Flatten All open positions on 24/7 Remote VPS")?;
            let res = client
                .post_control(serde_json::json!({
                    "action": "flatten_all",
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Emergency Flatten All: {}", res);
        }
        RemoteAction::BackupNow => {
            let res = client
                .post_control(serde_json::json!({
                    "action": "backup_now",
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Git Backup Triggered: {}", res);
        }
        RemoteAction::ManualOrder {
            symbol,
            side,
            notional,
            method,
            limit_price,
            take_profit_price,
            stop_loss_price,
            yes,
        } => {
            let clean_sym = symbol.trim().to_uppercase();
            confirm_dangerous_cli_action(
                yes,
                &format!(
                    "Dispatch manual {side} {clean_sym} (${notional:.2}) via {method} to 24/7 Remote VPS"
                ),
            )?;
            let norm_side = if side.trim().eq_ignore_ascii_case("short") {
                "Short"
            } else {
                "Long"
            };
            let norm_method = match method.trim().to_uppercase().as_str() {
                "LIMIT" => "LIMIT",
                "LIMIT_MAKER" | "LIMITMAKER" => "LIMIT_MAKER",
                "OCO" => "OCO",
                _ => "MARKET",
            };
            let res = client
                .post_control(serde_json::json!({
                    "action": "manual_order",
                    "symbol": clean_sym,
                    "side": norm_side,
                    "notional_usdt": notional,
                    "order_method": norm_method,
                    "limit_price": limit_price,
                    "take_profit_price": take_profit_price,
                    "stop_loss_price": stop_loss_price,
                    "request_id": next_request_id(),
                }))
                .await?;
            println!("24/7 VPS Manual Order Response: {}", res);
        }
    }
    Ok(())
}

fn print_compact_snapshot(snap: &serde_json::Value, server_label: &str) {
    let running = snap["running"].as_bool().unwrap_or(false);
    let venue = snap["venue"].as_str().unwrap_or("spot");
    let transport = snap["transport_mode"].as_str().unwrap_or("WsPrimary");
    let pair_mode = snap["pair_selection_mode"].as_str().unwrap_or("hybrid");
    let cb_state = snap["risk"]["state"].as_str().unwrap_or("Normal");
    let eq = snap["risk"]["current_equity"].as_f64().unwrap_or(0.0);
    let daily_pnl = snap["risk"]["cumulative_daily_pnl_usdt"]
        .as_f64()
        .or_else(|| snap["risk"]["daily_pnl_usdt"].as_f64())
        .unwrap_or(0.0);
    println!(
        "\n[☁️ Remote VPS: {server_label}] Status={} | Venue={} | Mode={} | Feed={} | CB={} | Equity=${eq:.2} (Daily PnL: ${daily_pnl:+.2})",
        if running { "RUNNING" } else { "PAUSED" },
        venue.to_uppercase(),
        pair_mode,
        transport,
        cb_state
    );
    if let Some(pairs) = snap["pairs"].as_array() {
        for p in pairs {
            let sym = p["symbol"].as_str().unwrap_or("-");
            let px = p["last_price"].as_f64().unwrap_or(0.0);
            let src = p["source_tag"].as_str().unwrap_or("pinned");
            let spread_bps = p["spread_bps"].as_f64().unwrap_or(0.0);
            let warm = p["bars_warmed_up"].as_u64().unwrap_or(0);
            let pos_str = if let Some(pos) = p["open_position"].as_object() {
                let side = pos.get("side").and_then(|v| v.as_str()).unwrap_or("Long");
                let entry = pos.get("entry_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let qty = pos.get("remaining_quantity").and_then(|v| v.as_f64()).unwrap_or(0.0);
                format!("OPEN {side} qty={qty:.4} @ ${entry:.4}")
            } else {
                "FLAT".to_string()
            };
            println!(
                "  • {sym:<10} [{src:<9}] px=${px:<11.4} spread={spread_bps:>4.1}bps bars={warm:<3} | {pos_str}"
            );
        }
    }
    if let Some(pending) = snap["pending_orders"].as_array() {
        if !pending.is_empty() {
            println!("  Pending Resting Orders ({}):", pending.len());
            for o in pending {
                let sym = o["symbol"].as_str().unwrap_or("-");
                let side = o["side"].as_str().unwrap_or("-");
                let lim = o["limit_price"].as_f64().unwrap_or(0.0);
                let src = o["source"].as_str().unwrap_or_else(|| {
                    if o["is_manual"].as_bool().unwrap_or(false) {
                        "manual"
                    } else {
                        "auto"
                    }
                });
                let age_bars = o["age_bars"].as_u64().unwrap_or(0);
                let note = o["dynamic_status_note"]
                    .as_str()
                    .or_else(|| o["rationale"].as_str())
                    .unwrap_or("");
                println!("    - {sym} {side} @ ${lim:.4} ({src}, {age_bars}b) {note}");
            }
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,bot_exchange=debug,bot_risk=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let profile_path = remote_profile_path();

    if let Some(sub) = cli.command {
        match sub {
            DesktopSubcommand::Connect { url, name, token } => {
                let mut client = RemoteClient::new(&url, token.clone())?;
                print_connection_info(&mut client).await?;
                let profile = SavedRemoteProfile {
                    active_mode: "remote".to_string(),
                    name,
                    base_url: client.server_root.clone(),
                    token,
                    updated_at_iso: Some(format!(
                        "{}",
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                    )),
                };
                save_remote_profile(&profile_path, &profile)?;
                println!(
                    "\n[OK] Saved Remote VPS profile ({}) -> {}",
                    profile.base_url,
                    profile_path.display()
                );
                return Ok(());
            }
            DesktopSubcommand::UseLocal => {
                let mut profile = load_saved_remote_profile(&profile_path);
                profile.active_mode = "local".to_string();
                save_remote_profile(&profile_path, &profile)?;
                println!("[OK] Switched active profile to: 🖥️ This Computer (Local Engine)");
                return Ok(());
            }
            DesktopSubcommand::UseRemote => {
                let mut profile = load_saved_remote_profile(&profile_path);
                if profile.base_url.trim().is_empty() {
                    return Err(anyhow!(
                        "No Remote VPS URL saved yet. Run `bot-desktop connect --url http://100.96.x.y:3000` first."
                    ));
                }
                profile.active_mode = "remote".to_string();
                save_remote_profile(&profile_path, &profile)?;
                println!(
                    "[OK] Switched active profile to: ☁️ Remote VPS ({})",
                    profile.base_url
                );
                return Ok(());
            }
            DesktopSubcommand::Remote { url, token, action } => {
                return run_remote_action(url, token, action).await;
            }
        }
    }

    // If no subcommand was passed and `--daemon` is false, check if the desktop is configured for Remote VPS mode
    if !cli.daemon {
        let saved = load_saved_remote_profile(&profile_path);
        if saved.active_mode.eq_ignore_ascii_case("remote") && !saved.base_url.trim().is_empty() {
            info!(
                vps_url = %saved.base_url,
                "Active profile is Remote VPS — launching 24/7 Remote VPS monitor (pass --daemon to run local engine)"
            );
            return run_remote_action(
                Some(saved.base_url),
                saved.token,
                RemoteAction::Watch { interval: 2 },
            )
            .await;
        }
    }

    let default_cfg = PathBuf::from("config/bot.example.toml");
    let config_path = if !cli.config.exists()
        && cli.config == default_cfg
        && PathBuf::from("rust-bot/config/bot.example.toml").exists()
    {
        PathBuf::from("rust-bot/config/bot.example.toml")
    } else {
        cli.config.clone()
    };
    let cfg = BotConfig::from_toml_file(&config_path)
        .with_context(|| format!("Unable to load config at {}", config_path.display()))?;

    info!(
        mode = ?cfg.trading.mode,
        timeframe = %cfg.trading.timeframe,
        pairs = ?cfg.trading.pairs,
        "Booting ApexRust Quant Engine"
    );

    let engine = Arc::new(TradingEngine::new(cfg.clone())?);
    let (cmd_tx, cmd_rx) = mpsc::channel::<EngineCommand>(32);

    // Spawn embedded Axum WebApp API & WebSocket bridge unless disabled with --web-port 0
    let bind_addr = if let Some(explicit_bind) = cli.web_bind {
        let trimmed = explicit_bind.trim().to_string();
        let trust_mesh = std::env::var("APEXRUST_TRUST_ZERO_TRUST_MESH")
            .map(|v| v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !trimmed.is_empty() && !is_private_or_zero_trust_bind_addr(&trimmed) && !trust_mesh {
            let tok = cfg.web.resolved_auth_token();
            if tok.as_ref().is_none_or(|t| t.len() < 32) {
                return Err(anyhow!(
                    "Refusing to bind non-private --web-bind '{}' without a >= 32 character APEXRUST_WEB_TOKEN (or APEXRUST_TRUST_ZERO_TRUST_MESH=true)",
                    trimmed
                ));
            }
        }
        Some(trimmed)
    } else {
        match cli.web_port {
            Some(0) => None,
            Some(port) => Some(format!("127.0.0.1:{port}")),
            None => {
                let trimmed = cfg.web.bind_addr.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
        }
    };
    if let Some(addr) = bind_addr {
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        let app = bot_web::router(WebState::new(
            Arc::clone(&engine),
            cmd_tx.clone(),
            cfg.web.resolved_auth_token(),
        ));
        info!(%addr, "Serving WebApp telemetry API & WebSocket");
        tokio::spawn(async move {
            if let Err(err) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            {
                tracing::error!(%err, "Web server terminated");
            }
        });
    }

    // Spawn trading engine
    let mut engine_task = tokio::spawn({
        let eng = Arc::clone(&engine);
        async move { eng.run(cmd_rx).await }
    });

    // Wait for Ctrl+C / SIGINT / SIGTERM for graceful shutdown (cross-platform Linux, macOS, Windows)
    wait_for_shutdown_signal().await;
    info!("Shutdown signal received; pausing engine and shutting down cleanly");
    let _ = cmd_tx.send(EngineCommand::Pause { reply: None }).await;
    let _ = cmd_tx.send(EngineCommand::Shutdown).await;
    drop(cmd_tx);
    if tokio::time::timeout(Duration::from_secs(3), &mut engine_task)
        .await
        .is_err()
    {
        engine_task.abort();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_client_normalizes_server_gateway_and_direct_bot_web_urls() {
        let (root1, eng1) = RemoteClient::normalize_urls("http://100.96.1.10:3000/").unwrap();
        assert_eq!(root1, "http://100.96.1.10:3000");
        assert_eq!(eng1, "http://100.96.1.10:3000/api/engine");

        let (root2, eng2) =
            RemoteClient::normalize_urls("http://100.96.1.10:3000/api/engine").unwrap();
        assert_eq!(root2, "http://100.96.1.10:3000");
        assert_eq!(eng2, "http://100.96.1.10:3000/api/engine");

        let (root3, eng3) = RemoteClient::normalize_urls("http://127.0.0.1:8080").unwrap();
        assert_eq!(root3, "http://127.0.0.1:8080");
        assert_eq!(eng3, "http://127.0.0.1:8080/api");

        assert!(RemoteClient::normalize_urls("ftp://100.96.1.10:3000").is_err());
    }

    #[test]
    fn cli_parses_connect_and_remote_subcommands_cleanly() {
        let parsed_connect = Cli::try_parse_from([
            "bot-desktop",
            "connect",
            "--url",
            "http://100.96.1.10:3000",
            "--name",
            "Tokyo VPS",
        ]);
        assert!(parsed_connect.is_ok());

        let parsed_remote = Cli::try_parse_from([
            "bot-desktop",
            "remote",
            "--url",
            "http://100.96.1.10:3000",
            "manual-order",
            "--symbol",
            "BTCUSDT",
            "--side",
            "long",
            "--notional",
            "200",
        ]);
        assert!(parsed_remote.is_ok());

        let parsed_trending = Cli::try_parse_from([
            "bot-desktop",
            "remote",
            "trending",
            "--category",
            "top_gainers",
            "--limit",
            "10",
        ]);
        assert!(parsed_trending.is_ok());

        let parsed_watchlist = Cli::try_parse_from([
            "bot-desktop",
            "remote",
            "watchlist",
            "--mode",
            "hybrid",
            "--pairs",
            "BTCUSDT,SOLUSDT",
        ]);
        assert!(parsed_watchlist.is_ok());
    }

    #[test]
    fn remote_client_builds_ws_telemetry_url_with_token() {
        let client = RemoteClient::new("https://vps.example.com", Some("sec ret".into())).unwrap();
        let ws_url = client.ws_telemetry_url();
        assert_eq!(ws_url, "wss://vps.example.com/ws/telemetry?token=sec+ret");
    }
}
