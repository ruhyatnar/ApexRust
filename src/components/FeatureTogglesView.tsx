import React, { useEffect, useState } from 'react';
import {
  Activity,
  Clock,
  GitBranch,
  Layers,
  Plus,
  Power,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sliders,
  Trash2,
  Wifi,
} from 'lucide-react';
import {
  DEFAULT_UTC_SESSION_WINDOWS,
  UTC_SESSION_PRESETS,
  evaluateUtcSessionWindows,
  parseUtcTimeToMinutes,
} from '../engine/sessionWindows';
import type { BotConfig, FeatureToggles, UtcTimeWindow } from '../engine/types';

interface FeatureTogglesViewProps {
  config: BotConfig;
  onUpdateConfig: (next: BotConfig) => void;
}

interface ToggleItem {
  key: keyof FeatureToggles;
  label: string;
  description: string;
}

interface ToggleGroup {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  items: ToggleItem[];
}

const TOGGLE_GROUPS: ToggleGroup[] = [
  {
    id: 'execution',
    title: 'Execution & Signal Core',
    subtitle: 'Control automated scanning, session time windows, manual order entry, and signals.',
    icon: Power,
    items: [
      {
        key: 'automatedTrading',
        label: 'Automated Trading Engine',
        description: 'Dispatches multi-pair entries & exits automatically on qualified trend setups.',
      },
      {
        key: 'sessionWindowFilter',
        label: 'UTC Liquidity Session Windows',
        description:
          'Restricts automated entry execution to configured daily UTC time windows; open position exits still run 24/7.',
      },
      {
        key: 'manualTrading',
        label: 'Manual Order Ticket',
        description: 'Allows manual MARKET, LIMIT, LIMIT MAKER, and OCO execution from the Trade desk.',
      },
      {
        key: 'signalGenerator',
        label: 'Signal Generator Pipeline',
        description: 'Evaluates technical confluence and emits actionable Long/Short trade signals.',
      },
    ],
  },
  {
    id: 'venues',
    title: 'Binance Market Venues',
    subtitle: 'Enable or lock Spot and USD-M Futures venues across paper & live desks.',
    icon: Layers,
    items: [
      {
        key: 'spotMarket',
        label: 'Binance Spot Market',
        description: 'Spot wallet orderbook, /api/v3 REST + WebSocket streams, and OCO lists.',
      },
      {
        key: 'futuresMarket',
        label: 'Binance USD-M Futures',
        description: 'Perpetual contracts (/fapi/v1), isolated/crossed margin, leverage, and Two-Way entries.',
      },
    ],
  },
  {
    id: 'transport',
    title: 'Connectivity & Failover',
    subtitle: 'Configure WebSocket primary streams and automatic REST fallback.',
    icon: Wifi,
    items: [
      {
        key: 'wsPrimaryFeed',
        label: 'WebSocket Primary Feed',
        description: 'Low-latency streaming klines and bookTicker updates as the primary market channel.',
      },
      {
        key: 'restFallback',
        label: 'REST API Fallback',
        description: 'Automatically degrades to Binance REST polling when WebSocket heartbeats stall.',
      },
    ],
  },
  {
    id: 'indicators',
    title: 'Technical Indicator Filters',
    subtitle: 'Toggle individual indicator gates inside the multi-pair signal evaluator.',
    icon: Radio,
    items: [
      {
        key: 'emaTrendFilter',
        label: 'EMA Stack Filter (9/21/50/200)',
        description: 'Enforces fast/mid/slow/macro moving-average alignment with trend direction.',
      },
      {
        key: 'rsiMomentumFilter',
        label: 'Wilder RSI(14) Pullback Curl',
        description: 'Requires RSI pullback zone timing and directional slope curl before entry.',
      },
      {
        key: 'adxStrengthFilter',
        label: 'ADX(14) + DI Trend Strength',
        description: 'Rejects low-ADX sideways chop and enforces +DI/-DI directional dominance.',
      },
      {
        key: 'vwapBiasFilter',
        label: 'Session VWAP Bias Filter',
        description: 'Confirms entry price alignment relative to session volume-weighted average price.',
      },
      {
        key: 'volumeConfirmationFilter',
        label: 'Volume Expansion Filter (≥1.5× Avg)',
        description: 'Requires trigger candle volume to exceed 1.5×–2.0× 20-bar baseline volume to confirm institutional participation.',
      },
    ],
  },
  {
    id: 'exits',
    title: 'ATR Exits & Position Protection',
    subtitle: 'Control dynamic ATR stop placement, ladder targets, break-even, and trailing.',
    icon: Activity,
    items: [
      {
        key: 'atrDynamicExits',
        label: 'ATR-Based Dynamic Exits',
        description: 'Sizes stop-loss and take-profit distances dynamically using live ATR(14) volatility.',
      },
      {
        key: 'takeProfitLadder',
        label: 'Multi-Target TP Ladder',
        description: 'Executes partial TP1 scaling and runner targets (TP2+) automatically.',
      },
      {
        key: 'breakEvenStop',
        label: 'Automatic Break-Even Stop',
        description: 'Advances active SL above entry + fee buffer once profit reaches the R trigger.',
      },
      {
        key: 'trailingStop',
        label: 'Monotonic ATR Trailing Stop',
        description: 'Ratchets stop loss monotonically in trend direction without ever widening risk.',
      },
    ],
  },
  {
    id: 'risk_backup',
    title: 'Risk Guard & Git Backup Sync',
    subtitle: 'Hard circuit breakers and automated sanitized configuration backup.',
    icon: ShieldAlert,
    items: [
      {
        key: 'circuitBreaker',
        label: 'Risk Circuit Breaker & Quarantine',
        description: 'Enforces daily cumulative drawdown, pair drawdown, profit lock, and streak halts.',
      },
      {
        key: 'gitAutoBackup',
        label: 'Git Auto-Backup on Save',
        description: 'Creates a sanitized Git snapshot commit whenever strategy settings are saved.',
      },
    ],
  },
];

export const FeatureTogglesView: React.FC<FeatureTogglesViewProps> = ({
  config,
  onUpdateConfig,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const features = config.features;
  const totalCount = Object.keys(features).length;
  const enabledCount = Object.values(features).filter(Boolean).length;
  const sessionWindows =
    config.automation.sessionWindows && config.automation.sessionWindows.length > 0
      ? config.automation.sessionWindows
      : DEFAULT_UTC_SESSION_WINDOWS;

  const sessionEval = evaluateUtcSessionWindows(
    nowMs,
    sessionWindows,
    Boolean(features.sessionWindowFilter)
  );

  const setFeature = (key: keyof FeatureToggles, value: boolean) => {
    const nextFeatures: FeatureToggles = {
      ...features,
      [key]: value,
    };
    const nextConfig: BotConfig = {
      ...config,
      features: nextFeatures,
      automation: {
        ...config.automation,
        enabled: key === 'automatedTrading' ? value : config.automation.enabled,
      },
    };
    onUpdateConfig(nextConfig);
  };

  const updateSessionWindows = (nextWindows: UtcTimeWindow[]) => {
    onUpdateConfig({
      ...config,
      automation: {
        ...config.automation,
        sessionWindows: nextWindows,
      },
    });
  };

  const handleToggleWindow = (id: string, enabled: boolean) => {
    updateSessionWindows(
      sessionWindows.map((w) => (w.id === id ? { ...w, enabled } : w))
    );
  };

  const handleUpdateWindowField = (
    id: string,
    field: 'label' | 'startUtc' | 'endUtc',
    value: string
  ) => {
    updateSessionWindows(
      sessionWindows.map((w) => (w.id === id ? { ...w, [field]: value } : w))
    );
  };

  const handleRemoveWindow = (id: string) => {
    updateSessionWindows(sessionWindows.filter((w) => w.id !== id));
  };

  const handleAddCustomWindow = () => {
    const newId = `custom-${Date.now()}`;
    updateSessionWindows([
      ...sessionWindows,
      {
        id: newId,
        label: `Custom Session ${sessionWindows.length + 1}`,
        startUtc: '13:30',
        endUtc: '17:00',
        enabled: true,
      },
    ]);
  };

  const handleAddPresetWindow = (preset: (typeof UTC_SESSION_PRESETS)[number]) => {
    const existing = sessionWindows.find((w) => w.id === preset.id);
    if (existing) {
      updateSessionWindows(
        sessionWindows.map((w) =>
          w.id === preset.id
            ? { ...w, startUtc: preset.startUtc, endUtc: preset.endUtc, enabled: true }
            : w
        )
      );
      return;
    }
    updateSessionWindows([
      ...sessionWindows,
      {
        id: preset.id,
        label: preset.label,
        startUtc: preset.startUtc,
        endUtc: preset.endUtc,
        enabled: true,
      },
    ]);
  };

  const handleEnableAll = () => {
    const allTrue = Object.fromEntries(
      Object.keys(features).map((k) => [k, true])
    ) as unknown as FeatureToggles;
    onUpdateConfig({
      ...config,
      features: allTrue,
      automation: { ...config.automation, enabled: true },
    });
  };

  const handleSafeDefaults = () => {
    onUpdateConfig({
      ...config,
      features: {
        automatedTrading: false,
        manualTrading: true,
        signalGenerator: true,
        wsPrimaryFeed: true,
        restFallback: true,
        emaTrendFilter: true,
        rsiMomentumFilter: true,
        adxStrengthFilter: true,
        vwapBiasFilter: true,
        volumeConfirmationFilter: false,
        sessionWindowFilter: false,
        atrDynamicExits: true,
        takeProfitLadder: true,
        breakEvenStop: true,
        trailingStop: true,
        circuitBreaker: true,
        spotMarket: true,
        futuresMarket: true,
        gitAutoBackup: false,
      },
      automation: { ...config.automation, enabled: false },
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Modular Feature Toggles
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Enable or isolate every execution stage, UTC liquidity schedule, market venue, indicator filter, ATR exit rule, and Git backup hook independently.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-[#141820] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-300">
            <Sliders className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
            <span>
              <strong className="text-[#7DF2AD]">{enabledCount}</strong> / {totalCount} Enabled
            </span>
          </div>

          <button
            type="button"
            onClick={handleSafeDefaults}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-amber-400/40 hover:text-amber-200 whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Manual Safe Preset
          </button>

          <button
            type="button"
            onClick={handleEnableAll}
            className="flex items-center gap-1.5 rounded-lg bg-[#7DF2AD] px-3.5 py-1.5 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD] whitespace-nowrap"
          >
            <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
            Enable All Features
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {TOGGLE_GROUPS.map((group) => {
          const Icon = group.icon;
          const groupEnabled = group.items.filter((i) => features[i.key]).length;
          return (
            <section
              key={group.id}
              aria-label={group.title}
              className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#7DF2AD]/10 text-[#7DF2AD]">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">{group.title}</h3>
                    <p className="mt-0.5 text-xs text-slate-400">{group.subtitle}</p>
                  </div>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-slate-400 whitespace-nowrap">
                  {groupEnabled}/{group.items.length} ON
                </span>
              </div>

              <div className="space-y-2.5">
                {group.items.map((item) => {
                  const checked = Boolean(features[item.key]);
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.06] bg-[#0D1015] px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-slate-100">
                            {item.label}
                          </span>
                          <span
                            className={`font-mono text-[10px] font-bold ${
                              checked ? 'text-[#7DF2AD]' : 'text-slate-500'
                            }`}
                          >
                            {checked ? 'ON' : 'OFF'}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-400">{item.description}</p>
                      </div>

                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={item.label}
                        onClick={() => setFeature(item.key, !checked)}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
                          checked ? 'bg-[#7DF2AD]' : 'bg-slate-700'
                        }`}
                      >
                        <span
                          className={`h-4 w-4 rounded-full bg-[#0B0F17] transition-transform ${
                            checked ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* Daily High-Liquidity Market Session Windows (UTC) Configuration */}
      <section
        aria-label="Daily UTC High-Liquidity Session Windows"
        className="rounded-xl border border-white/[0.06] bg-[#141820] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] pb-3.5">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#7DF2AD]/10 text-[#7DF2AD]">
              <Clock className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-sm font-semibold text-slate-100">
                  Daily High-Liquidity Market Sessions (UTC)
                </h3>
                <span
                  className={`font-mono text-[10px] font-bold uppercase ${
                    !features.sessionWindowFilter
                      ? 'text-slate-400'
                      : sessionEval.allowed
                        ? 'text-[#7DF2AD]'
                        : 'text-amber-400'
                  }`}
                >
                  {!features.sessionWindowFilter
                    ? 'STANDBY · 24/7 ACTIVE'
                    : sessionEval.allowed
                      ? `ENFORCED · IN SESSION (${sessionEval.activeWindow?.label ?? 'ACTIVE'})`
                      : 'ENFORCED · OUTSIDE WINDOW'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Current UTC Clock:{' '}
                <strong className="font-mono text-slate-200 tabular-nums">
                  {sessionEval.currentUtcHHMM} UTC
                </strong>{' '}
                · {sessionEval.reason}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(features.sessionWindowFilter)}
              aria-label="Enforce UTC Liquidity Session Filter"
              onClick={() => setFeature('sessionWindowFilter', !features.sessionWindowFilter)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                features.sessionWindowFilter
                  ? 'border-[#7DF2AD]/45 bg-[#7DF2AD]/10 text-[#7DF2AD]'
                  : 'border-white/[0.08] bg-[#0D1015] text-slate-300 hover:border-white/20'
              }`}
            >
              <span>{features.sessionWindowFilter ? 'Filter Enforced' : 'Enable Time Filter'}</span>
            </button>

            <button
              type="button"
              onClick={handleAddCustomWindow}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-[#7DF2AD]/40 hover:text-[#7DF2AD]"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add UTC Window
            </button>
          </div>
        </div>

        {/* High-Liquidity Session Presets */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-slate-400 mr-1">
            Session Presets:
          </span>
          {UTC_SESSION_PRESETS.map((preset) => {
            const active = sessionWindows.some((w) => w.id === preset.id && w.enabled);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleAddPresetWindow(preset)}
                className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition ${
                  active
                    ? 'border-[#7DF2AD]/40 bg-[#7DF2AD]/10 text-[#7DF2AD]'
                    : 'border-white/[0.08] bg-[#0D1015] text-slate-300 hover:border-[#7DF2AD]/30 hover:text-slate-100'
                }`}
              >
                {preset.label} ({preset.startUtc}–{preset.endUtc})
              </button>
            );
          })}
        </div>

        {/* Configured Daily UTC Windows */}
        {sessionWindows.length === 0 ? (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
            No UTC session windows configured. While the filter is enabled with zero active windows, all automated entries are paused. Add a preset or custom UTC window above.
          </div>
        ) : (
          <div className="space-y-2">
            {sessionWindows.map((win) => {
              const startMin = parseUtcTimeToMinutes(win.startUtc);
              const endMin = parseUtcTimeToMinutes(win.endUtc);
              const isOvernight =
                startMin !== null && endMin !== null && startMin > endMin;
              const isCurrentlyActive = sessionEval.activeWindow?.id === win.id;

              return (
                <div
                  key={win.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 ${
                    isCurrentlyActive
                      ? 'border-[#7DF2AD]/35 bg-[#7DF2AD]/[0.04]'
                      : 'border-white/[0.06] bg-[#0D1015]'
                  }`}
                >
                  <div className="flex min-w-[200px] flex-1 items-center gap-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={win.enabled}
                      aria-label={`Toggle ${win.label} session window`}
                      onClick={() => handleToggleWindow(win.id, !win.enabled)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
                        win.enabled ? 'bg-[#7DF2AD]' : 'bg-slate-700'
                      }`}
                    >
                      <span
                        className={`h-4 w-4 rounded-full bg-[#0B0F17] transition-transform ${
                          win.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>

                    <input
                      type="text"
                      aria-label={`Session label for ${win.id}`}
                      value={win.label}
                      onChange={(e) =>
                        handleUpdateWindowField(win.id, 'label', e.target.value)
                      }
                      className="w-full max-w-[220px] rounded border border-white/[0.08] bg-[#141820] px-2.5 py-1 text-xs font-medium text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                    />

                    {isCurrentlyActive && (
                      <span className="font-mono text-[10px] font-bold text-[#7DF2AD] whitespace-nowrap">
                        ACTIVE NOW
                      </span>
                    )}
                    {isOvernight && (
                      <span className="font-mono text-[10px] text-slate-400 whitespace-nowrap">
                        Overnight UTC
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 font-mono text-xs">
                    <label className="flex items-center gap-1.5 text-slate-400">
                      <span className="text-[11px]">Start UTC</span>
                      <input
                        type="time"
                        aria-label={`${win.label} start UTC`}
                        value={win.startUtc}
                        onChange={(e) =>
                          handleUpdateWindowField(win.id, 'startUtc', e.target.value)
                        }
                        className="rounded border border-white/[0.08] bg-[#141820] px-2 py-1 text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                      />
                    </label>

                    <span className="text-slate-500">→</span>

                    <label className="flex items-center gap-1.5 text-slate-400">
                      <span className="text-[11px]">End UTC</span>
                      <input
                        type="time"
                        aria-label={`${win.label} end UTC`}
                        value={win.endUtc}
                        onChange={(e) =>
                          handleUpdateWindowField(win.id, 'endUtc', e.target.value)
                        }
                        className="rounded border border-white/[0.08] bg-[#141820] px-2 py-1 text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
                      />
                    </label>

                    <button
                      type="button"
                      aria-label={`Remove ${win.label} window`}
                      onClick={() => handleRemoveWindow(win.id)}
                      className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
