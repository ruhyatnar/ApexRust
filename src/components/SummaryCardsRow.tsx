import React, { useMemo, useState } from 'react';
import type { BotConfig, EngineSnapshot } from '../engine/types';

interface SummaryCardsRowProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
}

function fmtUsd(val: number): string {
  return Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const SummaryCardsRow: React.FC<SummaryCardsRowProps> = ({ snapshot, config }) => {
  const [tradesFilter, setTradesFilter] = useState<'Closed' | 'Open'>('Closed');
  const [windowRange, setWindowRange] = useState<'30D' | '24H'>('30D');

  const { risk, lockedBalanceUsdt, availableBalanceUsdt, pairs, recentTrades, pnlHistory } = snapshot;

  const btcPrice = pairs.find((p) => p.symbol === 'BTCUSDT')?.lastPrice ?? 93500;
  const btcEquiv = btcPrice > 0 ? risk.currentEquity / btcPrice : 0;

  const openCount = pairs.filter((p) => p.openPosition !== null).length;
  const closedWins = recentTrades.filter((t) => t.pnlUsdt >= 0).length;
  const closedLosses = recentTrades.filter((t) => t.pnlUsdt < 0).length;
  const openWins = pairs.filter((p) => p.openPosition && p.openPosition.unrealizedPnlUsdt >= 0).length;
  const openLosses = pairs.filter((p) => p.openPosition && p.openPosition.unrealizedPnlUsdt < 0).length;

  const displayWins = tradesFilter === 'Closed' ? closedWins : openWins;
  const displayLosses = tradesFilter === 'Closed' ? closedLosses : openLosses;
  const displayTotal = tradesFilter === 'Closed' ? recentTrades.length : openCount;
  const winRatio = displayTotal > 0 ? displayWins / displayTotal : 0;

  // SVG Donut ring geometry (r = 40 -> circumference = 251.33)
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const winStroke = circumference * winRatio;

  // Smooth SVG Sparkline for PnL Card
  const spark = useMemo(() => {
    const pts = pnlHistory.length >= 2 ? pnlHistory : [0, risk.cumulativeDailyPnlUsdt];
    const min = Math.min(...pts, 0);
    const max = Math.max(...pts, 1);
    const span = Math.max(max - min, 1);
    const w = 260;
    const h = 64;
    const coords = pts.map((v, idx) => {
      const x = (idx / Math.max(pts.length - 1, 1)) * w;
      const y = h - 8 - ((v - min) / span) * (h - 18);
      return { x, y };
    });
    const line = coords
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
    const area = `${line} L${w},${h} L0,${h} Z`;
    return { line, area, w, h };
  }, [pnlHistory, risk.cumulativeDailyPnlUsdt]);

  const pnlPositive = risk.cumulativeDailyPnlUsdt >= 0;

  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
      {/* 1. Balance Card */}
      <div className="flex flex-col justify-between rounded-xl border border-white/[0.06] bg-[#141820] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Balance</h2>
          <span
            className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${
              snapshot.accountMode === 'Live'
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-emerald-500/10 text-[#7DF2AD]'
            }`}
          >
            {snapshot.accountMode === 'Live'
              ? `Live · ${snapshot.transport.environment}`
              : 'Paper · Virtual'}
          </span>
        </div>

        <div className="my-3">
          <div className="text-xs text-slate-400">Total Balance</div>
          <div className="mt-1 font-mono text-2xl font-bold tracking-tight tabular-nums text-slate-50">
            ${fmtUsd(risk.currentEquity)}
          </div>
          <div className="mt-0.5 font-mono text-xs tabular-nums text-emerald-400">
            {btcEquiv.toFixed(6)} BTC
          </div>
        </div>

        <div className="space-y-1.5 border-t border-white/[0.06] pt-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-slate-400">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-[#6EE7B7]" aria-hidden="true" />
              Avl Bal
            </span>
            <span className="font-mono font-medium tabular-nums text-slate-100">
              ${fmtUsd(availableBalanceUsdt)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-slate-400">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-[#F87171]" aria-hidden="true" />
              Locked Bal
            </span>
            <span className="font-mono font-medium tabular-nums text-slate-100">
              ${fmtUsd(lockedBalanceUsdt)}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Trades Card with Mint Donut Ring */}
      <div className="flex flex-col justify-between rounded-xl border border-white/[0.06] bg-[#141820] p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Trades</h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTradesFilter((v) => (v === 'Closed' ? 'Open' : 'Closed'))}
              className="rounded-md border border-emerald-400/35 bg-[#0D1117] px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 transition hover:bg-emerald-950/40 whitespace-nowrap"
            >
              {tradesFilter}
            </button>
            <button
              type="button"
              onClick={() => setWindowRange((w) => (w === '30D' ? '24H' : '30D'))}
              className="rounded-md border border-white/[0.08] bg-[#0D1117] px-2 py-0.5 font-mono text-[11px] text-slate-300 transition hover:text-white whitespace-nowrap"
            >
              {windowRange}
            </button>
          </div>
        </div>

        <div className="my-2 flex items-center justify-between gap-2">
          <div className="min-w-[54px] text-center">
            <div className="font-mono text-xs font-semibold tabular-nums text-slate-200">
              {displayLosses} Loss
            </div>
            <div className="mx-auto mt-1.5 h-2.5 w-2.5 rounded-[2px] bg-[#F87171]" aria-hidden="true" />
          </div>

          <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
            <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90" aria-hidden="true">
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="#2D333F"
                strokeWidth="7"
              />
              {displayLosses > 0 && (
                <circle
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke="#F87171"
                  strokeWidth="7"
                />
              )}
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="#7DF2AD"
                strokeWidth="7"
                strokeDasharray={`${winStroke} ${circumference}`}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-slate-400">Total Trades</span>
              <span className="font-mono text-lg font-bold tabular-nums text-slate-50">
                {displayTotal}
              </span>
            </div>
          </div>

          <div className="min-w-[54px] text-center">
            <div className="font-mono text-xs font-semibold tabular-nums text-slate-200">
              {displayWins} Profit
            </div>
            <div className="mx-auto mt-1.5 h-2.5 w-2.5 rounded-[2px] bg-[#7DF2AD]" aria-hidden="true" />
          </div>
        </div>

        <div className="text-center font-mono text-[11px] tabular-nums text-slate-400">
          Streak: {risk.winStreak}W / {risk.loseStreak}L · Max {config.risk.maxLoseStreak}L Guard
        </div>
      </div>

      {/* 3. PnL Card with Mint Area Sparkline */}
      <div className="flex flex-col justify-between rounded-xl border border-white/[0.06] bg-[#141820] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">PnL</h2>
          <span
            className={`text-[11px] font-semibold ${
              risk.state === 'Active'
                ? 'text-emerald-400'
                : risk.state === 'Cooldown'
                  ? 'text-amber-400'
                  : 'text-rose-400'
            }`}
          >
            {risk.state === 'Active' ? 'CB Armed' : risk.state}
          </span>
        </div>

        <div className="mt-1 text-center">
          <div className="text-[11px] text-slate-400">Total PnL ({windowRange})</div>
          <div
            className={`mt-0.5 font-mono text-base font-bold tabular-nums ${
              pnlPositive ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {pnlPositive ? '+' : '-'}${fmtUsd(risk.cumulativeDailyPnlUsdt)} ({pnlPositive ? '+' : ''}
            {risk.cumulativeDailyPnlPct.toFixed(2)}%)
          </div>
        </div>

        <div className="my-1">
          <svg
            viewBox={`0 0 ${spark.w} ${spark.h}`}
            className="h-14 w-full overflow-visible"
            aria-label="Daily PnL trajectory sparkline"
          >
            <defs>
              <linearGradient id="pnl-mint-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={pnlPositive ? '#4ADE80' : '#F87171'} stopOpacity="0.28" />
                <stop offset="100%" stopColor={pnlPositive ? '#4ADE80' : '#F87171'} stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <path d={spark.area} fill="url(#pnl-mint-grad)" />
            <path
              d={spark.line}
              fill="none"
              stroke={pnlPositive ? '#4ADE80' : '#F87171'}
              strokeWidth="1.75"
            />
          </svg>
        </div>

        <div className="flex items-center justify-between border-t border-white/[0.06] pt-2 text-xs">
          <div>
            <div className="text-[11px] text-slate-400">Today&apos;s PnL</div>
            <div
              className={`font-mono font-semibold tabular-nums ${
                pnlPositive ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {pnlPositive ? '+' : '-'}${fmtUsd(risk.cumulativeDailyPnlUsdt)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-400">Daily DD Limit</div>
            <div className="font-mono font-semibold tabular-nums text-slate-200">
              -{config.risk.maxDailyDrawdownPct.toFixed(1)}% / +{config.risk.maxDailyProfitPct.toFixed(1)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
