import React from 'react';
import {
  Activity,
  GitBranch,
  Layers,
  Power,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sliders,
  Wifi,
} from 'lucide-react';
import type { BotConfig, FeatureToggles } from '../engine/types';

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
    subtitle: 'Control automated scanning, manual order entry, and signal generation.',
    icon: Power,
    items: [
      {
        key: 'automatedTrading',
        label: 'Automated Trading Engine',
        description: 'Dispatches multi-pair entries & exits automatically on qualified trend setups.',
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
  const features = config.features;
  const totalCount = Object.keys(features).length;
  const enabledCount = Object.values(features).filter(Boolean).length;

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
            Enable or isolate every execution stage, market venue, indicator filter, ATR exit rule, and Git backup hook independently.
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
                  const checked = features[item.key];
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
    </div>
  );
};
