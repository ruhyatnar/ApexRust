//! `apexrust ws-api ping|logon` — verify the Binance WebSocket API before trading.

use crate::config_path::load;
use crate::ui::Ui;
use anyhow::{anyhow, Context};
use bot_core::BotConfig;
use bot_exchange::ws_api::{default_ws_api_url, mask_key, WsApiClient, WsApiCredentials};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn endpoint(config: &BotConfig) -> String {
    let configured = config.exchange.ws_api_url.trim();
    if configured.is_empty() {
        default_ws_api_url(config.exchange.venue, config.exchange.environment).to_string()
    } else {
        configured.to_string()
    }
}

pub async fn ping(
    ui: Ui,
    config_path: &Path,
    url_override: Option<&str>,
    json_out: bool,
) -> anyhow::Result<()> {
    let config = load(config_path)?;
    let url = url_override
        .map(str::to_string)
        .unwrap_or_else(|| endpoint(&config));

    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(12), connect_async(&url))
        .await
        .map_err(|_| anyhow!("Timeout saat connect ke {url}"))?
        .with_context(|| format!("Gagal connect ke {url}"))?;
    socket
        .send(Message::text(
            json!({ "id": "apexrust-ping", "method": "ping" }).to_string(),
        ))
        .await
        .context("Gagal mengirim request ping")?;

    let frame = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .map_err(|_| anyhow!("Tidak ada balasan ping dalam 10s"))?
        .ok_or_else(|| anyhow!("Koneksi ditutup sebelum ada balasan"))?
        .context("Gagal membaca balasan ping")?;

    let text = frame.into_text().unwrap_or_default();
    let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let status = payload.get("status").and_then(Value::as_i64).unwrap_or(0);
    let _ = socket.close(None).await;

    if json_out {
        println!("{payload}");
        return Ok(());
    }
    ui.kv("Endpoint", &url);
    if status == 200 {
        ui.ok("WS API reachable (public ping).");
        if let Some(limits) = payload.get("rateLimits").and_then(Value::as_array) {
            for limit in limits.iter().take(3) {
                let kind = limit
                    .get("rateLimitType")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let count = limit.get("count").and_then(Value::as_i64).unwrap_or(0);
                let cap = limit.get("limit").and_then(Value::as_i64).unwrap_or(0);
                ui.kv("Rate limit", &format!("{kind}: {count}/{cap} per minute"));
            }
        }
        ui.hint("Untuk menguji kredensial: `apexrust ws-api logon`.");
    } else {
        ui.error(&format!("WS API membalas status {status}: {payload}"));
    }
    Ok(())
}

pub async fn logon(ui: Ui, config_path: &Path, json_out: bool) -> anyhow::Result<()> {
    let config = load(config_path)?;
    let mut exchange = config.exchange.clone();
    // Diagnostics intentionally bypass the order-routing toggle so a user can
    // validate credentials before enabling WS API order submission.
    exchange.use_ws_api_orders = true;

    let creds = WsApiCredentials::from_exchange_config(&exchange)
        .map_err(|e| anyhow!("Kredensial tidak valid: {e}"))?;
    let Some(creds) = creds else {
        explain_missing_credentials(ui, &config);
        return Err(anyhow!("Kredensial WS API belum lengkap."));
    };

    let url = endpoint(&config);
    let mode = if creds.supports_session_logon() {
        "session.logon (Ed25519)"
    } else {
        "signed per-request (HMAC)"
    };

    if !json_out {
        ui.kv("Endpoint", &url);
        ui.kv("API key", &mask_key(&creds.api_key));
        ui.kv("Auth mode", mode);
        if !creds.supports_session_logon() {
            ui.warn("session.logon hanya untuk Ed25519; kredensial HMAC akan diuji lewat signed request.");
        }
        ui.info("Menghubungkan dan mengautentikasi...");
    }

    let client = WsApiClient::from_config(&exchange)
        .map_err(|e| anyhow!("Gagal menyiapkan WS API client: {e}"))?
        .ok_or_else(|| anyhow!("WS API client tidak terbentuk; periksa kredensial."))?;

    let result =
        tokio::time::timeout(Duration::from_secs(20), client.request("ping", json!({}))).await;
    match result {
        Ok(Ok(_)) => {
            if json_out {
                println!(
                    "{}",
                    json!({
                        "ok": true,
                        "endpoint": url,
                        "api_key": mask_key(&creds.api_key),
                        "auth_mode": mode,
                    })
                );
                return Ok(());
            }
            ui.ok(&format!("Autentikasi berhasil — {mode}."));
            ui.kv("API key", &mask_key(&creds.api_key));
            ui.kv("Endpoint", &url);
            ui.hint("Kredensial siap dipakai. Sekarang `apexrust order manual ...` atau `apexrust run`.");
            Ok(())
        }
        Ok(Err(err)) => {
            let message = err.to_string();
            ui.error(&format!("Autentikasi gagal: {message}"));
            for hint in error_hints(&message) {
                ui.hint(&hint);
            }
            Err(anyhow!("WS API authentication failed"))
        }
        Err(_) => {
            ui.error("Autentikasi timeout setelah 20s.");
            ui.hint("Cek koneksi internet dan jam sistem (skew > 30s biasanya ditolak).");
            Err(anyhow!("WS API authentication timed out"))
        }
    }
}

fn explain_missing_credentials(ui: Ui, config: &BotConfig) {
    match config.exchange.credentials.as_ref() {
        None => {
            ui.error("Bagian [exchange.credentials] belum ada di config.");
            ui.hint("Tambahkan auth_method, api_key_env, dan ed25519_key_path seperti di bot.example.toml.");
        }
        Some(creds) => {
            let key_env = &creds.api_key_env;
            let has_key = std::env::var(key_env)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if !has_key {
                ui.error(&format!("Env {key_env} kosong atau belum di-set."));
                ui.hint(&format!(
                    "Contoh: export {key_env}=... (jangan tulis di repo)."
                ));
            }
            if creds.ed25519_key_path.is_none() {
                ui.error("ed25519_key_path kosong.");
                ui.hint("Jalankan `apexrust keygen`, lalu set ed25519_key_path di [exchange.credentials].");
            } else if let Some(path) = creds.ed25519_key_path.as_deref() {
                if !Path::new(path).exists() {
                    ui.error(&format!("Private key tidak ditemukan: {path}"));
                    ui.hint("Cek path relatif terhadap direktori kerja (`rust-bot/`) atau gunakan path absolut.");
                }
            }
        }
    }
}

fn error_hints(message: &str) -> Vec<String> {
    let mut hints = Vec::new();
    if message.contains("-2015") {
        hints.push("Key tidak berwenang: cek public key yang terdaftar, permission Spot Trading, dan IP whitelist.".to_string());
        hints.push(
            "Pastikan key berasal dari environment yang sama (Testnet vs Production).".to_string(),
        );
        hints.push("Bandingkan fingerprint: `apexrust key inspect <private.pem>`.".to_string());
    }
    if message.contains("-1022") {
        hints.push("Signature ditolak: biasanya payload atau keypair tidak cocok.".to_string());
        hints.push(
            "Jalankan `apexrust key inspect <private.pem>` lalu daftarkan ulang public key-nya."
                .to_string(),
        );
    }
    if message.contains("-1021") {
        hints.push("Timestamp di luar recvWindow: sinkronkan jam sistem (NTP).".to_string());
    }
    if message.contains("-1100") {
        hints.push(
            "Parameter tidak valid: cek apiKey (36-64 karakter alfanumerik) dan format secret."
                .to_string(),
        );
    }
    if hints.is_empty() {
        hints.push(
            "Jalankan `apexrust ws-api ping` untuk memastikan endpoint bisa dihubungi.".to_string(),
        );
    }
    hints
}

#[cfg(test)]
mod tests {
    use super::*;
    use bot_core::{ExchangeEnvironment, ExchangeVenue};

    #[test]
    fn endpoint_prefers_config_value_and_falls_back_to_default() {
        let mut config =
            load(&crate::config_path::repo_root().join("rust-bot/config/bot.example.toml"))
                .expect("example config");
        let expected = config.exchange.ws_api_url.trim().to_string();
        assert_eq!(endpoint(&config), expected);

        config.exchange.ws_api_url = String::new();
        assert_eq!(
            endpoint(&config),
            default_ws_api_url(ExchangeVenue::Spot, ExchangeEnvironment::Testnet)
        );
    }

    #[test]
    fn hints_cover_known_binance_codes() {
        for code in ["-2015", "-1022", "-1021", "-1100"] {
            let hints = error_hints(&format!("failed with status 400 {code}"));
            assert!(!hints.is_empty());
        }
        assert_eq!(error_hints("boom").len(), 1);
    }
}
