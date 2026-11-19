import React, { useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  BinanceAuthMethod,
  ExchangeVenue,
  ExecutionAccountMode,
  LiveCredentialStatus,
  MarginType,
} from '../engine/types';

interface LiveCredentialsViewProps {
  liveStatus: LiveCredentialStatus;
  accountMode: ExecutionAccountMode;
  serverTargetLabel?: string;
  isRemoteVps?: boolean;
  onSaveCredentials: (payload: {
    environment: 'Testnet' | 'Production';
    venue: ExchangeVenue;
    leverage: number;
    marginType: MarginType;
    authMethod: BinanceAuthMethod;
    apiKey: string;
    apiSecret: string;
    recvWindowMs: number;
    maxOrderNotionalUsdt: number;
    requirePreflightTestOrder: boolean;
  }) => Promise<{ ok: boolean; message: string }>;
  onVerifyConnection: () => Promise<{ ok: boolean; message: string }>;
  onRunPreflightOrder: () => Promise<{ ok: boolean; message: string }>;
  onToggleArmLive: (arm: boolean, confirmProduction: boolean) => Promise<{ ok: boolean; message: string }>;
  onRevokeCredentials: () => Promise<void>;
  onSwitchAccountMode: (mode: ExecutionAccountMode) => void;
}

export const LiveCredentialsView: React.FC<LiveCredentialsViewProps> = ({
  liveStatus,
  accountMode,
  serverTargetLabel = '🖥️ This Computer',
  isRemoteVps = false,
  onSaveCredentials,
  onVerifyConnection,
  onRunPreflightOrder,
  onToggleArmLive,
  onRevokeCredentials,
  onSwitchAccountMode,
}) => {
  const [environment, setEnvironment] = useState<'Testnet' | 'Production'>(liveStatus.environment);
  const [venue, setVenue] = useState<ExchangeVenue>(liveStatus.venue ?? 'Spot');
  const [leverage, setLeverage] = useState<number>(liveStatus.leverage ?? 3);
  const [marginType, setMarginType] = useState<MarginType>(liveStatus.marginType ?? 'ISOLATED');
  const [authMethod, setAuthMethod] = useState<BinanceAuthMethod>(liveStatus.authMethod);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [recvWindowMs, setRecvWindowMs] = useState(liveStatus.recvWindowMs);
  const [maxOrderNotionalUsdt, setMaxOrderNotionalUsdt] = useState(liveStatus.maxOrderNotionalUsdt);
  const [requirePreflight, setRequirePreflight] = useState(liveStatus.requirePreflightTestOrder);
  const [confirmProdArm, setConfirmProdArm] = useState(false);
  const [confirmRemoteEnvText, setConfirmRemoteEnvText] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    setEnvironment(liveStatus.environment);
    setVenue(liveStatus.venue ?? 'Spot');
    setLeverage(liveStatus.leverage ?? 3);
    setMarginType(liveStatus.marginType ?? 'ISOLATED');
    setAuthMethod(liveStatus.authMethod);
    setRecvWindowMs(liveStatus.recvWindowMs);
    setMaxOrderNotionalUsdt(liveStatus.maxOrderNotionalUsdt);
    setRequirePreflight(liveStatus.requirePreflightTestOrder);
  }, [
    liveStatus.environment,
    liveStatus.venue,
    liveStatus.leverage,
    liveStatus.marginType,
    liveStatus.authMethod,
    liveStatus.recvWindowMs,
    liveStatus.maxOrderNotionalUsdt,
    liveStatus.requirePreflightTestOrder,
  ]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!liveStatus.configured && (!apiKey.trim() || !apiSecret.trim())) {
      setFeedback({
        type: 'err',
        text: 'Both API Key and Secret / Private Key are required for initial setup.',
      });
      return;
    }
    if (
      isRemoteVps &&
      (apiKey.trim() || apiSecret.trim()) &&
      confirmRemoteEnvText.trim() !== environment
    ) {
      setFeedback({
        type: 'err',
        text: `Type "${environment}" in the Remote VPS re-confirmation box below before saving API keys.`,
      });
      return;
    }
    setBusyAction('save');
    setFeedback(null);
    const res = await onSaveCredentials({
      environment,
      venue,
      leverage,
      marginType,
      authMethod,
      apiKey,
      apiSecret,
      recvWindowMs,
      maxOrderNotionalUsdt,
      requirePreflightTestOrder: requirePreflight,
    });
    setBusyAction(null);
    if (res.ok) {
      setApiKey('');
      setApiSecret('');
      setConfirmRemoteEnvText('');
      setFeedback({ type: 'ok', text: res.message });
    } else {
      setFeedback({ type: 'err', text: res.message });
    }
  };

  const handleVerify = async () => {
    setBusyAction('verify');
    setFeedback(null);
    const res = await onVerifyConnection();
    setBusyAction(null);
    setFeedback({ type: res.ok ? 'ok' : 'err', text: res.message });
  };

  const handlePreflight = async () => {
    setBusyAction('preflight');
    setFeedback(null);
    const res = await onRunPreflightOrder();
    setBusyAction(null);
    setFeedback({ type: res.ok ? 'ok' : 'err', text: res.message });
  };

  const handleArmToggle = async () => {
    setBusyAction('arm');
    setFeedback(null);
    const nextArm = !liveStatus.armedForLiveOrders;
    const res = await onToggleArmLive(nextArm, confirmProdArm);
    setBusyAction(null);
    setFeedback({ type: res.ok ? 'ok' : 'err', text: res.message });
  };

  const handleRevoke = async () => {
    if (isRemoteVps && confirmRemoteEnvText.trim() !== environment) {
      setFeedback({
        type: 'err',
        text: `Type "${environment}" in the Remote VPS re-confirmation box below before revoking API keys.`,
      });
      return;
    }
    setBusyAction('revoke');
    await onRevokeCredentials();
    setApiKey('');
    setApiSecret('');
    setConfirmProdArm(false);
    setConfirmRemoteEnvText('');
    setBusyAction(null);
    setFeedback({ type: 'ok', text: 'Cleared live credentials from server memory and disarmed Live execution.' });
  };

  return (
    <div className="space-y-5">
      {/* Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Live Trading Credentials & Execution Isolation
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Configure Binance Spot or USD-M Futures API credentials on the server-side signing proxy. Paper and Live runtimes remain strictly isolated.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-cyan-400/30 bg-cyan-950/30 px-2.5 py-1 text-[11px] font-semibold text-cyan-200">
            🔑 Managing Binance Keys on: {serverTargetLabel}
          </span>
          <div className="flex rounded-lg border border-white/[0.08] bg-[#0D1015] p-1">
            <button
              type="button"
              onClick={() => onSwitchAccountMode('Paper')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                accountMode === 'Paper'
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Paper Runtime
            </button>
            <button
              type="button"
              onClick={() => onSwitchAccountMode('Live')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                accountMode === 'Live'
                  ? 'bg-amber-400 text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Live Runtime
            </button>
          </div>
        </div>
      </div>

      {/* Isolation Architecture Banner */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <div className="rounded-xl border border-emerald-500/20 bg-[#141820] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#7DF2AD]">PAPER TRADING SANDBOX</span>
            <span className="font-mono text-[11px] text-slate-400">Virtual Equity Only</span>
          </div>
          <p className="mt-1.5 text-xs text-slate-300">
            Independent $10,000 virtual account, separate RiskManager daily drawdown counters, and local fills. Never calls signed Binance order endpoints.
          </p>
        </div>

        <div className="rounded-xl border border-amber-500/25 bg-[#141820] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-300">LIVE EXECUTION VAULT</span>
            <span className="font-mono text-[11px] text-slate-400">
              {liveStatus.armedForLiveOrders ? 'ARMED' : 'DISARMED'} · {liveStatus.environment}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-300">
            Credentials stay inside Express server memory (<code className="font-mono text-slate-200">/api/live/*</code>), never stored in browser storage, and every live order enforces notional caps.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: Credential Configuration Form */}
        <form
          onSubmit={handleSave}
          className="space-y-4 rounded-xl border border-white/[0.06] bg-[#141820] p-5 lg:col-span-7"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-100">
                Binance {venue} Credential Vault
              </h3>
            </div>
            {liveStatus.apiKeyMasked && (
              <span className="rounded bg-[#0D1015] px-2.5 py-1 font-mono text-[11px] text-emerald-300">
                Active Key: {liveStatus.apiKeyMasked}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <div>
              <label htmlFor="live-venue-select" className="block text-xs font-medium text-slate-400">
                Exchange Market Venue
              </label>
              <select
                id="live-venue-select"
                value={venue}
                onChange={(e) => setVenue(e.target.value as ExchangeVenue)}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              >
                <option value="Spot">Binance Spot (/api/v3)</option>
                <option value="Futures">USD-M Futures (/fapi/v1)</option>
              </select>
            </div>

            <div>
              <label htmlFor="live-env-select" className="block text-xs font-medium text-slate-400">
                Target Environment
              </label>
              <select
                id="live-env-select"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as 'Testnet' | 'Production')}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              >
                <option value="Testnet">
                  {venue === 'Futures'
                    ? 'Futures Testnet (testnet.binancefuture.com)'
                    : 'Spot Testnet (testnet.binance.vision)'}
                </option>
                <option value="Production">
                  {venue === 'Futures'
                    ? 'Futures Production (fapi.binance.com)'
                    : 'Spot Production (api.binance.com)'}
                </option>
              </select>
            </div>

            <div>
              <label htmlFor="live-auth-method" className="block text-xs font-medium text-slate-400">
                Request Signing
              </label>
              <select
                id="live-auth-method"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as BinanceAuthMethod)}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              >
                <option value="HMAC-SHA256">HMAC-SHA256</option>
                <option value="Ed25519">Ed25519 PEM</option>
              </select>
            </div>
          </div>

          {venue === 'Futures' && (
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label htmlFor="live-leverage-select" className="block text-xs font-medium text-slate-400">
                  Futures Default Leverage
                </label>
                <select
                  id="live-leverage-select"
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-amber-300 focus:border-[#7DF2AD] focus:outline-none"
                >
                  {[1, 2, 3, 5, 10, 15, 20].map((lv) => (
                    <option key={lv} value={lv}>{lv}x</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="live-margin-select" className="block text-xs font-medium text-slate-400">
                  Futures Margin Mode
                </label>
                <select
                  id="live-margin-select"
                  value={marginType}
                  onChange={(e) => setMarginType(e.target.value as MarginType)}
                  className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                >
                  <option value="ISOLATED">ISOLATED</option>
                  <option value="CROSSED">CROSSED</option>
                </select>
              </div>
            </div>
          )}

          <div>
            <label htmlFor="live-api-key" className="block text-xs font-medium text-slate-400">
              Binance API Key {liveStatus.configured ? '(leave blank to keep current key)' : ''}
            </label>
            <input
              id="live-api-key"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={liveStatus.apiKeyMasked ?? 'Paste Binance Spot / Futures API Key'}
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="live-api-secret" className="block text-xs font-medium text-slate-400">
                {authMethod === 'Ed25519'
                  ? 'Ed25519 Private Key (PKCS#8 PEM)'
                  : 'Binance API Secret Key'}{' '}
                {liveStatus.configured ? '(stored server-side · never returned)' : ''}
              </label>
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
              >
                {showSecret ? (
                  <>
                    <EyeOff className="h-3 w-3" aria-hidden="true" />
                    Hide
                  </>
                ) : (
                  <>
                    <Eye className="h-3 w-3" aria-hidden="true" />
                    Reveal
                  </>
                )}
              </button>
            </div>
            {authMethod === 'Ed25519' ? (
              <textarea
                id="live-api-secret"
                rows={3}
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
              />
            ) : (
              <input
                id="live-api-secret"
                type={showSecret ? 'text' : 'password'}
                autoComplete="new-password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={liveStatus.configured ? '••••••••••••••••••••••••••••••••' : 'Paste Binance API Secret'}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label htmlFor="live-recv-window" className="block text-xs font-medium text-slate-400">
                Signed RecvWindow (ms)
              </label>
              <input
                id="live-recv-window"
                type="number"
                min={1000}
                max={60000}
                step={500}
                value={recvWindowMs}
                onChange={(e) => setRecvWindowMs(Number(e.target.value) || 5000)}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="live-max-notional" className="block text-xs font-medium text-slate-400">
                Max Live Order Notional (USDT)
              </label>
              <input
                id="live-max-notional"
                type="number"
                min={10}
                max={100000}
                step={10}
                value={maxOrderNotionalUsdt}
                onChange={(e) => setMaxOrderNotionalUsdt(Number(e.target.value) || 250)}
                className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
          </div>

          <label className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2.5 text-xs text-slate-300">
            <span>
              Require signed {venue === 'Futures' ? '/fapi/v1/order/test' : '/api/v3/order/test'} preflight before live fills
            </span>
            <input
              type="checkbox"
              checked={requirePreflight}
              onChange={(e) => setRequirePreflight(e.target.checked)}
              className="h-4 w-4 rounded border-white/[0.08] bg-[#141820]"
            />
          </label>

          {feedback && (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                feedback.type === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-950/40 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-950/40 text-rose-200'
              }`}
            >
              {feedback.text}
            </div>
          )}

          {isRemoteVps && (
            <div className="space-y-1.5 rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 text-xs text-cyan-100">
              <label className="block font-semibold">
                Remote VPS Key Edit Confirmation: type <span className="font-mono text-cyan-300">{environment}</span> to confirm updating keys on <strong>{serverTargetLabel}</strong>
              </label>
              <input
                type="text"
                value={confirmRemoteEnvText}
                onChange={(e) => setConfirmRemoteEnvText(e.target.value)}
                placeholder={`Type ${environment} here`}
                className="w-full max-w-xs rounded-md border border-cyan-400/30 bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="submit"
              disabled={busyAction !== null}
              className="flex items-center gap-1.5 rounded-lg bg-[#7DF2AD] px-4 py-2 text-xs font-bold text-[#0B0F17] transition hover:bg-[#9AF7BF] disabled:opacity-50"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              {busyAction === 'save' ? 'Saving...' : 'Save to Server Vault'}
            </button>

            <button
              type="button"
              onClick={handleVerify}
              disabled={!liveStatus.configured || busyAction !== null}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-100 transition hover:border-[#7DF2AD]/50 disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busyAction === 'verify' ? 'animate-spin' : ''}`} aria-hidden="true" />
              Verify Connection & Sync Balances
            </button>

            <button
              type="button"
              onClick={handlePreflight}
              disabled={!liveStatus.configured || busyAction !== null}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-40"
            >
              <Zap className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
              Test Signed Order
            </button>

            {liveStatus.configured && (
              <button
                type="button"
                onClick={handleRevoke}
                disabled={busyAction !== null}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-950/30 px-3 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-950/60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Revoke Keys
              </button>
            )}
          </div>
        </form>

        {/* Right: Arming Control & Synced Binance Balances */}
        <div className="space-y-4 lg:col-span-5">
          <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Live Order Execution Gate</h3>
              {liveStatus.armedForLiveOrders ? (
                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Armed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Disarmed
                </span>
              )}
            </div>

            <div className="space-y-2 rounded-lg border border-white/[0.06] bg-[#0D1015] p-3 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Vault Status</span>
                <span className="font-mono text-slate-100">
                  {liveStatus.configured ? 'Configured' : 'Empty'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Verification</span>
                <span
                  className={`font-mono ${
                    liveStatus.verificationStatus === 'verified'
                      ? 'text-emerald-400'
                      : liveStatus.verificationStatus === 'error'
                        ? 'text-rose-400'
                        : 'text-amber-300'
                  }`}
                >
                  {liveStatus.verificationStatus}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">
                  {liveStatus.venue === 'Futures' ? 'Futures Trade Permission' : 'Spot Trade Permission'}
                </span>
                <span className="font-mono text-slate-100">
                  {liveStatus.canTrade ? 'Enabled' : 'Unverified'}
                </span>
              </div>
              {liveStatus.latencyMs !== null && (
                <div className="flex justify-between">
                  <span className="text-slate-400">REST Signed RTT</span>
                  <span className="font-mono text-emerald-300">{liveStatus.latencyMs} ms</span>
                </div>
              )}
            </div>

            {liveStatus.verificationMessage && (
              <p className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2 font-mono text-[11px] text-slate-300">
                {liveStatus.verificationMessage}
              </p>
            )}

            {liveStatus.environment === 'Production' && !liveStatus.armedForLiveOrders && (
              <label className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200">
                <input
                  type="checkbox"
                  checked={confirmProdArm}
                  onChange={(e) => setConfirmProdArm(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  I acknowledge Production mode dispatches real {liveStatus.venue} orders using real account funds up to ${liveStatus.maxOrderNotionalUsdt.toFixed(2)} per order.
                </span>
              </label>
            )}

            <button
              type="button"
              onClick={handleArmToggle}
              disabled={!liveStatus.configured || busyAction !== null}
              className={`w-full rounded-lg py-2.5 text-xs font-bold transition disabled:opacity-40 ${
                liveStatus.armedForLiveOrders
                  ? 'border border-rose-500/40 bg-rose-950/40 text-rose-200 hover:bg-rose-950/70'
                  : 'bg-amber-400 text-[#0B0F17] hover:bg-amber-300'
              }`}
            >
              {liveStatus.armedForLiveOrders ? 'Disarm Live Order Execution' : 'Arm Live Order Execution'}
            </button>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Synced {liveStatus.venue} Account Balances
              </h3>
              <span className="font-mono text-[11px] text-slate-400">{liveStatus.environment}</span>
            </div>

            {liveStatus.syncedBalances.length === 0 ? (
              <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-4 py-5 text-center text-xs text-slate-400">
                Verify credentials to pull live {liveStatus.venue} wallet balances into the isolated Live runtime.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-slate-400">
                      <th className="py-2 font-medium">Asset</th>
                      <th className="py-2 text-right font-medium">Free</th>
                      <th className="py-2 text-right font-medium">Locked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                    {liveStatus.syncedBalances.map((b) => (
                      <tr key={b.asset}>
                        <td className="py-2 font-sans font-semibold text-slate-100 flex items-center gap-1.5">
                          <CheckCircle2 className="h-3 w-3 text-[#7DF2AD]" aria-hidden="true" />
                          {b.asset}
                        </td>
                        <td className="py-2 text-right text-slate-200">{b.free.toFixed(4)}</td>
                        <td className="py-2 text-right text-slate-400">{b.locked.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
