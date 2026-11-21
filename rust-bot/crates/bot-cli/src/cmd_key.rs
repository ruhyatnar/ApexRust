//! `apexrust keygen` / `apexrust key ...` — Ed25519 key lifecycle commands.

use crate::ui::{is_interactive, Ui};
use anyhow::{anyhow, Context};
use bot_keygen::{KeygenError, KeygenOptions};
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};

pub fn keygen(
    ui: Ui,
    environment: &str,
    out_dir: &Path,
    label: &str,
    force: bool,
    json: bool,
) -> anyhow::Result<()> {
    let options = KeygenOptions {
        environment: environment.to_string(),
        out_dir: out_dir.to_path_buf(),
        label: label.to_string(),
        force,
    };
    let keypair = match bot_keygen::generate(&options) {
        Ok(keypair) => keypair,
        Err(KeygenError::AlreadyExists(path)) => {
            return Err(anyhow!(
                "{} sudah ada. Pakai --force untuk merotasi key (public key lama akan berhenti valid).",
                path.display()
            ));
        }
        Err(err) => return Err(anyhow!(err)),
    };

    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "private_key": keypair.private_path,
                "public_key": keypair.public_path,
                "fingerprint": keypair.fingerprint,
                "public_pem": keypair.public_pem,
                "public_key_base64": keypair.public_key_base64,
            })
        );
        return Ok(());
    }

    ui.ok("Ed25519 keypair dibuat.");
    ui.kv("Private key", &keypair.private_path.display().to_string());
    ui.kv("Public key", &keypair.public_path.display().to_string());
    ui.kv("Fingerprint", &keypair.fingerprint);
    ui.hint("Private key ditulis dengan mode 0600 dan tidak pernah dicetak.");
    ui.section("Langkah berikutnya");
    println!("  1. Daftarkan public key ini di Binance API Management (self-generated / Ed25519):");
    println!();
    for line in keypair.public_pem.lines() {
        println!("     {line}");
    }
    println!();
    println!(
        "     Fingerprint untuk memastikan yang terdaftar sama: {}",
        keypair.fingerprint
    );
    println!("  2. Set di config:");
    println!("       [exchange]");
    println!("       use_ws_api_orders = true");
    println!();
    println!("       [exchange.credentials]");
    println!("       auth_method = \"ed25519\"");
    println!(
        "       ed25519_key_path = \"{}\"",
        keypair.private_path.display()
    );
    println!("  3. Validasi tanpa memulai bot:");
    println!("       apexrust ws-api logon");
    Ok(())
}

/// Resolves the public key path when the user does not pass one explicitly.
fn default_public_key() -> anyhow::Result<PathBuf> {
    let dir = crate::config_path::repo_root().join("rust-bot/keys");
    let mut matches: Vec<PathBuf> = std::fs::read_dir(&dir)
        .with_context(|| format!("Tidak bisa membaca {}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().map(|ext| ext == "pem").unwrap_or(false)
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains(".pub."))
                    .unwrap_or(false)
        })
        .collect();
    matches.sort();
    match matches.len() {
        0 => Err(anyhow!(
            "Tidak ada public key di {}. Jalankan `apexrust keygen` dulu atau berikan path eksplisit.",
            dir.display()
        )),
        1 => Ok(matches.remove(0)),
        _ => Err(anyhow!(
            "Ada {} public key di {}; sebutkan salah satu: {}",
            matches.len(),
            dir.display(),
            matches
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn fingerprint(ui: Ui, path: Option<&Path>, json: bool) -> anyhow::Result<()> {
    let path = match path {
        Some(path) => path.to_path_buf(),
        None => default_public_key()?,
    };
    let pem = std::fs::read_to_string(&path)
        .with_context(|| format!("Tidak bisa membaca {}", path.display()))?;
    if pem.contains("PRIVATE KEY") {
        return Err(anyhow!(
            "{} adalah private key. Pakai `apexrust key inspect {}` untuk menurunkan public key-nya.",
            path.display(),
            path.display()
        ));
    }
    let fingerprint = bot_keygen::fingerprint_from_public_pem(&pem)
        .map_err(|e| anyhow!("Public key tidak valid di {}: {e}", path.display()))?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "ok": true, "path": path, "fingerprint": fingerprint })
        );
    } else {
        ui.kv("Public key", &path.display().to_string());
        ui.kv("Fingerprint", &fingerprint);
        ui.hint("Cocokkan nilai ini dengan halaman API Management Binance.");
    }
    Ok(())
}

pub fn inspect(ui: Ui, private_path: &Path, json: bool) -> anyhow::Result<()> {
    let pem = std::fs::read_to_string(private_path)
        .with_context(|| format!("Tidak bisa membaca {}", private_path.display()))?;
    let signing_key = SigningKey::from_pkcs8_pem(&pem)
        .map_err(|e| anyhow!("Private key bukan PKCS#8 Ed25519 PEM yang valid: {e}"))?;
    let public = signing_key.verifying_key().to_bytes();
    let fingerprint = bot_keygen::fingerprint_from_public_bytes(&public);
    let public_pem = bot_keygen::public_pem_from_bytes(&public);

    let sibling = private_path.with_file_name(
        private_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("{}.pub.pem", n.trim_end_matches(".pem")))
            .unwrap_or_else(|| String::from("public.pub.pem")),
    );
    let sibling_match = if sibling.exists() {
        Some(
            bot_keygen::fingerprint_from_public_pem_file(&sibling)
                .map(|other| other == fingerprint)
                .unwrap_or(false),
        )
    } else {
        None
    };

    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "private_key": private_path,
                "public_key": sibling,
                "fingerprint": fingerprint,
                "public_pem": public_pem,
                "sibling_matches": sibling_match,
            })
        );
        return Ok(());
    }

    ui.kv("Private key", &private_path.display().to_string());
    ui.kv("Fingerprint", &fingerprint);
    match sibling_match {
        Some(true) => ui.ok(&format!("Public key pasangan cocok: {}", sibling.display())),
        Some(false) => ui.warn(&format!(
            "Public key di {} BUKAN pasangan private key ini. Ini penyebab umum error -2015.",
            sibling.display()
        )),
        None => ui.hint(
            "Tidak ada file .pub.pem di sebelah private key; hanya turunan yang ditampilkan.",
        ),
    }
    ui.section("Public key (yang harus terdaftar di Binance)");
    for line in public_pem.lines() {
        println!("  {line}");
    }
    Ok(())
}

/// Shared confirmation helper for destructive commands.
///
/// Returns `false` when the user declined, so callers can exit cleanly.
pub fn require_confirmation(ui: Ui, question: &str, yes: bool) -> anyhow::Result<bool> {
    if yes {
        return Ok(true);
    }
    if !is_interactive() {
        return Err(anyhow!(
            "Butuh konfirmasi. Jalankan ulang dengan --yes untuk mode non-interaktif."
        ));
    }
    if crate::ui::confirm(question) {
        Ok(true)
    } else {
        ui.warn("Dibatalkan.");
        Ok(false)
    }
}
