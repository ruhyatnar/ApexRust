//! Automated Git configuration & strategy backup helper for Linux Desktop and WebApp nodes.
//! Stages sanitized TOML/JSON configuration files (never secrets) and commits/pushes
//! snapshots to the configured backup branch.

use bot_core::{BotError, GitBackupConfig, Result};
use std::path::Path;
use std::process::Command;

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

        let mut args: Vec<&str> = vec!["add"];
        let backup_path = repo_root.join(&self.cfg.backup_dir);
        if backup_path.exists() {
            args.push(self.cfg.backup_dir.as_str());
        }
        let synced_rel = if repo_root.join("rust-bot/config/bot.synced.toml").exists() {
            Some("rust-bot/config/bot.synced.toml")
        } else if repo_root.join("config/bot.synced.toml").exists() {
            Some("config/bot.synced.toml")
        } else {
            None
        };
        if let Some(rel) = synced_rel {
            args.push(rel);
        }
        if args.len() == 1 {
            return Ok(GitSyncOutcome {
                committed: false,
                pushed: false,
                summary: "No existing backup artifacts found to stage".into(),
            });
        }

        let add_status = Command::new("git")
            .current_dir(repo_root)
            .args(&args)
            .status()
            .map_err(|e| BotError::Config(format!("Failed to invoke git add: {e}")))?;

        if !add_status.success() {
            return Err(BotError::Config("git add returned non-zero status".into()));
        }

        let diff_clean = Command::new("git")
            .current_dir(repo_root)
            .args(["diff", "--cached", "--quiet"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        let mut committed = false;
        if !diff_clean {
            let commit_status = Command::new("git")
                .current_dir(repo_root)
                .args(["commit", "-m", message])
                .status()
                .map_err(|e| BotError::Config(format!("Failed to invoke git commit: {e}")))?;
            committed = commit_status.success();
        }

        let mut pushed = false;
        if self.cfg.auto_push {
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
