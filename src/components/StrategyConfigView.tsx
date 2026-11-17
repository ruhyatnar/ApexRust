import React from 'react';
import { Bot, Pause, Play, Radar, ShieldCheck } from 'lucide-react';
import type {
  BotConfig,
  DirectionPolicy,
  EngineSnapshot,
  ExecutionOrderMethod,
  StrategyMode,
  StrategyProfile,
  Timeframe,
  TimeInForce,
} from '../engine/types';

interface StrategyConfigViewProps {
  config: BotConfig;
  snapshot: EngineSnapshot;
  onUpdateConfig: (next: BotConfig) => void;
  onToggleAutomation: () => void;
  onRunAutoScan: () => void;
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
}) => {
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
              onClick={onRunAutoScan}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3.5 py-2 text-xs font-semibold text-slate-100 transition hover:border-[#7DF2AD]/50 hover:text-[#7DF2AD] whitespace-nowrap"
            >
              <Radar className="h-3.5 w-3.5" aria-hidden="true" />
              Run Auto-Scan Now
            </button>
            <button
              type="button"
              onClick={onToggleAutomation}
              aria-pressed={auto.enabled}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold transition whitespace-nowrap ${
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
                  Enable Auto-Trading
                </>
              )}
            </button>
          </div>
        </div>

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
        <div>
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
                  onClick={() => updateAutomation('strategyProfile', sp.id)}
                  className={`flex flex-col items-start rounded-lg border p-3.5 text-left transition ${
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
        <div className="grid grid-cols-1 gap-5 border-t border-white/[0.06] pt-4 lg:grid-cols-12">
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
                    onClick={() => updateAutomation('orderMethod', om.id)}
                    className={`rounded-lg border p-3 text-left transition ${
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
                Direction Policy
              </label>
              <select
                id="auto-direction-policy"
                value={auto.directionPolicy}
                onChange={(e) => updateAutomation('directionPolicy', e.target.value as DirectionPolicy)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              >
                <option value="long_only">Spot Long Only</option>
                <option value="both">Long & Short</option>
              </select>
            </div>

            <div>
              <label htmlFor="auto-tif" className="block text-xs font-medium text-slate-400">
                Time In Force
              </label>
              <select
                id="auto-tif"
                value={auto.timeInForce}
                onChange={(e) => updateAutomation('timeInForce', e.target.value as TimeInForce)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                value={auto.autoOrderNotionalUsdt}
                onChange={(e) =>
                  updateAutomation('autoOrderNotionalUsdt', Math.max(10, Number(e.target.value) || 10))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                value={auto.limitOffsetBps}
                onChange={(e) =>
                  updateAutomation('limitOffsetBps', Math.min(200, Math.max(1, Number(e.target.value) || 5)))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                value={auto.signalCooldownBars}
                onChange={(e) =>
                  updateAutomation('signalCooldownBars', Math.max(0, Number(e.target.value) || 0))
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                  checked={auto.autoCloseOnExit}
                  onChange={(e) => updateAutomation('autoCloseOnExit', e.target.checked)}
                  className="h-4 w-4 rounded border-white/[0.15] bg-[#141820] text-[#7DF2AD]"
                />
              </label>
            </div>
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
          <h3 className="text-sm font-semibold text-slate-100">Execution & Sizing</h3>

          <div>
            <label htmlFor="cfg-timeframe" className="block text-xs font-medium text-slate-400">
              Primary Candle Timeframe
            </label>
            <select
              id="cfg-timeframe"
              value={config.trading.timeframe}
              onChange={(e) => updateTrading('timeframe', e.target.value as Timeframe)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            >
              <option value="1m">1m (High-Frequency Scalp)</option>
              <option value="3m">3m (Momentum Scalp)</option>
              <option value="5m">5m (Standard Scalping)</option>
              <option value="15m">15m (Intraday Trend)</option>
            </select>
          </div>

          <div>
            <label htmlFor="cfg-risk-trade" className="block text-xs font-medium text-slate-400">
              Risk Per Trade (% Equity)
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
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">Technical Indicators</h3>

          <div>
            <label htmlFor="cfg-adx-min" className="block text-xs font-medium text-slate-400">
              ADX Minimum Trend Strength (Anti-Chop)
            </label>
            <input
              id="cfg-adx-min"
              type="number"
              step="1"
              min="10"
              max="50"
              value={config.indicators.adxMinTrend}
              onChange={(e) => updateIndicators('adxMinTrend', Number(e.target.value) || 25)}
              className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cfg-rsi-min" className="block text-xs font-medium text-slate-400">
                RSI Pullback Min
              </label>
              <input
                id="cfg-rsi-min"
                type="number"
                min="20"
                max="55"
                value={config.indicators.rsiLongPullbackMin}
                onChange={(e) =>
                  updateIndicators('rsiLongPullbackMin', Number(e.target.value) || 42)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cfg-rsi-max" className="block text-xs font-medium text-slate-400">
                RSI Pullback Max
              </label>
              <input
                id="cfg-rsi-max"
                type="number"
                min="45"
                max="75"
                value={config.indicators.rsiLongPullbackMax}
                onChange={(e) =>
                  updateIndicators('rsiLongPullbackMax', Number(e.target.value) || 58)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
              checked={config.indicators.requireVwapAlignment}
              onChange={(e) => updateIndicators('requireVwapAlignment', e.target.checked)}
              className="h-4 w-4 rounded border-white/[0.08] bg-[#0D1015] text-[#7DF2AD]"
            />
          </div>
        </div>

        {/* ATR Exit Multipliers */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">ATR Exit Multipliers</h3>

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
                value={config.exits.atrSlMultiplier}
                onChange={(e) => updateExits('atrSlMultiplier', Number(e.target.value) || 1.5)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                value={config.exits.atrTrailingMultiplier}
                onChange={(e) =>
                  updateExits('atrTrailingMultiplier', Number(e.target.value) || 1.4)
                }
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
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
                value={config.exits.breakEvenTriggerR}
                onChange={(e) => updateExits('breakEvenTriggerR', Number(e.target.value) || 1.0)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cfg-tp2" className="block text-xs font-medium text-slate-400">
                TP2 Runner (× ATR)
              </label>
              <input
                id="cfg-tp2"
                type="number"
                step="0.25"
                min="1.5"
                max="10"
                value={config.exits.atrTp2Multiplier}
                onChange={(e) => updateExits('atrTp2Multiplier', Number(e.target.value) || 3.75)}
                className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
