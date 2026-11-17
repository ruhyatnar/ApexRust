import React from 'react';
import { RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BotConfig, EngineSnapshot } from '../engine/types';

interface RiskCircuitBreakerViewProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  onUpdateConfig: (next: BotConfig) => void;
  onSimulateLoss: (symbol: string, lossUsdt: number) => void;
  onTripCircuitBreaker: () => void;
  onResetCircuitBreaker: () => void;
}

export const RiskCircuitBreakerView: React.FC<RiskCircuitBreakerViewProps> = ({
  snapshot,
  config,
  onUpdateConfig,
  onSimulateLoss,
  onTripCircuitBreaker,
  onResetCircuitBreaker,
}) => {
  const { risk } = snapshot;

  const updateRisk = <K extends keyof BotConfig['risk']>(
    key: K,
    val: BotConfig['risk'][K]
  ) => {
    onUpdateConfig({
      ...config,
      risk: { ...config.risk, [key]: val },
    });
  };

  const ddUsedPct = Math.max(0, -risk.cumulativeDailyPnlPct);
  const ddRatio = Math.min(100, (ddUsedPct / Math.max(config.risk.maxDailyDrawdownPct, 0.1)) * 100);
  const profitRatio = Math.min(
    100,
    (Math.max(0, risk.cumulativeDailyPnlPct) / Math.max(config.risk.maxDailyProfitPct, 0.1)) * 100
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Risk Management & Circuit Breakers
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Daily drawdown caps (cumulative and per-pair), profit target locks, and win/loss streak cooldowns.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSimulateLoss(snapshot.pairs[0]?.symbol ?? 'BTCUSDT', 135)}
            className="rounded-md border border-amber-500/40 bg-amber-950/30 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-950/50 whitespace-nowrap"
          >
            Simulate -$135 Loss
          </button>
          {risk.state === 'Active' ? (
            <button
              type="button"
              onClick={onTripCircuitBreaker}
              className="flex items-center gap-1.5 rounded-md bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 whitespace-nowrap"
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Trip Circuit Breaker
            </button>
          ) : (
            <button
              type="button"
              onClick={onResetCircuitBreaker}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset Circuit Breaker
            </button>
          )}
        </div>
      </div>

      {/* Drawdown & Profit Gauges */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Daily Portfolio Guardrails</h3>
            <span
              className={`flex items-center gap-1.5 text-xs font-semibold ${
                risk.state === 'Active'
                  ? 'text-emerald-400'
                  : risk.state === 'Cooldown'
                    ? 'text-amber-400'
                    : 'text-rose-400'
              }`}
            >
              {risk.state === 'Active' ? (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              )}
              {risk.state}
            </span>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Cumulative Daily Drawdown Used</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {ddUsedPct.toFixed(2)}% / {config.risk.maxDailyDrawdownPct.toFixed(2)}%
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-rose-500 transition-all duration-200"
                  style={{ width: `${ddRatio}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Daily Profit Lock Progress</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {Math.max(0, risk.cumulativeDailyPnlPct).toFixed(2)}% / +{config.risk.maxDailyProfitPct.toFixed(2)}%
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-emerald-500 transition-all duration-200"
                  style={{ width: `${profitRatio}%` }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-slate-800 pt-3 font-mono text-xs tabular-nums">
            <div>
              <div className="font-sans text-slate-400">Win Streak</div>
              <div className="mt-0.5 text-base font-semibold text-emerald-400">
                {risk.winStreak} / {config.risk.maxWinStreak}
              </div>
            </div>
            <div>
              <div className="font-sans text-slate-400">Lose Streak</div>
              <div className="mt-0.5 text-base font-semibold text-rose-400">
                {risk.loseStreak} / {config.risk.maxLoseStreak}
              </div>
            </div>
          </div>
        </div>

        {/* Editable Limits */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">Circuit Breaker Thresholds</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="risk-cum-dd" className="block text-xs font-medium text-slate-400">
                Max Cumulative Drawdown (%)
              </label>
              <input
                id="risk-cum-dd"
                type="number"
                step="0.25"
                min="0.5"
                max="20"
                value={config.risk.maxDailyDrawdownPct}
                onChange={(e) => updateRisk('maxDailyDrawdownPct', Number(e.target.value) || 3)}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="risk-pair-dd" className="block text-xs font-medium text-slate-400">
                Max Per-Pair Drawdown (%)
              </label>
              <input
                id="risk-pair-dd"
                type="number"
                step="0.25"
                min="0.25"
                max="10"
                value={config.risk.maxPairDailyDrawdownPct}
                onChange={(e) => updateRisk('maxPairDailyDrawdownPct', Number(e.target.value) || 1.25)}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="risk-profit-cap" className="block text-xs font-medium text-slate-400">
                Max Daily Profit Target (%)
              </label>
              <input
                id="risk-profit-cap"
                type="number"
                step="0.5"
                min="1"
                max="25"
                value={config.risk.maxDailyProfitPct}
                onChange={(e) => updateRisk('maxDailyProfitPct', Number(e.target.value) || 5)}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="risk-lose-streak" className="block text-xs font-medium text-slate-400">
                Max Lose Streak (Cooldown)
              </label>
              <input
                id="risk-lose-streak"
                type="number"
                min="1"
                max="10"
                value={config.risk.maxLoseStreak}
                onChange={(e) => updateRisk('maxLoseStreak', Math.max(1, Number(e.target.value) || 3))}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="risk-win-streak" className="block text-xs font-medium text-slate-400">
                Max Win Streak Cap
              </label>
              <input
                id="risk-win-streak"
                type="number"
                min="2"
                max="15"
                value={config.risk.maxWinStreak}
                onChange={(e) => updateRisk('maxWinStreak', Math.max(2, Number(e.target.value) || 5))}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0D1015] px-3 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between pt-4">
              <label htmlFor="risk-flatten" className="text-xs font-medium text-slate-300">
                Flatten Open Positions on CB
              </label>
              <input
                id="risk-flatten"
                type="checkbox"
                checked={config.risk.flattenOnCircuitBreaker}
                onChange={(e) => updateRisk('flattenOnCircuitBreaker', e.target.checked)}
                className="h-4 w-4 rounded border-white/[0.08] bg-[#0D1015] text-blue-600 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Per-Pair Drawdown & Quarantine Ledger */}
      <div className="rounded-lg border border-white/[0.06] bg-[#141820]">
        <div className="border-b border-slate-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Per-Pair Daily Drawdown & Quarantine Matrix
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-5 py-2.5 font-medium">Symbol</th>
                <th className="px-5 py-2.5 text-right font-medium">Daily PnL (USDT)</th>
                <th className="px-5 py-2.5 text-right font-medium">Daily PnL (%)</th>
                <th className="px-5 py-2.5 text-right font-medium">Pair Limit</th>
                <th className="px-5 py-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
              {snapshot.pairs.map((p) => {
                const quarantined = risk.quarantinedPairs.includes(p.symbol);
                return (
                  <tr key={p.symbol} className="hover:bg-white/[0.02]">
                    <td className="px-5 py-2.5 font-sans font-semibold text-slate-100">{p.symbol}</td>
                    <td
                      className={`px-5 py-2.5 text-right ${
                        p.dailyPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {p.dailyPnlUsdt >= 0 ? '+' : ''}
                      ${p.dailyPnlUsdt.toFixed(2)}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right ${
                        p.dailyPnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {p.dailyPnlPct >= 0 ? '+' : ''}
                      {p.dailyPnlPct.toFixed(2)}%
                    </td>
                    <td className="px-5 py-2.5 text-right text-slate-400">
                      -{config.risk.maxPairDailyDrawdownPct.toFixed(2)}%
                    </td>
                    <td className="px-5 py-2.5 text-right font-sans font-medium">
                      <span className={quarantined ? 'text-rose-400' : 'text-emerald-400'}>
                        {quarantined ? 'Quarantined (UTC Day)' : 'Eligible'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
