//! Automated Git configuration & strategy backup helper for Linux Desktop and WebApp nodes.
//! Stages sanitized TOML/JSON configuration files (never secrets) and commits/pushes
//! snapshots to the configured backup branch.

use bot_core::{BotError, GitBackupConfig, Result};
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

static GIT_BACKUP_LOCK: Mutex<()> = Mutex::new(());

fn is_secret_path(rel: &str) -> bool {
    let lower = rel.trim().to_ascii_lowercase();
    let name = Path::new(&lower)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    name == ".env"
        || name.starts_with(".env.")
        || name == "bot.toml"
        || name == "bot.toml.bak"
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

#[derive(Debug, Clone)]
pub struct GitSyncOutcome {
    pub committed: bool,
    pub pushed: bool,
    pub summary: String,
}

pub struct GitBackupSync {
    cfg: GitBackupConfig,
}

impl GitBackupSync {
    pub fn new(cfg: GitBackupConfig) -> Self {
        Self { cfg }
    }

    /// Stage sanitized configuration files inside `repo_root` and optionally push to remote.
    pub fn backup_snapshot(&self, repo_root: &Path, message: &str) -> Result<GitSyncOutcome> {
        if !self.cfg.enabled {
            return Ok(GitSyncOutcome {
                committed: false,
                pushed: false,
                summary: "Git backup disabled in configuration".into(),
            });
        }

        let clean_dir = self.cfg.backup_dir.trim();
        if clean_dir.is_empty()
            || Path::new(clean_dir).is_absolute()
            || clean_dir.contains("..")
            || is_secret_path(clean_dir)
        {
            return Err(BotError::Config(format!(
                "Unsafe git backup_dir '{}'",
                self.cfg.backup_dir
            )));
        }

        let _guard = GIT_BACKUP_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Never commit if any local secret file is accidentally tracked in Git index
        for sensitive in [
            ".env",
            "rust-bot/config/bot.toml",
            "rust-bot/config/bot.toml.bak",
            "config/bot.toml",
            "config/bot.toml.bak",
        ] {
            if repo_root.join(sensitive).exists() {
                let tracked = Command::new("git")
                    .current_dir(repo_root)
                    .args(["ls-files", "--error-unmatch", "--", sensitive])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if tracked {
                    return Err(BotError::Config(format!(
                        "Refusing git backup because sensitive file '{sensitive}' is tracked in git index"
                    )));
                }
            }
        }

        let mut targets: Vec<&str> = Vec::new();
        let backup_path = repo_root.join(clean_dir);
        if backup_path.exists() {
            targets.push(clean_dir);
        }
        let synced_rel = if repo_root.join("rust-bot/config/bot.synced.toml").exists() {
            Some("rust-bot/config/bot.synced.toml")
        } else if repo_root.join("config/bot.synced.toml").exists() {
            Some("config/bot.synced.toml")
        } else {
            None
        };
        if let Some(rel) = synced_rel {
            targets.push(rel);
        }
        if targets.is_empty() {
            return Ok(GitSyncOutcome {
                committed: false,
                pushed: false,
                summary: "No existing backup artifacts found to stage".into(),
            });
        }

        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend_from_slice(&targets);
        let add_status = Command::new("git")
            .current_dir(repo_root)
            .args(&add_args)
            .status()
            .map_err(|e| BotError::Config(format!("Failed to invoke git add: {e}")))?;

        if !add_status.success() {
            return Err(BotError::Config("git add returned non-zero status".into()));
        }

        let mut staged_args = vec!["diff", "--cached", "--name-only", "--"];
        staged_args.extend_from_slice(&targets);
        let staged_out = Command::new("git")
            .current_dir(repo_root)
            .args(&staged_args)
            .output()
            .map_err(|e| BotError::Config(format!("Failed to inspect git diff: {e}")))?;
        let staged_files = String::from_utf8_lossy(&staged_out.stdout);
        for file in staged_files.lines() {
            if is_secret_path(file) {
                let mut reset_args = vec!["reset", "HEAD", "--"];
                reset_args.push(file);
                let _ = Command::new("git")
                    .current_dir(repo_root)
                    .args(&reset_args)
                    .status();
                return Err(BotError::Config(format!(
                    "Aborted git backup: secret path '{file}' was matched inside backup target"
                )));
            }
        }

        let mut diff_args = vec!["diff", "--cached", "--quiet", "--"];
        diff_args.extend_from_slice(&targets);
        let diff_clean = Command::new("git")
            .current_dir(repo_root)
            .args(&diff_args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        let mut committed = false;
        if !diff_clean {
            // `--only` commits strictly backup targets without sweeping unrelated staged index changes
            let mut commit_args = vec!["commit", "--only", "-m", message, "--"];
            commit_args.extend_from_slice(&targets);
            let commit_status = Command::new("git")
                .current_dir(repo_root)
                .args(&commit_args)
                .status()
                .map_err(|e| BotError::Config(format!("Failed to invoke git commit: {e}")))?;
            committed = commit_status.success();
        }

        let mut pushed = false;
        if self.cfg.auto_push && committed {
            let push_status = Command::new("git")
                .current_dir(repo_root)
                .args(["push", "-u", &self.cfg.remote_name, &self.cfg.branch])
                .status()
                .map_err(|e| BotError::Config(format!("Failed to invoke git push: {e}")))?;
            pushed = push_status.success();
        }

        Ok(GitSyncOutcome {
            committed,
            pushed,
            summary: format!("committed={committed}, pushed={pushed}"),
        })
    }
}
