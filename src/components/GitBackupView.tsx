import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CloudUpload,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Link2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../engine/apiClient';
import type { BotConfig, EngineSnapshot } from '../engine/types';

interface GitCommitEntry {
  hash: string;
  message: string;
}

interface GitStatusPayload {
  initialized: boolean;
  branch: string | null;
  remoteUrl: string | null;
  dirtyCount: number;
  changedFiles: string[];
  commits: GitCommitEntry[];
}

interface GitBackupViewProps {
  config: BotConfig;
  snapshot: EngineSnapshot;
  serverTargetLabel?: string;
}

export const GitBackupView: React.FC<GitBackupViewProps> = ({
  config,
  snapshot,
  serverTargetLabel = '🖥️ This Computer',
}) => {
  const [status, setStatus] = useState<GitStatusPayload | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [remoteUrlInput, setRemoteUrlInput] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/git/status');
      if (!resp.ok) return;
      const data = (await resp.json()) as { ok?: boolean; status?: GitStatusPayload };
      const resolved = data.status;
      if (!resolved) return;
      setStatus(resolved);
      if (resolved.remoteUrl) {
        setRemoteUrlInput((prev) => prev || resolved.remoteUrl || '');
      }
    } catch {
      // Ignore offline check
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleInitRepo = async () => {
    setBusy('init');
    setFeedback(null);
    try {
      const resp = await apiFetch('/api/git/init', { method: 'POST' });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        status?: GitStatusPayload;
      };
      if (data.status) setStatus(data.status);
      if (resp.ok && data.ok) {
        setFeedback({ type: 'ok', text: 'Git repository initialized with secret-safe .gitignore rules.' });
      } else {
        setFeedback({ type: 'err', text: data.error ?? 'Failed to initialize Git repository' });
      }
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Git init failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('remote');
    setFeedback(null);
    try {
      const resp = await apiFetch('/api/git/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl: remoteUrlInput }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        status?: GitStatusPayload;
      };
      if (data.status) setStatus(data.status);
      if (resp.ok && data.ok) {
        setFeedback({ type: 'ok', text: 'Configured Git origin remote URL.' });
      } else {
        setFeedback({ type: 'err', text: data.error ?? 'Unable to update Git remote' });
      }
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Remote update failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleBackup = async (push: boolean) => {
    setBusy(push ? 'push' : 'commit');
    setFeedback(null);
    try {
      const resp = await apiFetch('/api/git/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: commitMessage.trim() || undefined,
          push,
          config,
          summary: {
            accountMode: snapshot.accountMode,
            venue: config.trading.venue,
            environment: snapshot.transport.environment,
            totalTrades: snapshot.recentTrades.length,
            cumulativeDailyPnlUsdt: snapshot.risk.cumulativeDailyPnlUsdt,
            cumulativeDailyPnlPct: snapshot.risk.cumulativeDailyPnlPct,
          },
        }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        committed?: boolean;
        pushed?: boolean;
        message?: string;
        error?: string;
        status?: GitStatusPayload;
      };
      if (data.status) setStatus(data.status);
      if (resp.ok && data.ok) {
        setCommitMessage('');
        setLastBackupAt(new Date().toISOString());
        setFeedback({
          type: 'ok',
          text: data.message ?? 'Sanitized config & strategy snapshot backed up to Git.',
        });
      } else {
        setFeedback({ type: 'err', text: data.error ?? 'Git backup failed' });
      }
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Git backup request failed' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Git Sync & Strategy Snapshot Backup
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Version-control sanitized strategy configs, FeatureToggles, and Rust TOML presets. API keys, PEM files, and <code className="font-mono text-slate-300">.env</code> secrets are strictly excluded.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-cyan-400/30 bg-cyan-950/30 px-2.5 py-1 text-[11px] font-semibold text-cyan-200">
            📦 Repository Location: {serverTargetLabel}
          </span>
          <span
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-semibold ${
              config.features.gitAutoBackup
                ? 'border-[#7DF2AD]/35 bg-[#7DF2AD]/10 text-[#7DF2AD]'
                : 'border-white/[0.08] bg-[#0D1015] text-slate-400'
            }`}
          >
            Auto-Backup on Save: {config.features.gitAutoBackup ? 'ON' : 'OFF'}
          </span>
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-[#7DF2AD]/40 whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh Status
          </button>
        </div>
      </div>

      {/* Top Metrics Row */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Repository</span>
            <FolderGit2 className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
          </div>
          <p className="mt-2 font-mono text-sm font-semibold text-slate-100">
            {status?.initialized ? 'Initialized' : 'Not Initialized'}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Active Branch</span>
            <GitBranch className="h-4 w-4 text-sky-400" aria-hidden="true" />
          </div>
          <p className="mt-2 font-mono text-sm font-semibold text-slate-100">
            {status?.branch ?? 'main'}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Pending Changes</span>
            <GitCommitHorizontal className="h-4 w-4 text-amber-300" aria-hidden="true" />
          </div>
          <p className="mt-2 font-mono text-sm font-semibold tabular-nums text-slate-100">
            {status?.dirtyCount ?? 0} file{(status?.dirtyCount ?? 0) === 1 ? '' : 's'}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Secret Hygiene</span>
            <ShieldCheck className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
          </div>
          <p className="mt-2 font-mono text-xs font-semibold text-[#7DF2AD]">
            .env / *.pem Excluded
          </p>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-2.5 text-xs font-medium ${
            feedback.type === 'ok'
              ? 'border-emerald-500/30 bg-emerald-950/35 text-emerald-200'
              : 'border-rose-500/30 bg-rose-950/35 text-rose-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: Actions & Remote Setup */}
        <div className="space-y-4 lg:col-span-5">
          <section className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Snapshot & Sync Controls
            </h3>

            {!status?.initialized && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3.5 text-xs text-amber-200 space-y-2.5">
                <p>No local Git repository detected yet in the project workspace.</p>
                <button
                  type="button"
                  onClick={handleInitRepo}
                  disabled={busy !== null}
                  className="rounded-lg bg-amber-400 px-3.5 py-2 text-xs font-bold text-[#0B0F17] transition hover:bg-amber-300 disabled:opacity-50"
                >
                  {busy === 'init' ? 'Initializing...' : 'Initialize Git Backup Repo'}
                </button>
              </div>
            )}

            <div>
              <label htmlFor="git-commit-msg" className="block text-xs font-medium text-slate-400">
                Backup Commit Message (optional)
              </label>
              <input
                id="git-commit-msg"
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="chore(backup): sync spot/futures strategy snapshot"
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleBackup(false)}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-lg bg-[#7DF2AD] px-4 py-2 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD] disabled:opacity-50 whitespace-nowrap"
              >
                <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                {busy === 'commit' ? 'Committing...' : 'Commit Sanitized Snapshot'}
              </button>

              <button
                type="button"
                onClick={() => void handleBackup(true)}
                disabled={busy !== null || !status?.remoteUrl}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:border-[#7DF2AD]/50 disabled:opacity-40 whitespace-nowrap"
              >
                <CloudUpload className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                {busy === 'push' ? 'Pushing...' : 'Commit & Push Remote'}
              </button>
            </div>

            <p className="text-[11px] text-slate-400">
              Exports <code className="font-mono text-slate-300">backups/bot-config-backup.json</code> &{' '}
              <code className="font-mono text-slate-300">rust-bot/config/bot.synced.toml</code> without credentials.
            </p>
          </section>

          <form
            onSubmit={handleSaveRemote}
            className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-3.5"
          >
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-100">
                Origin Remote Configuration
              </h3>
            </div>

            <div>
              <label htmlFor="git-remote-url" className="block text-xs font-medium text-slate-400">
                Git Remote URL (SSH or HTTPS)
              </label>
              <input
                id="git-remote-url"
                type="text"
                value={remoteUrlInput}
                onChange={(e) => setRemoteUrlInput(e.target.value)}
                placeholder="git@github.com:org/apexrust-bot-backups.git"
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={busy !== null || !remoteUrlInput.trim()}
              className="rounded-lg border border-white/[0.08] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-100 transition hover:border-[#7DF2AD]/50 disabled:opacity-40"
            >
              {busy === 'remote' ? 'Updating...' : 'Save Origin Remote'}
            </button>
          </form>
        </div>

        {/* Right: Recent Commit Log & Modified Files */}
        <div className="space-y-4 lg:col-span-7">
          <section className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Recent Backup Commits</h3>
              {lastBackupAt && (
                <span className="font-mono text-[11px] text-slate-400">
                  Last Snapshot: {lastBackupAt.slice(0, 19)} UTC
                </span>
              )}
            </div>

            {!status || !status.commits || status.commits.length === 0 ? (
              <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-4 py-6 text-center text-xs text-slate-400">
                No Git backup commits recorded yet. Click <strong className="text-slate-200">Commit Sanitized Snapshot</strong> to create your first checkpoint.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-slate-400">
                      <th className="py-2 pr-3 font-medium">Commit</th>
                      <th className="py-2 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {status.commits.map((c) => (
                      <tr key={c.hash}>
                        <td className="py-2 pr-3 font-mono text-[#7DF2AD] whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                            {c.hash}
                          </span>
                        </td>
                        <td className="py-2 text-slate-200">{c.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {status && status.changedFiles && status.changedFiles.length > 0 && (
            <section className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-2.5">
              <h3 className="text-sm font-semibold text-slate-100">
                Modified Workspace Files ({status.changedFiles.length})
              </h3>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-white/[0.06] bg-[#0D1015] p-3 font-mono text-[11px] text-slate-300">
                {status.changedFiles.map((file) => (
                  <div key={file}>{file}</div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
