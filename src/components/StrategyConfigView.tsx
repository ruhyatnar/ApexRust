import React, { useState } from 'react';
import { Activity, Bell, Bot, Pause, Play, Radar, RotateCcw, ShieldCheck, Zap } from 'lucide-react';
import type {
  BotConfig,
  DirectionPolicy,
  EngineSnapshot,
  ExecutionOrderMethod,
  PairSelectionMode,
  PositionSizingMode,
  StrategyMode,
  StrategyProfile,
  Timeframe,
  TimeInForce,
  TrendingCategory,
  TrendingRankingSource,
} from '../engine/types';

interface StrategyConfigViewProps {
  config: BotConfig;
  snapshot: EngineSnapshot;
  onUpdateConfig: (next: BotConfig) => void;
  onToggleAutomation: () => void;
  onRunAutoScan: () => void;
  onSimulateVolatilitySpike?: (symbol: string) => void;
  onResetDefaults?: () => void;
}

const STRATEGY_PROFILES: Array<{
  id: StrategyProfile;
  title: string;
  tag: string;
  summary: string;
}> = [
  {
    id: 'trend_pullback',
    title: 'EMA Trend Pullback',
    tag: 'Mean Pullback',
    summary: 'EMA 9/21/50 directional stack with ADX trend filter, RSI curl recovery, and optional VWAP bias.',
  },
  {
    id: 'ema_breakout',
    title: 'Momentum Breakout',
    tag: 'Donchian 10',
    summary: '10-bar high/low expansion confirmed by stacked EMAs, ADX strength, and >= 1.1x average volume surge.',
  },
  {
    id: 'vwap_reversion',
    title: 'VWAP Reversion',
    tag: 'ATR Stretch',
    summary: 'Fades >= 1.1x ATR extremes away from Session VWAP when RSI curls from oversold/overbought in bounded ADX.',
  },
];

const ORDER_METHODS: Array<{
  id: ExecutionOrderMethod;
  label: string;
  desc: string;
}> = [
  { id: 'MARKET', label: 'MARKET', desc: 'Immediate fill with virtual/server OCO ATR exits' },
  { id: 'LIMIT', label: 'LIMIT', desc: 'Passive resting order offset by bps with GTC/IOC/FOK' },
  { id: 'LIMIT_MAKER', label: 'LIMIT MAKER', desc: 'Post-Only maker order that rejects taker book crossing' },
  { id: 'OCO', label: 'OCO BRACKET', desc: 'Attached TP1/TP2 ladder plus Break-Even and Trailing SL' },
];

export const StrategyConfigView: React.FC<StrategyConfigViewProps> = ({
  config,
  snapshot,
  onUpdateConfig,
  onToggleAutomation,
  onRunAutoScan,
  onSimulateVolatilitySpike,
  onResetDefaults,
}) => {
  const [testSpikeSymbol, setTestSpikeSymbol] = useState<string>(
    config.trading.pairs[0] ?? 'BTCUSDT'
  );
  const [notifPermission, setNotifPermission] = useState<string>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return window.Notification.permission;
    }
    return 'unsupported';
  });
  const [notifFeedback, setNotifFeedback] = useState<string | null>(null);

  const handleRequestNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifPermission('unsupported');
      setNotifFeedback(
        'Web Notification API is unavailable in this browser context; in-app volatility push banners are active.'
      );
      return;
    }
    try {
      const result = await window.Notification.requestPermission();
      setNotifPermission(result);
      if (result === 'granted') {
        setNotifFeedback('Browser notifications granted — high-volatility ATR spikes will push desktop alerts.');
      } else {
        setNotifFeedback(
          `Browser permission is "${result}". High-volatility ATR spikes will continue pushing in-app alert banners.`
        );
      }
    } catch {
      setNotifFeedback(
        'Browser blocked permission prompt in embedded iframe — in-app volatility push banners are active.'
      );
    }
  };
  const updateTrading = <K extends keyof BotConfig['trading']>(
    key: K,
    val: BotConfig['trading'][K]
  ) => {
    onUpdateConfig({
      ...config,
      trading: { ...config.trading, [key]: val },
    });
  };

  const updateIndicators = <K extends keyof BotConfig['indicators']>(
    key: K,
    val: BotConfig['indicators'][K]
  ) => {
    onUpdateConfig({
      ...config,
      indicators: { ...config.indicators, [key]: val },
    });
  };

  const updateExits = <K extends keyof BotConfig['exits']>(
    key: K,
    val: BotConfig['exits'][K]
  ) => {
    onUpdateConfig({
      ...config,
      exits: { ...config.exits, [key]: val },
    });
  };

  const updateAutomation = <K extends keyof BotConfig['automation']>(
    key: K,
    val: BotConfig['automation'][K]
  ) => {
    onUpdateConfig({
      ...config,
      automation: { ...config.automation, [key]: val },
    });
  };

  const rr1 = config.exits.atrTp1Multiplier / Math.max(config.exits.atrSlMultiplier, 0.1);
  const rr2 = config.exits.atrTp2Multiplier / Math.max(config.exits.atrSlMultiplier, 0.1);
  const auto = config.automation;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Automated Strategy, Order Methods & ATR Exits
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Select your autonomous trading strategy, execution order method, direction policy, and ATR exit lifecycle.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0D1015] p-1">
            {(['scalping', 'intraday'] as StrategyMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  const nextTf: Timeframe = mode === 'scalping' ? '5m' : '15m';
                  onUpdateConfig({
                    ...config,
                    trading: { ...config.trading, mode, timeframe: nextTf },
                  });
                }}
                className={`rounded-md px-3.5 py-1.5 text-xs font-semibold capitalize transition whitespace-nowrap ${
                  config.trading.mode === mode
                    ? 'bg-[#7DF2AD] text-[#0B0F17]'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {mode} Mode
              </button>
            ))}
          </div>

          {onResetDefaults && (
            <button
              type="button"
              onClick={onResetDefaults}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200 whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset Defaults
            </button>
          )}
        </div>
      </div>

      {/* Automated Trading Master Console */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#7DF2AD]/25 bg-[#7DF2AD]/10">
              <Bot className="h-4.5 w-4.5 text-[#7DF2AD]" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-sm font-semibold text-slate-100">
                  Autonomous Trading Engine ({snapshot.accountMode})
                </h3>
                <span
                  className={`font-mono text-[11px] font-semibold ${
                    auto.enabled ? 'text-[#7DF2AD]' : 'text-amber-400'
                  }`}
                >
                  {auto.enabled ? 'ENABLED' : 'PAUSED'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Continuously evaluates all {config.trading.pairs.length} pairs each closed bar or on-demand scan, enforcing risk & circuit breakers before dispatching orders.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={
                !config.features.automatedTrading ||
                !config.features.signalGenerator ||
                (config.trading.venue === 'Spot'
                  ? !config.features.spotMarket
                  : !config.features.futuresMarket)
              }
              title={
                !config.features.automatedTrading || !config.features.signalGenerator
                  ? 'Enable Automated Trading and Signal Generator in Feature Toggles'
                  : undefined
              }
              onClick={onRunAutoScan}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-100 transition hover:border-[#7DF2AD]/50 hover:text-[#7DF2AD] disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap"
            >
              <Radar className="h-3.5 w-3.5" aria-hidden="true" />
              Run Auto-Scan Now
            </button>
            <button
              type="button"
              disabled={!config.features.automatedTrading}
              title={
                !config.features.automatedTrading
                  ? 'Automated Trading Engine is toggled OFF in Bot -> Feature Toggles'
                  : undefined
              }
              onClick={onToggleAutomation}
              aria-pressed={auto.enabled}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
                auto.enabled
                  ? 'border border-white/[0.08] bg-[#0D1015] text-slate-200 hover:border-amber-400/50 hover:text-amber-300'
                  : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#95F7BD]'
              }`}
            >
              {auto.enabled ? (
                <>
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  Pause Auto-Trading
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  Auto-Trading Disabled (OFF)
                </>
              )}
            </button>
          </div>
        </div>

        {!config.features.automatedTrading && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-3.5 py-2 text-xs text-amber-200"
          >
            Automated Trading Engine is currently toggled <strong>OFF</strong> in Bot → Feature Toggles. Automated strategy selection and scan controls are locked.
          </div>
        )}

        {/* Live Telemetry Readout */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3.5 py-2.5">
            <div className="text-[11px] text-slate-400">Multi-Pair Scans</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-slate-100">
              {snapshot.autoStats.scansRun}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3.5 py-2.5">
            <div className="text-[11px] text-slate-400">Signals Detected</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-slate-100">
              {snapshot.autoStats.signalsDetected}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3.5 py-2.5">
            <div className="text-[11px] text-slate-400">Auto Orders Dispatched</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-[#7DF2AD]">
              {snapshot.autoStats.autoOrdersDispatched}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3.5 py-2.5">
            <div className="text-[11px] text-slate-400">Last Auto Action</div>
            <div className="mt-0.5 truncate font-mono text-xs font-medium text-slate-200">
              {snapshot.autoStats.lastActionSummary ?? 'Waiting for qualifying signal'}
            </div>
          </div>
        </div>

        {/* Strategy Profile Cards */}
        <div className={!config.features.automatedTrading ? 'opacity-50' : ''}>
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Automated Strategy Selection
            </span>
            <span className="font-mono text-[11px] text-slate-400">
              Active: <strong className="text-[#7DF2AD]">{auto.strategyProfile}</strong>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {STRATEGY_PROFILES.map((sp) => {
              const selected = auto.strategyProfile === sp.id;
              return (
                <button
                  key={sp.id}
                  type="button"
                  disabled={!config.features.automatedTrading}
                  onClick={() => updateAutomation('strategyProfile', sp.id)}
                  className={`flex flex-col items-start rounded-lg border p-3.5 text-left transition disabled:cursor-not-allowed ${
                    selected
                      ? 'border-[#7DF2AD]/60 bg-[#13261E]/70'
                      : 'border-white/[0.06] bg-[#0D1015] hover:border-white/[0.16]'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100">{sp.title}</span>
                    <span
                      className={`font-mono text-[10px] font-semibold ${
                        selected ? 'text-[#7DF2AD]' : 'text-slate-500'
                      }`}
                    >
                      {sp.tag}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{sp.summary}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Order Execution Methods & Policy Parameters */}
        <div className={`grid grid-cols-1 gap-5 border-t border-white/[0.06] pt-4 lg:grid-cols-12 ${!config.features.automatedTrading ? 'opacity-50' : ''}`}>
          <div className="space-y-2.5 lg:col-span-6">
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Default Automated Order Method
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              {ORDER_METHODS.map((om) => {
                const selected = auto.orderMethod === om.id;
                return (
                  <button
                    key={om.id}
                    type="button"
                    disabled={!config.features.automatedTrading}
                    onClick={() => updateAutomation('orderMethod', om.id)}
                    className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed ${
                      selected
                        ? 'border-[#7DF2AD]/60 bg-[#13261E]/70'
                        : 'border-white/[0.06] bg-[#0D1015] hover:border-white/[0.16]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-mono text-xs font-bold ${
                          selected ? 'text-[#7DF2AD]' : 'text-slate-200'
                        }`}
                      >
                        {om.label}
                      </span>
                      {selected && <ShieldCheck className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-slate-400">{om.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-6">
            <div>
              <label htmlFor="auto-direction-policy" className="block text-xs font-medium text-slate-400">
                Direction Policy {config.trading.venue === 'Spot' ? '(Spot Long Only)' : ''}
              </label>
              <select
                id="auto-direction-policy"
                disabled={!config.features.automatedTrading || config.trading.venue === 'Spot'}
                value={config.trading.venue === 'Spot' ? 'long_only' : auto.directionPolicy}
                onChange={(e) => updateAutomation('directionPolicy', e.target.value as DirectionPolicy)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="long_only">Spot / Long Only</option>
                <option value="both">Long &amp; Short</option>
                <option value="short_only">Short Only (Futures)</option>
              </select>
            </div>

            <div>
              <label htmlFor="auto-tif" className="block text-xs font-medium text-slate-400">
                Time In Force
              </label>
              <select
                id="auto-tif"
                disabled={!config.features.automatedTrading}
                value={auto.timeInForce}
                onChange={(e) => updateAutomation('timeInForce', e.target.value as TimeInForce)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
              >
                <option value="GTC">GTC (Good Till Cancel)</option>
                <option value="IOC">IOC (Immediate / Cancel)</option>
                <option value="FOK">FOK (Fill Or Kill)</option>
              </select>
            </div>

            <div>
              <label htmlFor="auto-notional" className="block text-xs font-medium text-slate-400">
                Auto Size (USDT)
              </label>
              <input
                id="auto-notional"
                type="number"
                min="10"
                step="10"
                disabled={!config.features.automatedTrading}
                value={auto.autoOrderNotionalUsdt}
                onChange={(e) =>
                  updateAutomation('autoOrderNotionalUsdt', Math.max(10, Number(e.target.value) || 10))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
              />
            </div>

            <div>
              <label htmlFor="auto-limit-bps" className="block text-xs font-medium text-slate-400">
                Limit Offset (bps)
              </label>
              <input
                id="auto-limit-bps"
                type="number"
                min="1"
                max="100"
                step="1"
                disabled={!config.features.automatedTrading}
                value={auto.limitOffsetBps}
                onChange={(e) =>
                  updateAutomation('limitOffsetBps', Math.min(200, Math.max(1, Number(e.target.value) || 5)))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
              />
            </div>

            <div>
              <label htmlFor="auto-cooldown" className="block text-xs font-medium text-slate-400">
                Signal Cooldown (Bars)
              </label>
              <input
                id="auto-cooldown"
                type="number"
                min="0"
                max="30"
                step="1"
                disabled={!config.features.automatedTrading}
                value={auto.signalCooldownBars}
                onChange={(e) =>
                  updateAutomation('signalCooldownBars', Math.max(0, Number(e.target.value) || 0))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
              />
            </div>

            <div className="flex flex-col justify-end pb-1.5">
              <label
                htmlFor="auto-exit-close"
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 text-xs text-slate-200"
              >
                <span>Auto ATR Exits</span>
                <input
                  id="auto-exit-close"
                  type="checkbox"
                  disabled={!config.features.automatedTrading}
                  checked={auto.autoCloseOnExit}
                  onChange={(e) => updateAutomation('autoCloseOnExit', e.target.checked)}
                  className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD] disabled:cursor-not-allowed"
                />
              </label>
            </div>
          </div>
        </div>

        {/* Dynamic Pending Order & Early Open-Position Exit Controls */}
        <div className={`border-t border-white/[0.06] pt-4 space-y-3 ${!config.features.automatedTrading ? 'opacity-50' : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Dynamic Order Lifecycle &amp; Reversal Protection
            </span>
            <span className="font-mono text-[11px] text-slate-400">
              Cancels stale limits &amp; closes reversals before capital sits trapped
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label
              htmlFor="auto-cancel-rev"
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs text-slate-200"
            >
              <span>Cancel Pending on Signal Flip</span>
              <input
                id="auto-cancel-rev"
                type="checkbox"
                disabled={!config.features.automatedTrading}
                checked={auto.cancelPendingOnSignalReversal ?? true}
                onChange={(e) => updateAutomation('cancelPendingOnSignalReversal', e.target.checked)}
                className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
              />
            </label>
            <label
              htmlFor="auto-cancel-exh"
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs text-slate-200"
            >
              <span>Cancel Pending on Exhaustion</span>
              <input
                id="auto-cancel-exh"
                type="checkbox"
                disabled={!config.features.automatedTrading}
                checked={auto.cancelPendingOnExhaustion ?? true}
                onChange={(e) => updateAutomation('cancelPendingOnExhaustion', e.target.checked)}
                className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
              />
            </label>
            <label
              htmlFor="auto-early-rev-exit"
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs text-slate-200"
            >
              <span>Early Exit on Opposite Signal</span>
              <input
                id="auto-early-rev-exit"
                type="checkbox"
                disabled={!config.features.automatedTrading}
                checked={auto.exitPositionOnSignalReversal ?? true}
                onChange={(e) => updateAutomation('exitPositionOnSignalReversal', e.target.checked)}
                className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
              />
            </label>
            <label
              htmlFor="auto-tighten-trail"
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs text-slate-200"
            >
              <span>Tighten Trail (0.55×) on Fade</span>
              <input
                id="auto-tighten-trail"
                type="checkbox"
                disabled={!config.features.automatedTrading}
                checked={auto.tightenTrailingOnExhaustion ?? true}
                onChange={(e) => updateAutomation('tightenTrailingOnExhaustion', e.target.checked)}
                className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="cfg-pending-ttl" className="block text-xs font-medium text-slate-400">
                Pending Limit Max Age (Bars)
              </label>
              <input
                id="cfg-pending-ttl"
                type="number"
                min="1"
                max="50"
                disabled={!config.features.automatedTrading}
                value={auto.maxPendingOrderBars ?? 6}
                onChange={(e) =>
                  updateAutomation('maxPendingOrderBars', Math.max(1, Number(e.target.value) || 6))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cfg-pending-runaway" className="block text-xs font-medium text-slate-400">
                Runaway Cancel Distance (× ATR)
              </label>
              <input
                id="cfg-pending-runaway"
                type="number"
                step="0.1"
                min="0.5"
                max="10"
                disabled={!config.features.automatedTrading}
                value={auto.maxPendingRunawayAtr ?? 1.8}
                onChange={(e) =>
                  updateAutomation(
                    'maxPendingRunawayAtr',
                    Math.max(0.5, Number(e.target.value) || 1.8)
                  )
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
            <div className="flex flex-col justify-end">
              <label
                htmlFor="auto-flip-rev"
                className={`flex items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs ${
                  config.trading.venue === 'Spot'
                    ? 'cursor-not-allowed text-slate-500 opacity-60'
                    : 'cursor-pointer text-slate-200'
                }`}
              >
                <span>
                  Auto-Flip Reversal {config.trading.venue === 'Spot' ? '(Futures Only)' : ''}
                </span>
                <input
                  id="auto-flip-rev"
                  type="checkbox"
                  disabled={!config.features.automatedTrading || config.trading.venue === 'Spot'}
                  checked={config.trading.venue === 'Spot' ? false : (auto.autoFlipOnReversal ?? false)}
                  onChange={(e) => updateAutomation('autoFlipOnReversal', e.target.checked)}
                  className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Watchlist Mode & Trending Pair Discovery */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Pair Watchlist &amp; Binance Trending Scanner
            </h3>
            <p className="text-xs text-slate-400">
              Switch between Static Only, Hybrid (Pinned + Auto-Trending), or Dynamic Auto-Rotation with hysteresis &amp; dwell protection.
            </p>
          </div>
          <span className="font-mono text-xs text-[#7DF2AD]">
            Active Slots: {snapshot.pairs.length}/{config.trading.maxWatchlistPairs}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="cfg-pair-mode" className="block text-xs font-medium text-slate-400">
              Pair Selection Mode
            </label>
            <select
              id="cfg-pair-mode"
              value={config.trading.pairSelectionMode ?? 'hybrid'}
              onChange={(e) => updateTrading('pairSelectionMode', e.target.value as PairSelectionMode)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-[#7DF2AD] focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="static">static (Pinned Only)</option>
              <option value="hybrid">hybrid (Pinned + Trending)</option>
              <option value="dynamic">dynamic (Full Auto-Trending)</option>
            </select>
          </div>
          <div>
            <label htmlFor="cfg-trend-cat" className="block text-xs font-medium text-slate-400">
              Trending Screener Mode
            </label>
            <select
              id="cfg-trend-cat"
              value={config.trading.trendingCategory ?? 'hot_volume'}
              onChange={(e) => updateTrading('trendingCategory', e.target.value as TrendingCategory)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="hot_volume">hot_volume (24h Liquidity)</option>
              <option value="top_gainers">top_gainers (24h Breakout)</option>
              <option value="top_losers">top_losers (Futures Shorts)</option>
              <option value="volatility_leaders">volatility_leaders (High Range)</option>
            </select>
          </div>
          <div>
            <label htmlFor="cfg-rank-src" className="block text-xs font-medium text-slate-400">
              Screener Data Source
            </label>
            <select
              id="cfg-rank-src"
              value={config.trading.rankingSource ?? 'auto'}
              onChange={(e) => updateTrading('rankingSource', e.target.value as TrendingRankingSource)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="auto">auto (Prod WS + Venue Filter)</option>
              <option value="production">production (Mainnet Rankings)</option>
              <option value="environment">environment (Same Env)</option>
            </select>
          </div>
          <div>
            <label htmlFor="cfg-quote-asset" className="block text-xs font-medium text-slate-400">
              Quote Asset
            </label>
            <select
              id="cfg-quote-asset"
              value={config.trading.quoteAsset ?? 'USDT'}
              onChange={(e) => updateTrading('quoteAsset', e.target.value)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="USDT">USDT</option>
              <option value="USDC">USDC</option>
              <option value="FDUSD">FDUSD</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label htmlFor="cfg-max-watch" className="block text-xs font-medium text-slate-400">
              Max Watchlist
            </label>
            <input
              id="cfg-max-watch"
              type="number"
              min="1"
              max="40"
              value={config.trading.maxWatchlistPairs ?? 20}
              onChange={(e) =>
                updateTrading('maxWatchlistPairs', Math.min(40, Math.max(1, Number(e.target.value) || 20)))
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-trend-n" className="block text-xs font-medium text-slate-400">
              Trending Top N
            </label>
            <input
              id="cfg-trend-n"
              type="number"
              min="1"
              max="20"
              value={config.trading.trendingTopN ?? 5}
              onChange={(e) =>
                updateTrading('trendingTopN', Math.min(20, Math.max(1, Number(e.target.value) || 5)))
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-max-same-dir" className="block text-xs font-medium text-slate-400">
              Max Same Dir
            </label>
            <input
              id="cfg-max-same-dir"
              type="number"
              min="1"
              max="10"
              value={config.trading.maxSameDirectionPositions ?? 2}
              onChange={(e) =>
                updateTrading(
                  'maxSameDirectionPositions',
                  Math.min(10, Math.max(1, Number(e.target.value) || 2))
                )
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-min-vol-usdt" className="block text-xs font-medium text-slate-400">
              Min 24h Vol ($M)
            </label>
            <input
              id="cfg-min-vol-usdt"
              type="number"
              min="1"
              step="5"
              value={Math.round((config.trading.trendingMinQuoteVolumeUsdt ?? 10_000_000) / 1_000_000)}
              onChange={(e) =>
                updateTrading(
                  'trendingMinQuoteVolumeUsdt',
                  Math.max(1_000_000, (Number(e.target.value) || 10) * 1_000_000)
                )
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-dwell-min" className="block text-xs font-medium text-slate-400">
              Min Dwell (Min)
            </label>
            <input
              id="cfg-dwell-min"
              type="number"
              min="0"
              max="120"
              value={config.trading.trendingMinDwellMinutes ?? 15}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateTrading(
                  'trendingMinDwellMinutes',
                  e.target.value !== '' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0
                );
              }}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-hyst-buf" className="block text-xs font-medium text-slate-400">
              Hysteresis Buffer
            </label>
            <input
              id="cfg-hyst-buf"
              type="number"
              min="0"
              max="10"
              value={config.trading.trendingHysteresisRankBuffer ?? 3}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateTrading(
                  'trendingHysteresisRankBuffer',
                  e.target.value !== '' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0
                );
              }}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* ATR Exit Lifecycle Pipeline Visual */}
      <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            ATR Exit Progression Blueprint
          </h3>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            TP1 R:R 1:{rr1.toFixed(2)} · TP2 R:R 1:{rr2.toFixed(2)}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3.5">
            <div className="text-xs font-medium text-rose-400">01. Initial ATR Stop Loss</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
              {config.exits.atrSlMultiplier.toFixed(2)} × ATR
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Defines 1.0R unit risk per position for dynamic position sizing.
            </p>
          </div>

          <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3.5">
            <div className="text-xs font-medium text-amber-400">02. Break-Even Trigger</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
              +{config.exits.breakEvenTriggerR.toFixed(2)}R (+{config.exits.breakEvenFeeBufferBps} bps)
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Shifts SL to entry plus taker fee buffer so winners cannot turn red.
            </p>
          </div>

          <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3.5">
            <div className="text-xs font-medium text-sky-400">03. ATR Trailing Stop</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
              @{config.exits.trailingActivationR.toFixed(2)}R · {config.exits.atrTrailingMultiplier.toFixed(2)} × ATR
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Ratchets monotonically behind highest favorable price.
            </p>
          </div>

          <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3.5">
            <div className="text-xs font-medium text-emerald-400">04. Partial & Runner Targets</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
              {config.exits.atrTp1Multiplier.toFixed(2)} / {config.exits.atrTp2Multiplier.toFixed(2)} × ATR
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Banks {(config.exits.tp1CloseRatio * 100).toFixed(0)}% at TP1 and trails runner to TP2.
            </p>
          </div>
        </div>
      </div>

      {/* Parameter Form Grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Execution & Timeframe */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">Execution & Quantitative Sizing</h3>

          <div>
            <label htmlFor="cfg-sizing-mode" className="block text-xs font-medium text-slate-400">
              Position Sizing Model (§5 Kelly / Risk)
            </label>
            <select
              id="cfg-sizing-mode"
              value={config.trading.positionSizingMode ?? 'fixed_usdt'}
              onChange={(e) =>
                updateTrading('positionSizingMode', e.target.value as PositionSizingMode)
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-[#7DF2AD] focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="fixed_usdt">Fixed Notional (Auto Size USDT)</option>
              <option value="fixed_risk_pct">Fixed % Equity Risk (Stop-Distance)</option>
              <option value="quarter_kelly">Quarter-Kelly (0.25 f* · Conservative)</option>
              <option value="half_kelly">Half-Kelly (0.50 f* · Systematic Benchmark)</option>
              <option value="full_kelly">Full Kelly (1.00 f* · Peak Log Growth)</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-timeframe" className="block text-xs font-medium text-slate-400">
                Candle Timeframe
              </label>
              <select
                id="cfg-timeframe"
                value={config.trading.timeframe}
                onChange={(e) => updateTrading('timeframe', e.target.value as Timeframe)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              >
                <option value="1m">1m (Scalp)</option>
                <option value="3m">3m (Momentum)</option>
                <option value="5m">5m (Standard)</option>
                <option value="15m">15m (Intraday)</option>
                <option value="1h">1h (Swing)</option>
              </select>
            </div>

            <div>
              <label htmlFor="cfg-risk-trade" className="block text-xs font-medium text-slate-400">
                Base Risk (% Eq)
              </label>
              <input
                id="cfg-risk-trade"
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={config.trading.baseRiskPerTradePct}
                onChange={(e) => updateTrading('baseRiskPerTradePct', Number(e.target.value) || 0.5)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cfg-max-pos" className="block text-xs font-medium text-slate-400">
              Max Concurrent Open Pairs
            </label>
            <input
              id="cfg-max-pos"
              type="number"
              min="1"
              max="10"
              value={config.trading.maxConcurrentPositions}
              onChange={(e) =>
                updateTrading('maxConcurrentPositions', Math.max(1, Number(e.target.value) || 1))
              }
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
        </div>

        {/* Technical Indicator Filters */}
        <div className={`rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4 ${!config.features.signalGenerator ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Technical Indicators & Volume</h3>
            {!config.features.signalGenerator && (
              <span className="font-mono text-[10px] text-amber-300">Signal Generator OFF</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-adx-min" className="block text-xs font-medium text-slate-400">
                ADX Min Trend
              </label>
              <input
                id="cfg-adx-min"
                type="number"
                step="1"
                min="10"
                max="50"
                disabled={!config.features.signalGenerator || !config.features.adxStrengthFilter}
                value={config.indicators.adxMinTrend}
                onChange={(e) => updateIndicators('adxMinTrend', Number(e.target.value) || 25)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-vol-mult" className="block text-xs font-medium text-slate-400">
                Vol Surge (× Avg)
              </label>
              <input
                id="cfg-vol-mult"
                type="number"
                step="0.1"
                min="1.0"
                max="3.5"
                disabled={!config.features.signalGenerator || !config.features.volumeConfirmationFilter}
                value={config.indicators.minVolumeExpansionMult ?? 1.5}
                onChange={(e) =>
                  updateIndicators('minVolumeExpansionMult', Number(e.target.value) || 1.5)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-rsi-min" className="block text-xs font-medium text-slate-400">
                RSI Long Pullback Min
              </label>
              <input
                id="cfg-rsi-min"
                type="number"
                min="20"
                max="55"
                disabled={!config.features.signalGenerator || !config.features.rsiMomentumFilter}
                value={config.indicators.rsiLongPullbackMin}
                onChange={(e) =>
                  updateIndicators('rsiLongPullbackMin', Number(e.target.value) || 42)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-rsi-max" className="block text-xs font-medium text-slate-400">
                RSI Long Pullback Max
              </label>
              <input
                id="cfg-rsi-max"
                type="number"
                min="45"
                max="75"
                disabled={!config.features.signalGenerator || !config.features.rsiMomentumFilter}
                value={config.indicators.rsiLongPullbackMax}
                onChange={(e) =>
                  updateIndicators('rsiLongPullbackMax', Number(e.target.value) || 58)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-rsi-short-min" className="block text-xs font-medium text-slate-400">
                RSI Short Pullback Min
              </label>
              <input
                id="cfg-rsi-short-min"
                type="number"
                min="25"
                max="55"
                disabled={!config.features.signalGenerator || !config.features.rsiMomentumFilter}
                value={config.indicators.rsiShortPullbackMin}
                onChange={(e) =>
                  updateIndicators('rsiShortPullbackMin', Number(e.target.value) || 42)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-rsi-short-max" className="block text-xs font-medium text-slate-400">
                RSI Short Pullback Max
              </label>
              <input
                id="cfg-rsi-short-max"
                type="number"
                min="45"
                max="80"
                disabled={!config.features.signalGenerator || !config.features.rsiMomentumFilter}
                value={config.indicators.rsiShortPullbackMax}
                onChange={(e) =>
                  updateIndicators('rsiShortPullbackMax', Number(e.target.value) || 58)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <label htmlFor="cfg-vwap-align" className="text-xs font-medium text-slate-300">
              Require Session VWAP Alignment
            </label>
            <input
              id="cfg-vwap-align"
              type="checkbox"
              disabled={!config.features.signalGenerator || !config.features.vwapBiasFilter}
              checked={config.indicators.requireVwapAlignment}
              onChange={(e) => updateIndicators('requireVwapAlignment', e.target.checked)}
              className="h-4 w-4 rounded border-white/[0.08] bg-[#0D1015] text-[#7DF2AD] disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>

          <div className="border-t border-white/[0.06] pt-3 space-y-3">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              11-Layer Anti-False-Signal Mitigation
            </span>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-ema-ext" className="block text-xs font-medium text-slate-400">
                  Max EMA21 Dist (ATR)
                </label>
                <input
                  id="cfg-ema-ext"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="6"
                  value={config.indicators.maxEmaMidExtensionAtr ?? 2.2}
                  onChange={(e) =>
                    updateIndicators('maxEmaMidExtensionAtr', Number(e.target.value) || 2.2)
                  }
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-vwap-ext" className="block text-xs font-medium text-slate-400">
                  Max VWAP Dist (ATR)
                </label>
                <input
                  id="cfg-vwap-ext"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="6"
                  value={config.indicators.maxVwapExtensionAtr ?? 2.8}
                  onChange={(e) =>
                    updateIndicators('maxVwapExtensionAtr', Number(e.target.value) || 2.8)
                  }
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-close-str" className="block text-xs font-medium text-slate-400">
                  Min Close Strength
                </label>
                <input
                  id="cfg-close-str"
                  type="number"
                  step="0.05"
                  min="0"
                  max="0.95"
                  value={config.indicators.minCloseStrengthRatio ?? 0.55}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    updateIndicators(
                      'minCloseStrengthRatio',
                      e.target.value !== '' && Number.isFinite(v) ? Math.max(0, v) : 0
                    );
                  }}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-body-ratio" className="block text-xs font-medium text-slate-400">
                  Min Body Ratio
                </label>
                <input
                  id="cfg-body-ratio"
                  type="number"
                  step="0.05"
                  min="0"
                  max="0.9"
                  value={config.indicators.minCandleBodyRatio ?? 0.3}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    updateIndicators(
                      'minCandleBodyRatio',
                      e.target.value !== '' && Number.isFinite(v) ? Math.max(0, v) : 0
                    );
                  }}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-di-spread" className="block text-xs font-medium text-slate-400">
                  Min DI Spread (+DI/-DI)
                </label>
                <input
                  id="cfg-di-spread"
                  type="number"
                  step="0.5"
                  min="0"
                  max="20"
                  value={config.indicators.minDiSpread ?? 3}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    updateIndicators(
                      'minDiSpread',
                      e.target.value !== '' && Number.isFinite(v) ? Math.max(0, v) : 0
                    );
                  }}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-max-spread" className="block text-xs font-medium text-slate-400">
                  Max Spread (bps)
                </label>
                <input
                  id="cfg-max-spread"
                  type="number"
                  step="1"
                  min="1"
                  max="100"
                  value={config.indicators.maxSpreadBps ?? 20}
                  onChange={(e) => updateIndicators('maxSpreadBps', Number(e.target.value) || 20)}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-min-warm" className="block text-xs font-medium text-slate-400">
                  Min Warmup Bars
                </label>
                <input
                  id="cfg-min-warm"
                  type="number"
                  step="10"
                  min="50"
                  max="220"
                  value={config.indicators.minWarmupBars ?? 50}
                  onChange={(e) => updateIndicators('minWarmupBars', Number(e.target.value) || 50)}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                />
              </div>
              <div className="flex flex-col justify-end gap-1.5">
                <label htmlFor="cfg-macro-scalp" className="flex items-center justify-between text-xs text-slate-300">
                  <span>Macro EMA in Scalp</span>
                  <input
                    id="cfg-macro-scalp"
                    type="checkbox"
                    checked={config.indicators.requireMacroEmaInScalping ?? true}
                    onChange={(e) =>
                      updateIndicators('requireMacroEmaInScalping', e.target.checked)
                    }
                    className="h-4 w-4 rounded border-white/[0.08] bg-[#0D1015] text-[#7DF2AD]"
                  />
                </label>
                <label htmlFor="cfg-rising-adx" className="flex items-center justify-between text-xs text-slate-300">
                  <span>Require Rising ADX</span>
                  <input
                    id="cfg-rising-adx"
                    type="checkbox"
                    checked={config.indicators.requireRisingAdx ?? true}
                    onChange={(e) => updateIndicators('requireRisingAdx', e.target.checked)}
                    className="h-4 w-4 rounded border-white/[0.08] bg-[#0D1015] text-[#7DF2AD]"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* ATR Exit Multipliers */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">ATR Exit & Fee Buffers</h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-atr-sl" className="block text-xs font-medium text-slate-400">
                ATR SL Mult
              </label>
              <input
                id="cfg-atr-sl"
                type="number"
                step="0.1"
                min="0.5"
                max="5"
                disabled={!config.features.atrDynamicExits}
                value={config.exits.atrSlMultiplier}
                onChange={(e) => updateExits('atrSlMultiplier', Number(e.target.value) || 1.5)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-atr-trail" className="block text-xs font-medium text-slate-400">
                ATR Trail Mult
              </label>
              <input
                id="cfg-atr-trail"
                type="number"
                step="0.1"
                min="0.5"
                max="5"
                disabled={!config.features.atrDynamicExits || !config.features.trailingStop}
                value={config.exits.atrTrailingMultiplier}
                onChange={(e) =>
                  updateExits('atrTrailingMultiplier', Number(e.target.value) || 1.4)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-atr-tp1" className="block text-xs font-medium text-slate-400">
                ATR TP1 Mult
              </label>
              <input
                id="cfg-atr-tp1"
                type="number"
                step="0.05"
                min="0.5"
                max="10"
                disabled={!config.features.atrDynamicExits || !config.features.takeProfitLadder}
                value={config.exits.atrTp1Multiplier}
                onChange={(e) => updateExits('atrTp1Multiplier', Number(e.target.value) || 2.25)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-atr-tp2" className="block text-xs font-medium text-slate-400">
                ATR TP2 Mult
              </label>
              <input
                id="cfg-atr-tp2"
                type="number"
                step="0.05"
                min="0.8"
                max="15"
                disabled={!config.features.atrDynamicExits || !config.features.takeProfitLadder}
                value={config.exits.atrTp2Multiplier}
                onChange={(e) => updateExits('atrTp2Multiplier', Number(e.target.value) || 3.75)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-tp1-ratio" className="block text-xs font-medium text-slate-400">
                TP1 Scale-Out Ratio
              </label>
              <input
                id="cfg-tp1-ratio"
                type="number"
                step="0.05"
                min="0.1"
                max="1"
                disabled={!config.features.takeProfitLadder}
                value={config.exits.tp1CloseRatio}
                onChange={(e) =>
                  updateExits('tp1CloseRatio', Math.min(1, Math.max(0.1, Number(e.target.value) || 0.5)))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-trail-act" className="block text-xs font-medium text-slate-400">
                Trailing Activation (R)
              </label>
              <input
                id="cfg-trail-act"
                type="number"
                step="0.1"
                min="0.3"
                max="5"
                disabled={!config.features.trailingStop}
                value={config.exits.trailingActivationR}
                onChange={(e) => updateExits('trailingActivationR', Number(e.target.value) || 1.2)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-be-r" className="block text-xs font-medium text-slate-400">
                Break-Even Trigger (R)
              </label>
              <input
                id="cfg-be-r"
                type="number"
                step="0.1"
                min="0.4"
                max="3"
                disabled={!config.features.breakEvenStop}
                value={config.exits.breakEvenTriggerR}
                onChange={(e) => updateExits('breakEvenTriggerR', Number(e.target.value) || 1.0)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div>
              <label htmlFor="cfg-be-fee" className="block text-xs font-medium text-slate-400">
                BE Fee Buffer (bps)
              </label>
              <input
                id="cfg-be-fee"
                type="number"
                step="1"
                min="5"
                max="100"
                disabled={!config.features.breakEvenStop}
                value={config.exits.breakEvenFeeBufferBps}
                onChange={(e) => updateExits('breakEvenFeeBufferBps', Number(e.target.value) || 25)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Volatility-Based ATR Alerts & Browser Push Notifications */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10">
              <Bell className="h-4.5 w-4.5 text-amber-300" aria-hidden="true" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-sm font-semibold text-slate-100">
                  ATR Volatility Spike Alerts & Browser Push Notifications
                </h3>
                <span
                  className={`font-mono text-[11px] font-semibold ${
                    config.indicators.volatilityAlertsEnabled !== false
                      ? 'text-[#7DF2AD]'
                      : 'text-slate-500'
                  }`}
                >
                  {config.indicators.volatilityAlertsEnabled !== false ? 'MONITORING ACTIVE' : 'DISABLED'}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  · Browser Push:{' '}
                  <strong
                    className={
                      notifPermission === 'granted'
                        ? 'text-[#7DF2AD]'
                        : notifPermission === 'denied'
                          ? 'text-amber-300'
                          : 'text-sky-300'
                    }
                  >
                    {notifPermission.toUpperCase()}
                  </strong>
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Continuously monitors 14-period Wilder ATR as a percentage of spot price and True Range expansion against the rolling baseline, pushing browser notifications and in-app alerts when high-volatility spikes occur.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRequestNotificationPermission()}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-sky-400/50 hover:text-sky-300 whitespace-nowrap"
            >
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              {notifPermission === 'granted' ? 'Push Enabled' : 'Enable Browser Push'}
            </button>

            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-2 py-1">
              <select
                aria-label="Select pair for ATR volatility spike simulation"
                value={testSpikeSymbol}
                onChange={(e) => setTestSpikeSymbol(e.target.value)}
                className="bg-transparent font-mono text-xs text-slate-200 focus:outline-none"
              >
                {config.trading.pairs.map((sym) => (
                  <option key={sym} value={sym} className="bg-[#0D1015] text-slate-100">
                    {sym}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onSimulateVolatilitySpike?.(testSpikeSymbol)}
                disabled={config.indicators.volatilityAlertsEnabled === false || snapshot.accountMode === 'Live'}
                title={snapshot.accountMode === 'Live' ? 'Spike simulation is Paper-only' : undefined}
                className="flex items-center gap-1 rounded-md bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                Simulate ATR Spike Alert
              </button>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={config.indicators.volatilityAlertsEnabled !== false}
              onClick={() =>
                updateIndicators(
                  'volatilityAlertsEnabled',
                  !(config.indicators.volatilityAlertsEnabled !== false)
                )
              }
              className={`rounded-lg px-3.5 py-2 text-xs font-bold transition whitespace-nowrap ${
                config.indicators.volatilityAlertsEnabled !== false
                  ? 'border border-[#7DF2AD]/40 bg-[#13261E] text-[#7DF2AD]'
                  : 'border border-white/[0.08] bg-[#0D1015] text-slate-400 hover:text-slate-200'
              }`}
            >
              {config.indicators.volatilityAlertsEnabled !== false
                ? 'Alerts Enabled'
                : 'Enable Alerts'}
            </button>
          </div>
        </div>

        {notifFeedback && (
          <div className="rounded-lg border border-sky-400/25 bg-sky-500/10 px-3.5 py-2 text-xs text-sky-200">
            {notifFeedback}
          </div>
        )}

        {/* ATR Volatility Alert Threshold Controls */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3.5">
            <label htmlFor="cfg-atr-spike-pct" className="block text-xs font-medium text-slate-300">
              ATR % of Price Threshold (%)
            </label>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Triggers when 14-bar ATR / Spot Price exceeds this percentage.
            </p>
            <input
              id="cfg-atr-spike-pct"
              type="number"
              step="0.05"
              min="0.10"
              max="5.00"
              value={config.indicators.atrSpikePctThreshold ?? 0.45}
              onChange={(e) =>
                updateIndicators(
                  'atrSpikePctThreshold',
                  Math.max(0.05, Number(e.target.value) || 0.45)
                )
              }
              className="mt-2 w-full rounded-md border border-white/[0.08] bg-[#141820] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3.5">
            <label htmlFor="cfg-atr-exp-ratio" className="block text-xs font-medium text-slate-300">
              ATR Expansion Ratio (× Baseline)
            </label>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Triggers when bar True Range or ATR surges above the rolling 10-bar ATR mean.
            </p>
            <input
              id="cfg-atr-exp-ratio"
              type="number"
              step="0.05"
              min="1.05"
              max="4.00"
              value={config.indicators.atrExpansionRatioThreshold ?? 1.25}
              onChange={(e) =>
                updateIndicators(
                  'atrExpansionRatioThreshold',
                  Math.max(1.05, Number(e.target.value) || 1.25)
                )
              }
              className="mt-2 w-full rounded-md border border-white/[0.08] bg-[#141820] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3.5">
            <label htmlFor="cfg-vol-alert-cooldown" className="block text-xs font-medium text-slate-300">
              Per-Pair Alert Cooldown (sec)
            </label>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Minimum interval before re-notifying the same symbol during sustained volatility.
            </p>
            <input
              id="cfg-vol-alert-cooldown"
              type="number"
              step="15"
              min="0"
              max="600"
              value={config.indicators.volatilityAlertCooldownSec ?? 60}
              onChange={(e) =>
                updateIndicators(
                  'volatilityAlertCooldownSec',
                  Math.max(0, Number(e.target.value) || 0)
                )
              }
              className="mt-2 w-full rounded-md border border-white/[0.08] bg-[#141820] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
        </div>

        {/* Live Per-Pair ATR Volatility Telemetry Strip */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Activity className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
              Live Multi-Pair ATR Volatility Telemetry
            </span>
            <span className="font-mono text-[11px] text-slate-400">
              Thresholds: ≥{(config.indicators.atrSpikePctThreshold ?? 0.45).toFixed(2)}% Price · ≥
              {(config.indicators.atrExpansionRatioThreshold ?? 1.25).toFixed(2)}× Baseline
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
            {snapshot.pairs.map((p) => {
              const atr = p.indicators.atr ?? 0;
              const atrPct = p.lastPrice > 0 ? (atr / p.lastPrice) * 100 : 0;
              const prevAtrs = p.indicatorHistory
                .slice(-12, -1)
                .map((h) => h.atr)
                .filter((v): v is number => v !== null && v > 0);
              const baseAtr =
                prevAtrs.length > 0
                  ? prevAtrs.reduce((acc, v) => acc + v, 0) / prevAtrs.length
                  : atr;
              const lastBar = p.candles[p.candles.length - 1];
              const prevBar = p.candles[p.candles.length - 2];
              const prevClose = prevBar?.close ?? lastBar?.open ?? p.lastPrice;
              const trueRange = lastBar
                ? Math.max(
                    lastBar.high - lastBar.low,
                    Math.abs(lastBar.high - prevClose),
                    Math.abs(lastBar.low - prevClose)
                  )
                : 0;
              const expRatio = baseAtr > 0 ? Math.max(atr / baseAtr, trueRange / baseAtr) : 1.0;
              const pctThresh = config.indicators.atrSpikePctThreshold ?? 0.45;
              const ratioThresh = config.indicators.atrExpansionRatioThreshold ?? 1.25;
              const isSpiking =
                (atrPct >= pctThresh && expRatio >= ratioThresh) ||
                expRatio >= ratioThresh * 1.18;
              const decimals = p.lastPrice >= 100 ? 2 : 4;

              return (
                <div
                  key={p.symbol}
                  className={`rounded-lg border p-3 ${
                    isSpiking
                      ? 'border-amber-400/50 bg-amber-500/10'
                      : 'border-white/[0.06] bg-[#0D1015]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-slate-100">{p.symbol}</span>
                    <span
                      className={`font-mono text-[10px] font-semibold ${
                        isSpiking ? 'text-amber-300' : 'text-[#7DF2AD]'
                      }`}
                    >
                      {isSpiking ? 'SPIKE' : 'NORMAL'}
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono text-xs tabular-nums text-slate-200">
                    ATR ${atr.toFixed(decimals)} ({atrPct.toFixed(2)}%)
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-400">
                    Expansion: {expRatio.toFixed(2)}× baseline
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Triggered Volatility Alerts Log */}
        <div className="border-t border-white/[0.06] pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Recent ATR Volatility Spike Alerts ({(snapshot.volatilityAlerts ?? []).length})
            </span>
          </div>
          {(snapshot.volatilityAlerts ?? []).length === 0 ? (
            <div className="rounded-lg border border-white/[0.05] bg-[#0D1015] px-4 py-3 text-xs text-slate-400">
              No high-volatility ATR spikes triggered yet in this session. Click{' '}
              <strong className="text-amber-300">Simulate ATR Spike Alert</strong> above or step bars during high volatility to test browser push notifications.
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {(snapshot.volatilityAlerts ?? []).slice(0, 6).map((alert) => (
                <div
                  key={alert.id}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs ${
                    alert.severity === 'extreme'
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-100'
                      : 'border-amber-400/35 bg-amber-500/10 text-amber-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                    <span className="font-mono font-semibold">{alert.symbol}</span>
                    <span className="text-slate-200">{alert.message}</span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">
                    {new Date(alert.timestampMs).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
