//! `apexrust` — one friendly Rust CLI for the ApexRust Quant engine.
//!
//! It bundles the previously scattered entry points (daemon, key generator,
//! remote client) and adds diagnostics so operators rarely need `cargo run`
//! or hand-written `curl` calls.

mod client;
mod cmd_config;
mod cmd_doctor;
mod cmd_key;
mod cmd_market;
mod cmd_ops;
mod cmd_run;
mod cmd_wsapi;
mod config_path;
mod market;
mod ui;

use clap::{Parser, Subcommand, ValueEnum};
use client::DaemonClient;
use std::path::PathBuf;
use ui::Ui;

#[derive(Debug, Parser)]
#[command(
    name = "apexrust",
    version,
    about = "ApexRust Quant — unified CLI for the Rust engine, keys and diagnostics",
    after_help = "Examples:\n  apexrust status\n  apexrust keygen --label main\n  apexrust ws-api logon\n  apexrust config validate\n  apexrust indicators BTCUSDT --timeframe 5m\n  apexrust order manual --symbol BTCUSDT --notional 15 --yes\n  apexrust risk pause\n  apexrust screen --category top_gainers --limit 10\n\nConfig resolution: --config, then APEXRUST_CONFIG, then rust-bot/config/bot.toml,\nfalling back to bot.example.toml. Daemon URL: --url, APEXRUST_ENGINE_URL, then\nweb.bind_addr from the config."
)]
struct Cli {
    /// Path to bot.toml (defaults to rust-bot/config/bot.toml or the example).
    #[arg(short, long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,

    /// Daemon base URL override (default http://127.0.0.1:8080).
    #[arg(long, global = true, value_name = "URL")]
    url: Option<String>,

    /// Access token for a protected daemon (APEXRUST_WEB_TOKEN).
    #[arg(
        long,
        global = true,
        value_name = "TOKEN",
        env = "APEXRUST_WEB_TOKEN",
        hide_env_values = true
    )]
    token: Option<String>,

    /// Machine-readable JSON output.
    #[arg(long, global = true)]
    json: bool,

    /// Disable ANSI colors (also honours NO_COLOR).
    #[arg(long, global = true)]
    no_color: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the Rust trading engine daemon (wraps bot-desktop).
    Run {
        /// Override the telemetry/API port (0 disables the web server).
        #[arg(long)]
        web_port: Option<u16>,
        /// Override the web bind address (e.g. 127.0.0.1:8080).
        #[arg(long)]
        web_bind: Option<String>,
    },
    /// Show daemon health, transport and risk state.
    Status,
    /// Print the engine snapshot as a table (or raw JSON with --json).
    Snapshot,
    /// Live refreshing dashboard of the running daemon.
    Watch {
        /// Refresh interval in seconds.
        #[arg(long, default_value_t = 2)]
        interval: u64,
    },
    /// Configuration helpers.
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },
    /// Key lifecycle helpers (generate, fingerprint, inspect).
    Key {
        #[command(subcommand)]
        action: KeyCmd,
    },
    /// Shortcut for `key gen`.
    Keygen {
        #[command(flatten)]
        args: KeygenArgs,
    },
    /// Binance WebSocket API diagnostics.
    #[command(name = "ws-api")]
    WsApi {
        #[command(subcommand)]
        action: WsApiCmd,
    },
    /// Rank tradable pairs from public 24h tickers.
    Screen {
        /// hot_volume | top_gainers | top_losers | volatility_leaders | cts_momentum
        #[arg(long, default_value = "hot_volume")]
        category: String,
        /// Number of rows.
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// Override the minimum 24h quote volume.
        #[arg(long)]
        min_quote_volume: Option<f64>,
        /// Quote asset filter (default from config, usually USDT).
        #[arg(long)]
        quote: Option<String>,
        /// Substring filter on the symbol.
        #[arg(long)]
        search: Option<String>,
    },
    /// Compute the indicator pipeline for a symbol without running the daemon.
    Indicators {
        /// Symbol, e.g. BTCUSDT.
        symbol: String,
        /// Candle interval (default from config).
        #[arg(long)]
        timeframe: Option<String>,
        /// How many candles to request (warmup is applied automatically).
        #[arg(long, default_value_t = 300)]
        limit: usize,
    },
    /// Dry-run the strategy and report whether it would open a position.
    Signal {
        /// Symbol, e.g. BTCUSDT.
        symbol: String,
        /// Candle interval (default from config).
        #[arg(long)]
        timeframe: Option<String>,
        /// How many candles to request.
        #[arg(long, default_value_t = 300)]
        limit: usize,
    },
    /// Manual trading through the running daemon.
    Order {
        #[command(subcommand)]
        action: OrderCmd,
    },
    /// Automated-entry and circuit-breaker controls.
    Risk {
        /// pause | resume | trip | reset
        #[arg(value_parser = ["pause", "resume", "trip", "reset"])]
        action: String,
        /// Reason recorded when tripping the circuit breaker.
        #[arg(long)]
        reason: Option<String>,
        /// Skip the interactive confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Trigger a sanitized Git backup on the daemon.
    Backup,
    /// Check config, binaries, credentials, REST and daemon connectivity.
    Doctor,
}

#[derive(Debug, Subcommand)]
enum ConfigCmd {
    /// Parse and validate the TOML, then print warnings.
    Validate,
    /// Print a secret-free summary of the active configuration.
    Show,
    /// Write a sanitized snapshot (credentials and web token removed).
    Sync {
        /// Output path (default rust-bot/config/bot.synced.toml).
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

#[derive(Debug, clap::Args)]
struct KeygenArgs {
    /// Target environment for the filename: testnet or production.
    #[arg(long, default_value = "testnet")]
    environment: String,
    /// Directory receiving the PEM files.
    #[arg(long, default_value = "rust-bot/keys")]
    out_dir: PathBuf,
    /// Optional filename suffix (e.g. main).
    #[arg(long, default_value = "")]
    label: String,
    /// Overwrite an existing keypair.
    #[arg(long)]
    force: bool,
}

#[derive(Debug, Subcommand)]
enum KeyCmd {
    /// Generate a new Ed25519 keypair.
    Gen {
        #[command(flatten)]
        args: KeygenArgs,
    },
    /// Print the fingerprint of a public key (defaults to the only key in rust-bot/keys).
    Fingerprint {
        /// Path to the .pub.pem file.
        path: Option<PathBuf>,
    },
    /// Derive the registered public key from a private key and compare the pair.
    Inspect {
        /// Path to the private PKCS#8 PEM.
        path: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum WsApiCmd {
    /// Public ping against the WS API endpoint (no credentials).
    Ping {
        /// Override the endpoint URL.
        #[arg(long)]
        endpoint: Option<String>,
    },
    /// Validate credentials, including `session.logon` for Ed25519 keys.
    Logon,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum MethodArg {
    Market,
    Limit,
    #[value(name = "limit-maker")]
    LimitMaker,
    Oco,
}

impl From<MethodArg> for bot_core::OrderExecutionMethod {
    fn from(value: MethodArg) -> Self {
        match value {
            MethodArg::Market => bot_core::OrderExecutionMethod::Market,
            MethodArg::Limit => bot_core::OrderExecutionMethod::Limit,
            MethodArg::LimitMaker => bot_core::OrderExecutionMethod::LimitMaker,
            MethodArg::Oco => bot_core::OrderExecutionMethod::Oco,
        }
    }
}

#[derive(Debug, Subcommand)]
enum OrderCmd {
    /// Submit a manual order (respects FeatureToggles and notional caps).
    Manual {
        /// Trading pair, e.g. BTCUSDT.
        #[arg(long)]
        symbol: String,
        /// long or short (Spot rejects shorts).
        #[arg(long, default_value = "long")]
        side: String,
        /// Order notional in USDT.
        #[arg(long)]
        notional: f64,
        /// Execution method.
        #[arg(long, value_enum, default_value = "market")]
        method: MethodArg,
        /// Limit price (required for limit / limit-marker).
        #[arg(long)]
        limit_price: Option<f64>,
        /// Take-profit price (OCO).
        #[arg(long)]
        take_profit_price: Option<f64>,
        /// Stop-loss price (OCO).
        #[arg(long)]
        stop_loss_price: Option<f64>,
        /// Skip the interactive confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Emergency flatten of every open position.
    Flatten {
        /// Skip the interactive confirmation.
        #[arg(long)]
        yes: bool,
    },
}

fn resolve_config(cli: &Cli) -> PathBuf {
    config_path::resolve_config(cli.config.as_deref())
}

fn daemon(cli: &Cli, config: Option<&bot_core::BotConfig>) -> anyhow::Result<DaemonClient> {
    let base = config_path::daemon_url(cli.url.as_deref(), config);
    DaemonClient::new(&base, cli.token.clone())
}

fn report(ui: Ui, err: anyhow::Error) {
    let message = err.to_string();
    let mut lines = message.lines();
    if let Some(first) = lines.next() {
        ui.error(first);
    }
    for line in lines {
        println!("       {line}");
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let ui = Ui::new(cli.no_color);
    let json = cli.json;

    let result: anyhow::Result<i32> = async {
        match &cli.command {
            Command::Run { web_port, web_bind } => {
                cmd_run::run(ui, &resolve_config(&cli), *web_port, web_bind.as_deref()).await?;
                Ok(0)
            }
            Command::Status => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                cmd_ops::status(ui, &client, json).await?;
                Ok(0)
            }
            Command::Snapshot => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                cmd_ops::snapshot(ui, &client, json).await?;
                Ok(0)
            }
            Command::Watch { interval } => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                cmd_ops::watch(ui, &client, *interval, json).await?;
                Ok(0)
            }
            Command::Config { action } => {
                let path = resolve_config(&cli);
                match action {
                    ConfigCmd::Validate => cmd_config::validate(ui, &path, json)?,
                    ConfigCmd::Show => cmd_config::show(ui, &path, json)?,
                    ConfigCmd::Sync { out } => cmd_config::sync(ui, &path, out.as_deref(), json)?,
                }
                Ok(0)
            }
            Command::Key { action } => {
                match action {
                    KeyCmd::Gen { args } => cmd_key::keygen(
                        ui,
                        &args.environment,
                        &args.out_dir,
                        &args.label,
                        args.force,
                        json,
                    )?,
                    KeyCmd::Fingerprint { path } => {
                        cmd_key::fingerprint(ui, path.as_deref(), json)?
                    }
                    KeyCmd::Inspect { path } => cmd_key::inspect(ui, path, json)?,
                }
                Ok(0)
            }
            Command::Keygen { args } => {
                cmd_key::keygen(
                    ui,
                    &args.environment,
                    &args.out_dir,
                    &args.label,
                    args.force,
                    json,
                )?;
                Ok(0)
            }
            Command::WsApi { action } => {
                let path = resolve_config(&cli);
                match action {
                    WsApiCmd::Ping { endpoint } => {
                        cmd_wsapi::ping(ui, &path, endpoint.as_deref(), json).await?
                    }
                    WsApiCmd::Logon => cmd_wsapi::logon(ui, &path, json).await?,
                }
                Ok(0)
            }
            Command::Screen {
                category,
                limit,
                min_quote_volume,
                quote,
                search,
            } => {
                cmd_market::screen(
                    ui,
                    &resolve_config(&cli),
                    cmd_market::ScreenOptions {
                        category,
                        limit: *limit,
                        min_quote_volume: *min_quote_volume,
                        quote: quote.as_deref(),
                        search: search.as_deref(),
                        json_out: json,
                    },
                )
                .await?;
                Ok(0)
            }
            Command::Indicators {
                symbol,
                timeframe,
                limit,
            } => {
                cmd_market::indicators(
                    ui,
                    &resolve_config(&cli),
                    symbol,
                    timeframe.as_deref(),
                    *limit,
                    json,
                )
                .await?;
                Ok(0)
            }
            Command::Signal {
                symbol,
                timeframe,
                limit,
            } => {
                cmd_market::signal(
                    ui,
                    &resolve_config(&cli),
                    symbol,
                    timeframe.as_deref(),
                    *limit,
                    json,
                )
                .await?;
                Ok(0)
            }
            Command::Order { action } => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                match action {
                    OrderCmd::Manual {
                        symbol,
                        side,
                        notional,
                        method,
                        limit_price,
                        take_profit_price,
                        stop_loss_price,
                        yes,
                    } => {
                        let order = cmd_ops::ManualOrder {
                            symbol: symbol.clone(),
                            side: side.clone(),
                            notional: *notional,
                            method: (*method).into(),
                            limit_price: *limit_price,
                            take_profit_price: *take_profit_price,
                            stop_loss_price: *stop_loss_price,
                        };
                        cmd_ops::submit_manual_order(ui, &client, order, *yes, json).await?;
                    }
                    OrderCmd::Flatten { yes } => {
                        cmd_ops::flatten(ui, &client, *yes, json).await?;
                    }
                }
                Ok(0)
            }
            Command::Risk {
                action,
                reason,
                yes,
            } => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                cmd_ops::risk_action(ui, &client, action, reason.as_deref(), *yes, json).await?;
                Ok(0)
            }
            Command::Backup => {
                let config = config_path::load(&resolve_config(&cli)).ok();
                let client = daemon(&cli, config.as_ref())?;
                cmd_ops::backup(ui, &client, json).await?;
                Ok(0)
            }
            Command::Doctor => {
                let ok =
                    cmd_doctor::doctor(ui, &resolve_config(&cli), cli.url.as_deref(), json).await?;
                Ok(if ok { 0 } else { 1 })
            }
        }
    }
    .await;

    match result {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            report(ui, err);
            std::process::exit(1);
        }
    }
}
