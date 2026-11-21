//! Thin CLI wrapper around [`bot_keygen`] so `bot-keygen` keeps working while
//! `apexrust keygen` shares the exact same implementation.

use bot_keygen::{generate, KeygenError, KeygenOptions};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "bot-keygen",
    about = "Generate an Ed25519 keypair for Binance WebSocket API session.logon",
    after_help = "Tip: `apexrust keygen` exposes the same generator with friendlier output."
)]
struct Cli {
    /// Target environment; used only for the default filename.
    #[arg(long, value_parser = ["testnet", "production", "prod"], default_value = "testnet")]
    environment: String,
    /// Directory that receives the PEM files. Created with 0700.
    #[arg(long, default_value = "rust-bot/keys")]
    out_dir: PathBuf,
    /// Optional filename suffix (e.g. `main`, `scalper`).
    #[arg(long, default_value = "")]
    label: String,
    /// Overwrite an existing keypair.
    #[arg(long, default_value_t = false)]
    force: bool,
}

fn main() {
    let cli = Cli::parse();
    let options = KeygenOptions {
        environment: cli.environment,
        out_dir: cli.out_dir,
        label: cli.label,
        force: cli.force,
    };

    match generate(&options) {
        Ok(keypair) => {
            println!("Ed25519 keypair generated");
            println!("  private key : {}", keypair.private_path.display());
            println!("  public key  : {}", keypair.public_path.display());
            println!("  fingerprint : {}", keypair.fingerprint);
            println!();
            println!("Register this public key in Binance API Management:");
            println!("{}", keypair.public_pem);
            println!(
                "Public key (base64, raw 32 bytes): {}",
                keypair.public_key_base64
            );
            println!();
            println!("Then set in bot.toml:");
            println!("  [exchange]");
            println!("  use_ws_api_orders = true");
            println!();
            println!("  [exchange.credentials]");
            println!("  auth_method = \"ed25519\"");
            println!("  api_key_env = \"BINANCE_API_KEY\"");
            println!(
                "  ed25519_key_path = \"{}\"",
                keypair.private_path.display()
            );
        }
        Err(KeygenError::AlreadyExists(path)) => {
            eprintln!(
                "{} already exists. Re-run with --force to rotate the key.",
                path.display()
            );
            std::process::exit(2);
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
