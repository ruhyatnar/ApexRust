import React, { useMemo } from 'react';
import { AlertTriangle, RotateCcw, ShieldAlert, ShieldCheck, TrendingUp } from 'lucide-react';
import {
  computeExpectancyStats,
  computeKellySizingAnalytics,
  computePortfolioCorrelationMatrix,
} from '../engine/quantAnalytics';
import type { BotConfig, EngineSnapshot, PositionSizingMode } from '../engine/types';

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

  const updateSizingMode = (mode: PositionSizingMode) => {
    onUpdateConfig({
      ...config,
      trading: { ...config.trading, positionSizingMode: mode },
    });
  };

  const ddUsedPct = Math.max(0, -risk.cumulativeDailyPnlPct);
  const ddRatio = Math.min(100, (ddUsedPct / Math.max(config.risk.maxDailyDrawdownPct, 0.1)) * 100);
  const profitRatio = Math.min(
    100,
    (Math.max(0, risk.cumulativeDailyPnlPct) / Math.max(config.risk.maxDailyProfitPct, 0.1)) * 100
  );

  const expectancy = useMemo(
    () => computeExpectancyStats(snapshot.recentTrades, config.trading.baseRiskPerTradePct),
    [snapshot.recentTrades, config.trading.baseRiskPerTradePct]
  );

  const primaryPair = snapshot.pairs[0];
  const primaryStopFrac = useMemo(() => {
    if (!primaryPair || primaryPair.lastPrice <= 0) return 0.015;
    const atr = primaryPair.indicators.atr ?? primaryPair.lastPrice * 0.01;
    return Math.max(0.002, (atr * config.exits.atrSlMultiplier) / primaryPair.lastPrice);
  }, [primaryPair, config.exits.atrSlMultiplier]);

  const kelly = useMemo(
    () =>
      computeKellySizingAnalytics(
        expectancy,
        risk.currentEquity,
        primaryStopFrac,
        config.trading.baseRiskPerTradePct
      ),
    [expectancy, risk.currentEquity, primaryStopFrac, config.trading.baseRiskPerTradePct]
  );

  const portfolioCorr = useMemo(
    () => computePortfolioCorrelationMatrix(snapshot.pairs, kelly.halfKellyPct),
    [snapshot.pairs, kelly.halfKellyPct]
  );

  const growthSvg = useMemo(() => {
    const pts = kelly.growthCurve;
    const w = 440;
    const h = 130;
    const maxF = Math.max(...pts.map((p) => p.fractionPct), 10);
    const minG = Math.min(...pts.map((p) => p.logGrowthBps), -20);
    const maxG = Math.max(...pts.map((p) => p.logGrowthBps), 40);
    const spanG = Math.max(maxG - minG, 10);

    const toCoord = (fPct: number, gBps: number) => {
      const x = 28 + (fPct / maxF) * (w - 48);
      const y = h - 22 - ((gBps - minG) / spanG) * (h - 38);
      return { x, y };
    };

    const zeroY = toCoord(0, 0).y;
    const pathD = pts
      .map((pt, idx) => {
        const c = toCoord(pt.fractionPct, pt.logGrowthBps);
        return `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`;
      })
      .join(' ');

    const fullPt = toCoord(
      kelly.fullKellyPct,
      kelly.tiers.find((t) => t.id === 'full_kelly')
        ? kelly.tiers.find((t) => t.id === 'full_kelly')!.logGrowthRateG * 10_000
        : 0
    );
    const halfPt = toCoord(
      kelly.halfKellyPct,
      kelly.tiers.find((t) => t.id === 'half_kelly')
        ? kelly.tiers.find((t) => t.id === 'half_kelly')!.logGrowthRateG * 10_000
        : 0
    );
    const quarterPt = toCoord(
      kelly.quarterKellyPct,
      kelly.tiers.find((t) => t.id === 'quarter_kelly')
        ? kelly.tiers.find((t) => t.id === 'quarter_kelly')!.logGrowthRateG * 10_000
        : 0
    );

    return { w, h, zeroY, pathD, fullPt, halfPt, quarterPt };
  }, [kelly]);

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

      {/* §5 & §6 Executive Briefing: Kelly Criterion, G(f) Growth Curve & Expectancy (R) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Strategy Expectancy (R) & Profit Factor Card (§6) */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4 lg:col-span-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Strategy Expectancy (R) &amp; Profit Factor
              </h3>
              <p className="text-xs text-slate-400">
                E(R) = (p × Avg Win) − (q × Avg Loss) · Viable PF target 1.3–2.0
              </p>
            </div>
            <span
              className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
                expectancy.expectancyR > 0
                  ? 'bg-emerald-500/15 text-[#7DF2AD]'
                  : 'bg-rose-500/20 text-rose-300'
              }`}
            >
              {expectancy.expectancyR >= 0 ? '+' : ''}
              {expectancy.expectancyR.toFixed(2)}R / Trade
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 font-mono text-xs tabular-nums">
            <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3">
              <div className="font-sans text-[11px] text-slate-400">Win Rate (p) / Loss (q)</div>
              <div className="mt-1 text-base font-bold text-slate-100">
                {(expectancy.winRateP * 100).toFixed(1)}% / {(expectancy.lossRateQ * 100).toFixed(1)}%
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {expectancy.sampleCount} closed trades ({expectancy.isStatisticallySignificant ? '≥50 valid' : '<50 warmup'})
              </div>
            </div>

            <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3">
              <div className="font-sans text-[11px] text-slate-400">Profit Factor (GP / GL)</div>
              <div
                className={`mt-1 text-base font-bold ${
                  expectancy.profitFactor >= 1.3 ? 'text-emerald-400' : 'text-amber-300'
                }`}
              >
                {expectancy.profitFactor.toFixed(2)}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                Regime: {expectancy.profitFactorRegime}
              </div>
            </div>

            <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3">
              <div className="font-sans text-[11px] text-slate-400">Payoff Ratio (b)</div>
              <div className="mt-1 text-base font-bold text-sky-300">
                {expectancy.payoffRatioB.toFixed(2)} : 1
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                +{expectancy.avgWinR.toFixed(2)}R vs -{expectancy.avgLossR.toFixed(2)}R
              </div>
            </div>

            <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3">
              <div className="font-sans text-[11px] text-slate-400">500-Trade Max Loss Run</div>
              <div className="mt-1 text-base font-bold text-amber-300">
                {expectancy.expectedMaxLossStreak500} Losses
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                12L DD @ {config.trading.baseRiskPerTradePct}%: -{expectancy.streak12DrawdownAtCurrentRiskPct.toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="rounded-md border border-white/[0.06] bg-[#0D1015] p-3 text-xs text-slate-300 space-y-1">
            <div className="font-semibold text-slate-200">
              12-Consecutive-Loss Tail Stress Comparison (§6)
            </div>
            <div className="flex justify-between font-mono text-[11px]">
              <span className="text-slate-400">1.0% Quarter-Kelly Limit:</span>
              <span className="text-emerald-400">-{expectancy.streak12DrawdownAt1PctRisk.toFixed(1)}% Peak-to-Trough</span>
            </div>
            <div className="flex justify-between font-mono text-[11px]">
              <span className="text-slate-400">Current ({config.trading.baseRiskPerTradePct}% Equity Risk):</span>
              <span className="text-sky-300">-{expectancy.streak12DrawdownAtCurrentRiskPct.toFixed(1)}% Peak-to-Trough</span>
            </div>
            <div className="flex justify-between font-mono text-[11px]">
              <span className="text-slate-400">5.0% Over-Allocated Risk:</span>
              <span className="text-rose-400">-{expectancy.streak12DrawdownAt5PctRisk.toFixed(1)}% Account Decline</span>
            </div>
          </div>
        </div>

        {/* Expected Logarithmic Growth Curve G(f) & Fractional Kelly Selector (§5) */}
        <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-4 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Kelly Criterion &amp; Expected Logarithmic Utility G(f)
              </h3>
              <p className="text-xs text-slate-400">
                f* = (b·p − q) / b = <strong className="font-mono text-[#7DF2AD]">{kelly.fullKellyPct.toFixed(2)}%</strong> · Half-Kelly (0.5f* = <strong className="font-mono text-sky-300">{kelly.halfKellyPct.toFixed(2)}%</strong>) captures ~75% growth with 50% less drawdown
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0D1015] p-1">
              {(
                [
                  { id: 'fixed_usdt', label: 'Fixed $' },
                  { id: 'fixed_risk_pct', label: 'Fixed %' },
                  { id: 'quarter_kelly', label: '1/4 Kelly' },
                  { id: 'half_kelly', label: '1/2 Kelly' },
                  { id: 'full_kelly', label: 'Full Kelly' },
                ] as Array<{ id: PositionSizingMode; label: string }>
              ).map((m) => {
                const active = (config.trading.positionSizingMode ?? 'fixed_usdt') === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => updateSizingMode(m.id)}
                    className={`rounded px-2 py-1 font-mono text-[10px] font-semibold transition ${
                      active
                        ? 'bg-[#7DF2AD] text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {kelly.negativeExpectancyWarning && (
            <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>
                Negative Kelly Warning (f* ≤ 0, EV &lt; 0): Automated Kelly entries are systematically blocked until expectancy recovers.
              </span>
            </div>
          )}

          {/* SVG Expected Logarithmic Growth Curve G(f) */}
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3">
            <svg
              viewBox={`0 0 ${growthSvg.w} ${growthSvg.h}`}
              className="h-32 w-full overflow-visible"
              aria-label="Expected logarithmic growth curve G(f)"
            >
              <line
                x1="28"
                y1={growthSvg.zeroY}
                x2={growthSvg.w - 20}
                y2={growthSvg.zeroY}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <path d={growthSvg.pathD} fill="none" stroke="#7DF2AD" strokeWidth="2.2" />
              {/* Quarter-Kelly Marker */}
              <circle cx={growthSvg.quarterPt.x} cy={growthSvg.quarterPt.y} r="4" fill="#38BDF8" />
              <text
                x={growthSvg.quarterPt.x}
                y={Math.max(12, growthSvg.quarterPt.y - 8)}
                textAnchor="middle"
                className="fill-sky-300 font-mono text-[9px]"
              >
                0.25f*
              </text>
              {/* Half-Kelly Marker */}
              <circle cx={growthSvg.halfPt.x} cy={growthSvg.halfPt.y} r="4.5" fill="#7DF2AD" />
              <text
                x={growthSvg.halfPt.x}
                y={Math.max(12, growthSvg.halfPt.y - 8)}
                textAnchor="middle"
                className="fill-[#7DF2AD] font-mono text-[9px] font-bold"
              >
                0.50f* (Half)
              </text>
              {/* Full Kelly Peak Marker */}
              <circle cx={growthSvg.fullPt.x} cy={growthSvg.fullPt.y} r="4.5" fill="#FBBF24" />
              <text
                x={growthSvg.fullPt.x}
                y={Math.max(12, growthSvg.fullPt.y - 8)}
                textAnchor="middle"
                className="fill-amber-300 font-mono text-[9px] font-bold"
              >
                f* (Peak)
              </text>
            </svg>
          </div>

          {/* Comparative Sizing Strategy Matrix (§5 Table) */}
          <div className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#0D1015]">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-3 py-2 font-medium">Sizing Tier</th>
                  <th className="px-3 py-2 text-right font-medium">Equity Risk %</th>
                  <th className="px-3 py-2 text-right font-medium">Dollar Risk</th>
                  <th className="px-3 py-2 text-right font-medium">Stop-Dist Notional</th>
                  <th className="px-3 py-2 text-right font-medium">100-Trade Ending Eq</th>
                  <th className="px-3 py-2 text-right font-medium">Est. Max DD</th>
                  <th className="px-3 py-2 text-right font-medium">Ruin Prob</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                {kelly.tiers.map((tier) => {
                  const isCurrent = (config.trading.positionSizingMode ?? 'fixed_usdt') === tier.id;
                  return (
                    <tr
                      key={tier.id}
                      className={isCurrent ? 'bg-[#7DF2AD]/10' : 'hover:bg-white/[0.02]'}
                    >
                      <td className="px-3 py-2 font-sans font-semibold text-slate-100">
                        {tier.label}
                      </td>
                      <td className="px-3 py-2 text-right text-[#7DF2AD]">
                        {tier.riskFractionPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right text-slate-200">
                        ${tier.capitalRiskPerTradeUsdt.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right text-sky-300">
                        ${tier.notionalPositionUsdt.toFixed(0)} ({tier.requiredLeverage.toFixed(1)}×)
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-400">
                        ${tier.projectedEndingEquity100TradesUsdt.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right text-amber-300">
                        ~{tier.estimatedMaxDrawdownPct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right text-rose-300">
                        {tier.probabilityOfRuinPct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* §5 Portfolio Covariance Kelly Matrix for Correlated Crypto Assets (f* = C^-1 * mu) */}
      <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Asset Portfolio Covariance Kelly Matrix (f* = C⁻¹ · μ)
            </h3>
          </div>
          <div className="font-mono text-xs text-slate-400">
            Avg Pairwise ρ:{' '}
            <strong className="text-amber-300">{portfolioCorr.avgPairwiseCorrelation.toFixed(2)}</strong> ·
            C⁻¹ Diversification Scale:{' '}
            <strong className="text-[#7DF2AD]">
              {(portfolioCorr.diversificationMultiplier * 100).toFixed(1)}%
            </strong>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-3 py-2 font-sans font-medium">Asset</th>
                {portfolioCorr.symbols.map((sym) => (
                  <th key={sym} className="px-3 py-2 text-right font-medium">
                    {sym.replace('USDT', '')}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-sans font-medium text-[#7DF2AD]">
                  Corr-Adjusted Half-Kelly
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {portfolioCorr.symbols.map((rowSym, rIdx) => (
                <tr key={rowSym} className="hover:bg-white/[0.02]">
                  <td className="px-3 py-2 font-sans font-semibold text-slate-100">{rowSym}</td>
                  {portfolioCorr.matrix[rIdx].map((val, cIdx) => (
                    <td
                      key={`${rowSym}-${cIdx}`}
                      className={`px-3 py-2 text-right ${
                        rIdx === cIdx
                          ? 'text-slate-500'
                          : val >= 0.7
                            ? 'text-amber-300'
                            : 'text-slate-300'
                      }`}
                    >
                      {val.toFixed(2)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold text-[#7DF2AD]">
                    {(portfolioCorr.adjustedHalfKellyBySymbol[rowSym] ?? 0).toFixed(2)}% Equity
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
