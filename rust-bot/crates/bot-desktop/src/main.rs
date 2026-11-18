//! Linux Desktop & Headless Server binary for ApexRust Quant.
//!
//! Launches the multi-pair WebSocket/REST trading engine and optionally binds
//! the `bot-web` Axum telemetry server so the React WebApp can attach locally.

use anyhow::Context;
use bot_core::BotConfig;
use bot_engine::{EngineCommand, TradingEngine};
use bot_web::WebState;
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;

#[derive(Debug, Parser)]
#[command(name = "bot-desktop", version, about = "ApexRust Quant Multi-Pair Binance Trading Bot")]
struct Cli {
    /// Path to TOML configuration file
    #[arg(short, long, default_value = "config/bot.example.toml")]
    config: PathBuf,

    /// Optional WebApp telemetry bind port override (e.g. 8080). Set 0 to disable web server; omit to use config web.bind_addr.
    #[arg(long)]
    web_port: Option<u16>,
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
    let config_path = if !cli.config.exists()
        && cli.config == PathBuf::from("config/bot.example.toml")
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
    let bind_addr = match cli.web_port {
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
    };
    if let Some(addr) = bind_addr {
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        let app = bot_web::router(WebState {
            engine: Arc::clone(&engine),
            cmd_tx: cmd_tx.clone(),
        });
        info!(%addr, "Serving WebApp telemetry API & WebSocket");
        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                tracing::error!(%err, "Web server terminated");
            }
        });
    }

    // Spawn trading engine
    let engine_task = tokio::spawn({
        let eng = Arc::clone(&engine);
        async move { eng.run(cmd_rx).await }
    });

    // Wait for Linux SIGINT / SIGTERM for graceful shutdown
    tokio::signal::ctrl_c().await?;
    info!("Shutdown signal received; flattening/halting cleanly");
    let _ = cmd_tx.send(EngineCommand::Pause).await;
    engine_task.abort();

    Ok(())
}
