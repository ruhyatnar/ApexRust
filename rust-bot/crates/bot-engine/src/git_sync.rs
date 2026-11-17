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

        let add_status = Command::new("git")
            .current_dir(repo_root)
            .args(["add", &self.cfg.backup_dir, "config/bot.synced.toml"])
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
