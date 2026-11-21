//! `apexrust run` — launch the Rust daemon without remembering cargo paths.

use crate::ui::Ui;
use anyhow::{anyhow, Context};
use std::path::{Path, PathBuf};
use std::process::Stdio;

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "bot-desktop.exe"
    } else {
        "bot-desktop"
    }
}

/// Locates `bot-desktop` next to this binary, in the repo target dirs, or on PATH.
pub fn locate_daemon_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("APEXRUST_BOT_DESKTOP") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.exists() {
                return Some(path);
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join(binary_name()), dir.join("bot-desktop")] {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            // `target/debug/apexrust` → `target/release/bot-desktop` and vice versa.
            if let Some(target_dir) = dir.parent() {
                for profile in ["release", "debug"] {
                    let candidate = target_dir.join(profile).join(binary_name());
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    let rust_dir = crate::config_path::repo_root().join("rust-bot");
    for profile in ["release", "debug"] {
        let candidate = rust_dir.join("target").join(profile).join(binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    which(binary_name())
}

fn which(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}

pub async fn run(
    ui: Ui,
    config: &Path,
    web_port: Option<u16>,
    web_bind: Option<&str>,
) -> anyhow::Result<()> {
    let Some(binary) = locate_daemon_binary() else {
        return Err(anyhow!(
            "Binary bot-desktop tidak ditemukan.\n       Build dulu: (cd rust-bot && cargo build --release -p bot-desktop)\n       atau jalankan `./apexrust setup`."
        ));
    };

    if !config.exists() {
        return Err(anyhow!(
            "Config tidak ditemukan: {}\n       Salin rust-bot/config/bot.example.toml ke rust-bot/config/bot.toml dulu.",
            config.display()
        ));
    }

    let mut command = tokio::process::Command::new(&binary);
    command
        .arg("--config")
        .arg(config)
        .arg("--daemon")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(port) = web_port {
        command.arg("--web-port").arg(port.to_string());
    }
    if let Some(bind) = web_bind {
        command.arg("--web-bind").arg(bind);
    }

    ui.info(&format!(
        "Menjalankan {} (Ctrl+C untuk berhenti)",
        binary.display()
    ));
    ui.kv("Config", &config.display().to_string());
    if let Some(port) = web_port {
        ui.kv("Web port", &port.to_string());
    }
    if let Some(bind) = web_bind {
        ui.kv("Web bind", bind);
    }

    let status = command
        .status()
        .await
        .with_context(|| format!("Gagal menjalankan {}", binary.display()))?;
    if !status.success() {
        return Err(anyhow!(
            "Daemon keluar dengan status {}. Cek log di atas untuk detailnya.",
            status
        ));
    }
    Ok(())
}
