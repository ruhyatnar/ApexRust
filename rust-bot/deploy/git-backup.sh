#!/usr/bin/env bash
# Sanitized Git Sync & Backup Helper for ApexRust Quant
# Safely commits sanitized bot configurations & trade summaries without secrets.
set -euo pipefail

REPO_ROOT="${1:-$(pwd)}"
BRANCH="${GIT_BACKUP_BRANCH:-main}"
REMOTE="${GIT_BACKUP_REMOTE:-origin}"
PUSH_ENABLED="${GIT_BACKUP_PUSH:-false}"

cd "$REPO_ROOT"

if [ ! -d ".git" ]; then
  git init -b "$BRANCH"
fi

# Ensure secret files & local runtime DBs are always excluded
touch .gitignore
for pattern in ".env" ".env.*" "!.env.example" "*.pem" "*.key" "rust-bot/config/bot.toml" "rust-bot/config/bot.toml.bak" "bot.toml" "bot.toml.bak" "backups/*.secret*" ".apexrust-order-logs.json" ".apexrust-orders.sqlite" ".apexrust-orders.sqlite-*"; do
  if ! grep -Fxq "$pattern" .gitignore 2>/dev/null; then
    echo "$pattern" >> .gitignore
  fi
done

git add .gitignore backups/ rust-bot/config/bot.example.toml rust-bot/config/bot.synced.toml 2>/dev/null || true

if git diff --cached --quiet; then
  echo "[git-backup] Working tree clean; no new snapshot to commit."
  exit 0
fi

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git commit -m "chore(backup): sanitized config & bot snapshot ${STAMP}"

if [ "$PUSH_ENABLED" = "true" ] && git remote get-url "$REMOTE" >/dev/null 2>&1; then
  git push -u "$REMOTE" "$BRANCH"
  echo "[git-backup] Pushed sanitized backup to ${REMOTE}/${BRANCH}"
else
  echo "[git-backup] Committed sanitized backup locally on branch ${BRANCH}"
fi
