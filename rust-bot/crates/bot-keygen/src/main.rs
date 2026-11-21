//! Generates an Ed25519 keypair for Binance WebSocket API `session.logon`.
//!
//! Usage:
//!   cargo run -p bot-keygen -- --environment testnet
//!   cargo run -p bot-keygen -- --environment production --out-dir rust-bot/keys --label main
//!
//! The private key is written as a PKCS#8 PEM with `0600` permissions and is
//! never printed. Register the printed **public key** in Binance API Management,
//! then point `exchange.credentials.ed25519_key_path` at the private key file.

use base64::Engine as _;
use clap::Parser;
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "bot-keygen",
    about = "Generate an Ed25519 keypair for Binance WebSocket API session.logon"
)]
struct Cli {
    /// Target environment; used only for the default filename.
    #[arg(long, value_parser = ["testnet", "production"], default_value = "testnet")]
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

fn pem_wrap(label: &str, der: &[u8]) -> String {
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(&String::from_utf8_lossy(chunk));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn main() {
    let cli = Cli::parse();
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let seed = signing_key.to_bytes();
    let public = verifying_key.to_bytes();

    // RFC 8410 PKCS#8 v1: 302e020100300506032b657004220420 || seed
    let mut pkcs8 = hex(
        "302e020100300506032b657004220420",
    );
    pkcs8.extend_from_slice(&seed);
    // RFC 8410 SubjectPublicKeyInfo: 302a300506032b6570032100 || public
    let mut spki = hex("302a300506032b6570032100");
    spki.extend_from_slice(&public);

    if let Err(err) = fs::create_dir_all(&cli.out_dir) {
        eprintln!("Failed to create {}: {err}", cli.out_dir.display());
        std::process::exit(1);
    }
    set_mode(&cli.out_dir, 0o700);

    let suffix = if cli.label.trim().is_empty() {
        String::new()
    } else {
        format!("-{}", cli.label.trim())
    };
    let private_path = cli
        .out_dir
        .join(format!("ed25519-{}{}.pem", cli.environment, suffix));
    let public_path = cli.out_dir.join(format!(
        "ed25519-{}{}.pub.pem",
        cli.environment, suffix
    ));

    if private_path.exists() && !cli.force {
        eprintln!(
            "{} already exists. Re-run with --force to rotate the key.",
            private_path.display()
        );
        std::process::exit(2);
    }

    let private_pem = pem_wrap("PRIVATE KEY", &pkcs8);
    let public_pem = pem_wrap("PUBLIC KEY", &spki);

    if let Err(err) = fs::write(&private_path, private_pem) {
        eprintln!("Failed to write {}: {err}", private_path.display());
        std::process::exit(1);
    }
    set_mode(&private_path, 0o600);
    if let Err(err) = fs::write(&public_path, &public_pem) {
        eprintln!("Failed to write {}: {err}", public_path.display());
        std::process::exit(1);
    }
    set_mode(&public_path, 0o644);

    let fingerprint = hex_string(&Sha256::digest(spki)[..8]);
    println!("Ed25519 keypair generated");
    println!("  private key : {}", private_path.display());
    println!("  public key  : {}", public_path.display());
    println!("  fingerprint : {fingerprint}");
    println!();
    println!("Register this public key in Binance API Management:");
    println!("{public_pem}");
    println!("Public key (base64, raw 32 bytes): {}", base64::engine::general_purpose::STANDARD.encode(public));
    println!();
    println!("Then set in bot.toml:");
    println!("  [exchange]");
    println!("  use_ws_api_orders = true");
    println!();
    println!("  [exchange.credentials]");
    println!("  auth_method = \"ed25519\"");
    println!("  api_key_env = \"BINANCE_API_KEY\"");
    println!("  ed25519_key_path = \"{}\"", private_path.display());
}

fn hex(raw: &str) -> Vec<u8> {
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).expect("valid hex literal"))
        .collect()
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn set_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(mode);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_mode(_path: &std::path::Path, _mode: u32) {}
