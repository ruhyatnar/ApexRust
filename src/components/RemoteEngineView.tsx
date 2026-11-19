import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  GitBranch,
  Laptop,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import {
  type ConnectionProfile,
  EXPECTED_REMOTE_API_VERSION,
  apiFetch,
  buildAuthHeaders,
  validateRemoteBaseUrl,
} from '../engine/apiClient';
import {
  type RemoteVpsEngineSnapshot,
  mapRustEngineSnapshot,
  mapRustFeatureToggles,
} from '../engine/engineSnapshotAdapter';
import { fmtPx } from '../engine/formatters';
import type { FeatureToggles } from '../engine/types';

export interface ServerConnectionHealth {
  checkedAtMs: number;
  reachable: boolean;
  latencyMs: number | null;
  authOk: boolean;
  authRequired: boolean;
  engineAuthority: 'browser' | 'daemon';
  engineReachable: boolean;
  engineRunning: boolean | null;
  environment: 'Testnet' | 'Production';
  venue: 'Spot' | 'Futures';
  zeroTrustUser: string | null;
  apiVersion: string;
  error?: string;
}

interface RemoteEngineViewProps {
  profile: ConnectionProfile;
  connectionHealth: ServerConnectionHealth | null;
  localFeatures: FeatureToggles;
  onChangeProfile: (next: ConnectionProfile) => void;
  onRefreshConnectionHealth: () => Promise<void>;
}

export const RemoteEngineView: React.FC<RemoteEngineViewProps> = ({
  profile,
  connectionHealth,
  localFeatures,
  onChangeProfile,
  onRefreshConnectionHealth,
}) => {
  const [modeDraft, setModeDraft] = useState<'local' | 'remote'>(profile.kind);
  const [nameDraft, setNameDraft] = useState(
    profile.kind === 'remote' ? profile.name : 'Tokyo VPS'
  );
  const [urlDraft, setUrlDraft] = useState(
    profile.kind === 'remote' ? profile.baseUrl : 'http://100.96.1.10:3000'
  );
  const [tokenDraft, setTokenDraft] = useState(
    profile.kind === 'remote' ? profile.token : ''
  );
  const [rememberDraft, setRememberDraft] = useState(
    profile.kind === 'remote' ? profile.rememberToken : false
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);

  const [vpsSnapshot, setVpsSnapshot] = useState<RemoteVpsEngineSnapshot | null>(null);
  const [vpsFeatures, setVpsFeatures] = useState<FeatureToggles | null>(null);
  const [controlFeedback, setControlFeedback] = useState<{
    tone: 'emerald' | 'amber' | 'rose';
    message: string;
  } | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [confirmFlattenOpen, setConfirmFlattenOpen] = useState(false);

  // Quick Manual Order on 24/7 VPS
  const [manualSym, setManualSym] = useState('BTCUSDT');
  const [manualSide, setManualSide] = useState<'long' | 'short'>('long');
  const [manualNotional, setManualNotional] = useState('150');

  useEffect(() => {
    setModeDraft(profile.kind);
    setVpsFeatures(null);
    setVpsSnapshot(null);
    if (profile.kind === 'remote') {
      setNameDraft(profile.name);
      setUrlDraft(profile.baseUrl);
      setTokenDraft(profile.token);
      setRememberDraft(profile.rememberToken);
    }
  }, [profile]);

  const effectiveFeatures = vpsFeatures ?? localFeatures;

  const pollVpsEngine = useCallback(async (): Promise<boolean> => {
    try {
      const [snapResp, cfgResp] = await Promise.all([
        apiFetch('/api/engine/snapshot'),
        apiFetch('/api/engine/config'),
      ]);
      let ok = false;
      if (snapResp.ok) {
        const rawSnap = (await snapResp.json()) as unknown;
        const mapped = mapRustEngineSnapshot(rawSnap);
        setVpsSnapshot(mapped);
        ok = true;
      } else {
        setVpsSnapshot(null);
      }
      if (cfgResp.ok) {
        const rawCfg = (await cfgResp.json()) as unknown;
        const parsedFeatures = mapRustFeatureToggles(rawCfg);
        setVpsFeatures(parsedFeatures);
      } else {
        setVpsFeatures(null);
      }
      return ok;
    } catch {
      setVpsSnapshot(null);
      setVpsFeatures(null);
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void runLoop();
      }, delayMs);
    };
    const runLoop = async () => {
      const ok = await pollVpsEngine();
      // Poll every 1.5s when reachable; back off cleanly to 5s when offline
      schedule(ok ? 1500 : 5000);
    };
    void runLoop();
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [pollVpsEngine, profile]);

  const syncSharedCliProfile = async (next: ConnectionProfile) => {
    try {
      // Also notify local server.ts (if running) so .apexrust/remote-profile.json stays synced with bot-desktop CLI
      await fetch('/api/remote-profile', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders({ kind: 'local' }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          next.kind === 'remote'
            ? {
                activeMode: 'remote',
                name: next.name,
                baseUrl: next.baseUrl,
                ...(next.rememberToken && next.token ? { token: next.token } : {}),
              }
            : { activeMode: 'local' }
        ),
      });
    } catch {
      // Ignore if local server.ts is not running
    }
  };

  const handleSelectLocalMode = async () => {
    setFormError(null);
    setModeDraft('local');
    const next: ConnectionProfile = { kind: 'local' };
    onChangeProfile(next);
    await syncSharedCliProfile(next);
    await onRefreshConnectionHealth();
    setControlFeedback({
      tone: 'emerald',
      message: 'Switched to 🖥️ This Computer (Local Mode). Orders and database now run on this computer.',
    });
  };

  const handleSaveAndTestRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const validation = validateRemoteBaseUrl(urlDraft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    setTestingConnection(true);
    const next: ConnectionProfile = {
      kind: 'remote',
      name: nameDraft.trim() || 'Remote VPS',
      baseUrl: validation.normalizedUrl,
      token: tokenDraft.trim(),
      rememberToken: rememberDraft,
    };
    onChangeProfile(next);
    await syncSharedCliProfile(next);
    try {
      await onRefreshConnectionHealth();
      await pollVpsEngine();
      setControlFeedback({
        tone: 'emerald',
        message: `Connected to ☁️ ${next.name} (${next.baseUrl}).`,
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const sendVpsControl = async (
    payload: Record<string, unknown>,
    successMsg: string
  ) => {
    setControlBusy(true);
    setControlFeedback(null);
    try {
      const requestId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resp = await apiFetch('/api/engine/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          request_id: requestId,
        }),
      });
      const data = (await resp.json()) as { accepted?: boolean; error?: string };
      if (!resp.ok || data.accepted === false) {
        setControlFeedback({
          tone: 'rose',
          message: data.error || `VPS Bot rejected command (HTTP ${resp.status}).`,
        });
        return;
      }
      setControlFeedback({
        tone: 'emerald',
        message: successMsg,
      });
      await pollVpsEngine();
    } catch (err) {
      setControlFeedback({
        tone: 'rose',
        message:
          err instanceof Error
            ? `Failed to reach 24/7 VPS Bot: ${err.message}`
            : 'Failed to reach 24/7 VPS Bot.',
      });
    } finally {
      setControlBusy(false);
    }
  };

  const openPositions = (vpsSnapshot?.pairs ?? [])
    .map((p) => p.openPosition)
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const venueToggleEnabled =
    vpsSnapshot?.venue === 'Futures'
      ? effectiveFeatures.futuresMarket
      : effectiveFeatures.spotMarket;
  const canSubmitVpsManualOrder =
    effectiveFeatures.manualTrading &&
    venueToggleEnabled &&
    !(vpsSnapshot?.venue === 'Spot' && manualSide === 'short');

  return (
    <div className="space-y-5">
      {/* Card 1: Execution Location Switcher (This Computer vs Remote VPS) */}
      <div className="rounded-xl border border-white/[0.08] bg-[#10141B] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-slate-50">
              Where Should ApexRust Run? (Execution Location)
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Switch between running the bot on <strong className="text-slate-200">🖥️ This Computer</strong> or connecting to your{' '}
              <strong className="text-slate-200">☁️ 24/7 Remote VPS</strong> over Cloudflare One (Zero Trust).
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
              profile.kind === 'remote'
                ? 'border-cyan-400/40 bg-cyan-950/30 text-cyan-200'
                : 'border-[#7DF2AD]/40 bg-[#7DF2AD]/10 text-[#7DF2AD]'
            }`}
          >
            {profile.kind === 'remote' ? (
              <>
                <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Active Target: ☁️ Remote VPS ({profile.name})</span>
              </>
            ) : (
              <>
                <Laptop className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Active Target: 🖥️ This Computer (Local)</span>
              </>
            )}
          </span>
        </div>

        {/* Two Mode Choice Cards */}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => void handleSelectLocalMode()}
            className={`flex flex-col items-start rounded-xl border p-4 text-left transition ${
              modeDraft === 'local'
                ? 'border-[#7DF2AD]/60 bg-[#14231D]/60'
                : 'border-white/[0.08] bg-[#141820] hover:border-white/20'
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <div className="flex items-center gap-2">
                <Laptop className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
                <span className="font-display text-sm font-bold text-slate-100">
                  🖥️ Run on This Computer (Local Mode)
                </span>
              </div>
              {profile.kind === 'local' && (
                <span className="rounded bg-[#7DF2AD]/20 px-2 py-0.5 text-[10px] font-bold text-[#7DF2AD]">
                  ACTIVE
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Runs the trading engine, API key vault, and SQLite order database on this computer.
              Ideal for paper trading and local testing. Automated trading pauses when you close this window.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setModeDraft('remote')}
            className={`flex flex-col items-start rounded-xl border p-4 text-left transition ${
              modeDraft === 'remote'
                ? 'border-cyan-400/60 bg-cyan-950/25'
                : 'border-white/[0.08] bg-[#141820] hover:border-white/20'
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                <span className="font-display text-sm font-bold text-slate-100">
                  ☁️ Connect to Remote VPS (24/7 via Cloudflare One)
                </span>
              </div>
              {profile.kind === 'remote' && (
                <span className="rounded bg-cyan-400/20 px-2 py-0.5 text-[10px] font-bold text-cyan-200">
                  CONNECTED
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Connects to your always-on VPS over Cloudflare One (Zero Trust WARP Mesh). Your VPS runs
              automated entries, 24/7 ATR trailing stops, and order history even when this computer is turned off.
            </p>
          </button>
        </div>

        {/* Remote VPS Configuration Form */}
        {modeDraft === 'remote' && (
          <form
            onSubmit={(e) => void handleSaveAndTestRemote(e)}
            className="mt-4 space-y-4 rounded-xl border border-cyan-500/25 bg-[#131822] p-4"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Server Nickname
                </label>
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Tokyo VPS"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0D1015] px-3 py-2 text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  VPS Address (Cloudflare One IP or URL)
                </label>
                <input
                  type="text"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="http://100.96.1.10:3000"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Access Token (Optional on Cloudflare One Mesh)
                </label>
                <input
                  type="password"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder="Leave blank if trusted on Cloudflare One"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </div>

            {formError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                {formError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={rememberDraft}
                  onChange={(e) => setRememberDraft(e.target.checked)}
                  className="rounded border-white/20 bg-[#0D1015]"
                />
                <span>Remember Access Token on this computer (otherwise cleared when window closes)</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={testingConnection}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-4 py-2 text-xs font-bold text-[#0B0F17] transition hover:bg-cyan-300 disabled:opacity-50"
                >
                  <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{testingConnection ? 'Connecting to VPS…' : 'Test & Connect to VPS'}</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* 4-Point Plain-English Connection Health Checklist */}
        {connectionHealth && (
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#141820] p-3">
              {connectionHealth.reachable ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#7DF2AD]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              )}
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  1. {profile.kind === 'remote' ? 'VPS Server Reachable' : 'Local Server Reachable'}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {connectionHealth.reachable
                    ? `Online (${connectionHealth.latencyMs ?? 1} ms)`
                    : connectionHealth.error || 'Unreachable'}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#141820] p-3">
              {connectionHealth.authOk ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#7DF2AD]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              )}
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  2. Access Permission
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {!connectionHealth.reachable
                    ? 'Pending VPS connection'
                    : connectionHealth.authOk
                      ? connectionHealth.zeroTrustUser
                        ? `Cloudflare Zero Trust (${connectionHealth.zeroTrustUser})`
                        : connectionHealth.authRequired
                          ? 'Access Token Verified'
                          : 'Cloudflare One Mesh / Local Trusted'
                      : connectionHealth.error || 'Access Token Rejected (401)'}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#141820] p-3">
              {connectionHealth.reachable && connectionHealth.authOk && connectionHealth.engineReachable ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#7DF2AD]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              )}
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  3. 24/7 Rust Trading Daemon
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {!connectionHealth.reachable
                    ? 'Unknown while unreachable'
                    : !connectionHealth.authOk
                      ? 'Locked until Access Token is verified'
                      : connectionHealth.engineReachable
                        ? connectionHealth.engineRunning
                          ? 'Online & Actively Scanning'
                          : 'Online (Paused)'
                        : 'Not Running (Web Proxy Only)'}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#141820] p-3">
              {connectionHealth.reachable && connectionHealth.authOk ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#7DF2AD]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              )}
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  4. Active Binance Account Mode
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {!connectionHealth.reachable
                    ? 'Unknown while unreachable'
                    : !connectionHealth.authOk
                      ? 'Locked until Access Token is verified'
                      : `${connectionHealth.venue} · ${connectionHealth.environment} (${
                          connectionHealth.engineAuthority === 'daemon'
                            ? '24/7 VPS Bot in Charge'
                            : 'Desktop Window in Charge'
                        })`}
                </div>
              </div>
            </div>
          </div>
        )}

        {connectionHealth &&
          connectionHealth.reachable &&
          connectionHealth.apiVersion !== EXPECTED_REMOTE_API_VERSION && (
            <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-400/40 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <span>
                <strong>Version Mismatch Detected:</strong> The server reports API version{' '}
                <code>{connectionHealth.apiVersion}</code>, whereas this Desktop UI expects{' '}
                <code>{EXPECTED_REMOTE_API_VERSION}</code>. Update both ends to keep controls synchronized.
              </span>
            </div>
          )}
      </div>

      {/* Card 2: 24/7 Rust Trading Daemon Live Monitor & Remote Controls */}
      <div className="rounded-xl border border-white/[0.08] bg-[#10141B] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3.5">
          <div>
            <h3 className="font-display text-base font-bold text-slate-50">
              24/7 Rust Trading Daemon Monitor & Controls
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Live telemetry and controls for the native Rust trading daemon (`bot-desktop`) running on{' '}
              <strong className="text-slate-200">
                {profile.kind === 'remote' ? `☁️ ${profile.name}` : '🖥️ This Computer'}
              </strong>
              .
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void pollVpsEngine()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#141820] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-[#1C222D]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Refresh Daemon Status</span>
            </button>

            {vpsSnapshot && (
              <>
                <button
                  type="button"
                  disabled={controlBusy}
                  onClick={() =>
                    void sendVpsControl(
                      { action: vpsSnapshot.running ? 'pause' : 'resume' },
                      vpsSnapshot.running
                        ? 'Paused 24/7 Rust Trading Daemon.'
                        : 'Resumed 24/7 Rust Trading Daemon.'
                    )
                  }
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                    vpsSnapshot.running
                      ? 'border border-amber-400/40 bg-amber-950/30 text-amber-200 hover:bg-amber-950/50'
                      : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#95F7BD]'
                  }`}
                >
                  {vpsSnapshot.running ? (
                    <>
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Pause 24/7 Bot</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Resume 24/7 Bot</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={controlBusy || !effectiveFeatures.circuitBreaker}
                  title={
                    !effectiveFeatures.circuitBreaker
                      ? 'Circuit Breaker is OFF in Feature Toggles'
                      : undefined
                  }
                  onClick={() =>
                    void sendVpsControl(
                      {
                        action:
                          vpsSnapshot.risk.state === 'Halted' ? 'reset_cb' : 'trip_cb',
                        reason: 'Manual circuit breaker action from Desktop App',
                      },
                      vpsSnapshot.risk.state === 'Halted'
                        ? 'Reset 24/7 Bot Circuit Breaker and cleared pair quarantines.'
                        : 'Tripped 24/7 Bot Circuit Breaker.'
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#141820] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-[#1C222D] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {vpsSnapshot.risk.state === 'Halted' ? (
                    <>
                      <ShieldCheck className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
                      <span>Reset Circuit Breaker</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                      <span>Trip Circuit Breaker</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={controlBusy}
                  onClick={() => setConfirmFlattenOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-950/50 disabled:opacity-50"
                >
                  <span>Flatten All Positions ({openPositions.length})</span>
                </button>

                <button
                  type="button"
                  disabled={controlBusy}
                  onClick={() =>
                    void sendVpsControl(
                      { action: 'backup_now' },
                      'Triggered sanitized Git snapshot backup on the server.'
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#141820] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-[#1C222D] disabled:opacity-50"
                >
                  <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Save Server Git Backup</span>
                </button>
              </>
            )}
          </div>
        </div>

        {controlFeedback && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              controlFeedback.tone === 'emerald'
                ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-200'
                : controlFeedback.tone === 'amber'
                  ? 'border-amber-500/30 bg-amber-950/30 text-amber-200'
                  : 'border-rose-500/30 bg-rose-950/30 text-rose-200'
            }`}
          >
            {controlFeedback.message}
          </div>
        )}

        {confirmFlattenOpen && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-100">
            <span>
              Confirm emergency close of all <strong>{openPositions.length}</strong> open position(s) on the 24/7 Rust daemon?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmFlattenOpen(false)}
                className="rounded border border-white/15 px-3 py-1 text-xs text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmFlattenOpen(false);
                  void sendVpsControl(
                    { action: 'flatten_all' },
                    'Sent emergency Flatten All command to 24/7 Rust Daemon.'
                  );
                }}
                className="rounded bg-rose-500 px-3 py-1 text-xs font-bold text-white"
              >
                Confirm Flatten All
              </button>
            </div>
          </div>
        )}

        {!vpsSnapshot ? (
          <div className="mt-4 rounded-xl border border-white/[0.06] bg-[#141820] p-4 text-xs text-slate-400">
            <p className="font-semibold text-slate-200">
              24/7 Rust Trading Daemon (`bot-desktop`) is not currently running on{' '}
              {profile.kind === 'remote' ? profile.name : 'this computer'}.
            </p>
            <p className="mt-1">
              The Web Proxy (`server.ts`) is online for Order History, Live Credentials, and Git Backup. To start the 24/7 Rust daemon on the server, run{' '}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-slate-200">
                ./apexrust start bot
              </code>{' '}
              (or <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-slate-200">apexrust.cmd start bot</code> on Windows).
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Summary Telemetry Row */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  24/7 Daemon Status
                </div>
                <div className="mt-1 flex items-center gap-2 font-display text-sm font-bold text-slate-100">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      vpsSnapshot.running ? 'bg-[#7DF2AD]' : 'bg-amber-400'
                    }`}
                  />
                  <span>
                    {vpsSnapshot.running ? 'Running' : 'Paused'} · {vpsSnapshot.venue}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Feed: {vpsSnapshot.transportMode} (Failovers: {vpsSnapshot.failoverCount})
                </div>
              </div>

              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Daemon Equity & Daily PnL
                </div>
                <div className="mt-1 font-mono text-sm font-bold text-slate-100">
                  ${vpsSnapshot.risk.currentEquity.toFixed(2)}
                </div>
                <div
                  className={`mt-1 font-mono text-[11px] ${
                    vpsSnapshot.risk.dailyPnlUsdt >= 0 ? 'text-[#7DF2AD]' : 'text-rose-400'
                  }`}
                >
                  {vpsSnapshot.risk.dailyPnlUsdt >= 0 ? '+' : ''}
                  ${vpsSnapshot.risk.dailyPnlUsdt.toFixed(2)} ({vpsSnapshot.risk.dailyPnlPct.toFixed(2)}%)
                </div>
              </div>

              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Risk Circuit Breaker
                </div>
                <div className="mt-1 font-display text-sm font-bold text-slate-100">
                  {vpsSnapshot.risk.state}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Win/Loss Streak: {vpsSnapshot.risk.winStreak}W / {vpsSnapshot.risk.loseStreak}L
                </div>
              </div>

              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Open 24/7 Positions
                </div>
                <div className="mt-1 font-mono text-sm font-bold text-slate-100">
                  {openPositions.length} Active
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Watching {vpsSnapshot.pairs.length} Pair(s) 24/7
                </div>
              </div>
            </div>

            {/* Watched Pairs & Active Positions Table */}
            <div className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#141820]">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/[0.06] bg-[#0D1015] text-[11px] uppercase text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Pair</th>
                    <th className="px-3 py-2">Last Price</th>
                    <th className="px-3 py-2">EMA Fast / Slow</th>
                    <th className="px-3 py-2">RSI / ADX / ATR</th>
                    <th className="px-3 py-2">24/7 Position & ATR Stop</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {vpsSnapshot.pairs.map((p) => (
                    <tr key={p.symbol} className="hover:bg-white/[0.02]">
                      <td className="px-3 py-2 font-mono font-bold text-slate-100">{p.symbol}</td>
                      <td className="px-3 py-2 font-mono text-slate-200">
                        ${fmtPx(p.lastPrice)}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-300">
                        {p.emaFast !== null ? fmtPx(p.emaFast) : '-'} /{' '}
                        {p.emaSlow !== null ? fmtPx(p.emaSlow) : '-'}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-300">
                        RSI {p.rsi !== null ? p.rsi.toFixed(1) : '-'} · ADX{' '}
                        {p.adx !== null ? p.adx.toFixed(1) : '-'} · ATR{' '}
                        {p.atr !== null ? fmtPx(p.atr) : '-'}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {p.openPosition ? (
                          <span className="text-[#7DF2AD]">
                            {p.openPosition.side} {p.openPosition.remainingQuantity.toFixed(4)} @ $
                            {fmtPx(p.openPosition.entryPrice)} (SL $
                            {fmtPx(p.openPosition.currentStopLoss)})
                          </span>
                        ) : (
                          <span className="text-slate-500">FLAT</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Quick Manual Order Dispatch to 24/7 Daemon */}
            <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">
                    Send Manual Entry to 24/7 Rust Daemon
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    The 24/7 daemon will open the position and immediately manage its ATR Break-Even and Trailing Stop 24/7.
                  </p>
                </div>
                {!effectiveFeatures.manualTrading && (
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    LOCKED: Manual Trading Toggle is OFF
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-2.5">
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-slate-400">
                    Pair
                  </label>
                  <select
                    value={manualSym}
                    disabled={!canSubmitVpsManualOrder}
                    onChange={(e) => setManualSym(e.target.value)}
                    className="mt-1 rounded-lg border border-white/10 bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 disabled:opacity-40"
                  >
                    {(vpsSnapshot.pairs.length > 0
                      ? vpsSnapshot.pairs.map((p) => p.symbol)
                      : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
                    ).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold uppercase text-slate-400">
                    Side
                  </label>
                  <select
                    value={manualSide}
                    disabled={!effectiveFeatures.manualTrading || !venueToggleEnabled}
                    onChange={(e) =>
                      setManualSide(e.target.value === 'short' ? 'short' : 'long')
                    }
                    className="mt-1 rounded-lg border border-white/10 bg-[#0D1015] px-2.5 py-1.5 text-xs text-slate-100 disabled:opacity-40"
                  >
                    <option value="long">Long (BUY)</option>
                    <option value="short" disabled={vpsSnapshot.venue === 'Spot'}>
                      Short (SELL {vpsSnapshot.venue === 'Spot' ? '- Futures Only' : ''})
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold uppercase text-slate-400">
                    Notional (USDT)
                  </label>
                  <input
                    type="number"
                    min="10"
                    step="10"
                    value={manualNotional}
                    disabled={!canSubmitVpsManualOrder}
                    onChange={(e) => setManualNotional(e.target.value)}
                    className="mt-1 w-28 rounded-lg border border-white/10 bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 disabled:opacity-40"
                  />
                </div>

                <button
                  type="button"
                  disabled={controlBusy || !canSubmitVpsManualOrder}
                  onClick={() => {
                    const parsedNotional = Number(manualNotional);
                    if (!Number.isFinite(parsedNotional) || parsedNotional < 10) {
                      setControlFeedback({
                        tone: 'rose',
                        message: 'Notional must be >= $10 USDT.',
                      });
                      return;
                    }
                    void sendVpsControl(
                      {
                        action: 'manual_order',
                        symbol: manualSym,
                        side: manualSide === 'short' ? 'Short' : 'Long',
                        notional_usdt: parsedNotional,
                        order_method: 'MARKET',
                      },
                      `Dispatched ${manualSide.toUpperCase()} ${manualSym} ($${parsedNotional.toFixed(2)}) to 24/7 Rust Daemon.`
                    );
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#7DF2AD] px-3.5 py-1.5 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Place Order on 24/7 Bot</span>
                </button>
              </div>
            </div>

            {/* Recent Closed Trades & ATR Volatility Alerts from 24/7 Rust Daemon */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3.5">
                <h4 className="text-xs font-bold text-slate-100">
                  Recent Closed Trades (24/7 Rust Daemon)
                </h4>
                {vpsSnapshot.recentTrades.length === 0 ? (
                  <p className="mt-2 text-[11px] text-slate-500">No closed trades recorded in current daemon session yet.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 text-[11px] font-mono">
                    {vpsSnapshot.recentTrades.slice(0, 6).map((t) => (
                      <li key={t.id} className="flex items-center justify-between border-b border-white/[0.04] pb-1">
                        <span className="text-slate-200">
                          {t.symbol} · {t.side} · {t.reason}
                        </span>
                        <span className={t.pnlUsdt >= 0 ? 'text-[#7DF2AD]' : 'text-rose-400'}>
                          {t.pnlUsdt >= 0 ? '+' : ''}${t.pnlUsdt.toFixed(2)} ({t.rMultiple.toFixed(2)}R)
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-3.5">
                <h4 className="text-xs font-bold text-slate-100">
                  ATR Volatility Spike Alerts (24/7 Rust Daemon)
                </h4>
                {vpsSnapshot.recentVolatilityAlerts.length === 0 ? (
                  <p className="mt-2 text-[11px] text-slate-500">No active ATR volatility spikes reported.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 text-[11px]">
                    {vpsSnapshot.recentVolatilityAlerts.slice(0, 6).map((a) => (
                      <li key={a.id} className="flex items-center justify-between border-b border-white/[0.04] pb-1">
                        <span className="text-amber-200">{a.message || `${a.symbol} ATR spike`}</span>
                        <span className="font-mono text-slate-400">
                          {a.atrExpansionRatio.toFixed(2)}x
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
