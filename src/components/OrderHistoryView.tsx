import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Code2,
  Copy,
  Download,
  Filter,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  computeOrderPerformanceMetrics,
  filterOrderLogs,
  formatOrderLogsCsv,
  getOrderStatusBadgeMeta,
} from '../engine/orderHistoryAnalytics';
import type {
  ExchangeVenue,
  ExecutionAccountMode,
  OrderExecutionLog,
  OrderExecutionStatus,
} from '../engine/types';
import { DateRangePicker, type DateRangeValue } from './DateRangePicker';

interface OrderHistoryViewProps {
  accountMode: ExecutionAccountMode;
  activeSymbol: string;
  activeVenue: ExchangeVenue;
  symbols: string[];
  refreshKey?: number;
  onSelectPairAndTrade: (symbol: string) => void;
}

function fmtPx(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '0.00';
  const d = px >= 100 ? 2 : px >= 1 ? 4 : 6;
  return px.toFixed(d);
}

function fmtUsd(val: number): string {
  return Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusBadgeClassName(status: OrderExecutionStatus): string {
  const { tone } = getOrderStatusBadgeMeta(status);
  switch (tone) {
    case 'emerald':
      return 'border-emerald-500/35 bg-emerald-500/12 text-[#34D399]';
    case 'amber':
      return 'border-amber-400/35 bg-amber-400/12 text-[#FBBF24]';
    case 'slate':
      return 'border-slate-500/35 bg-slate-500/12 text-slate-300';
    case 'rose':
      return 'border-rose-500/40 bg-rose-500/15 text-[#FB7185]';
  }
}

export const OrderHistoryView: React.FC<OrderHistoryViewProps> = ({
  accountMode,
  activeSymbol,
  activeVenue,
  symbols,
  refreshKey = 0,
  onSelectPairAndTrade,
}) => {
  const [logs, setLogs] = useState<OrderExecutionLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncingBinance, setSyncingBinance] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [modeFilter, setModeFilter] = useState<'ALL' | ExecutionAccountMode>(accountMode);
  const [venueFilter, setVenueFilter] = useState<'ALL' | ExchangeVenue>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | OrderExecutionStatus>('ALL');
  const [symbolFilter, setSymbolFilter] = useState<string>('ALL');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ startDate: '', endDate: '' });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [csvExported, setCsvExported] = useState<boolean>(false);

  // Follow global account mode switch while allowing explicit ALL inspection
  const symbolFilterRef = useRef(symbolFilter);
  symbolFilterRef.current = symbolFilter;
  const venueFilterRef = useRef(venueFilter);
  venueFilterRef.current = venueFilter;
  const hasLogsRef = useRef(false);
  hasLogsRef.current = logs.length > 0;

  useEffect(() => {
    setModeFilter(accountMode);
  }, [accountMode]);

  const fetchOrderHistory = useCallback(
    async (opts?: { syncBinance?: boolean }) => {
      const isSync = Boolean(opts?.syncBinance);
      if (isSync) {
        setSyncingBinance(true);
      } else if (!hasLogsRef.current) {
        setLoading(true);
      }
      setErrorMessage(null);

      try {
        const params = new URLSearchParams();
        if (isSync) {
          params.set('syncBinance', '1');
          const curSym = symbolFilterRef.current;
          const curVenue = venueFilterRef.current;
          if (curSym !== 'ALL') {
            params.set('symbol', curSym);
          } else if (symbols.length > 0) {
            params.set('symbols', symbols.join(','));
          } else {
            params.set('symbol', activeSymbol);
          }
          params.set('venue', curVenue !== 'ALL' ? curVenue : activeVenue);
        }
        const queryStr = params.toString();
        const url = queryStr ? `/api/orders/history?${queryStr}` : '/api/orders/history';
        const resp = await fetch(url);
        const data = (await resp.json()) as {
          ok?: boolean;
          error?: string;
          logs?: OrderExecutionLog[];
          syncResult?: {
            synced: boolean;
            count?: number;
            latencyMs?: number;
            endpoint?: string;
            error?: string;
          };
        };

        if (!resp.ok || !data.ok) {
          throw new Error(data.error ?? `Backend returned HTTP ${resp.status}`);
        }

        const fetchedLogs = Array.isArray(data.logs) ? data.logs : [];
        setLogs(fetchedLogs);

        if (isSync && data.syncResult) {
          if (data.syncResult.synced) {
            setSyncNotice({
              ok: true,
              text: `Synced ${data.syncResult.count ?? 0} historical order(s) via Binance ${data.syncResult.endpoint ?? ''} (${data.syncResult.latencyMs ?? 0}ms).`,
            });
          } else {
            setSyncNotice({
              ok: false,
              text:
                data.syncResult.error ??
                'Live Binance credentials are not configured in Bot -> Live Credentials.',
            });
          }
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to retrieve order execution logs from backend API.'
        );
      } finally {
        setLoading(false);
        setSyncingBinance(false);
      }
    },
    [activeSymbol, activeVenue, symbols]
  );

  useEffect(() => {
    void fetchOrderHistory();
  }, [refreshKey, fetchOrderHistory]);

  const accountModeLogs = useMemo(
    () =>
      filterOrderLogs(logs, {
        accountMode: modeFilter,
        venue: 'ALL',
        status: 'ALL',
        symbol: 'ALL',
        query: '',
      }),
    [logs, modeFilter]
  );

  const accountSummary = useMemo(
    () => computeOrderPerformanceMetrics(accountModeLogs),
    [accountModeLogs]
  );

  const filteredLogs = useMemo(
    () =>
      filterOrderLogs(logs, {
        accountMode: modeFilter,
        venue: venueFilter,
        status: statusFilter,
        symbol: symbolFilter,
        query: searchQuery,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      }),
    [logs, modeFilter, venueFilter, statusFilter, symbolFilter, searchQuery, dateRange.startDate, dateRange.endDate]
  );

  const metrics = useMemo(() => computeOrderPerformanceMetrics(filteredLogs), [filteredLogs]);

  const equitySvg = useMemo(() => {
    const pts = metrics.equityCurve;
    if (pts.length === 0) return null;

    const width = 760;
    const height = 160;
    const padX = 12;
    const padY = 18;
    const values = [0, ...pts.map((p) => p.cumulativePnlUsdt)];
    const minVal = Math.min(...values, 0);
    const maxVal = Math.max(...values, 0);
    const span = Math.max(maxVal - minVal, 10);

    const toY = (v: number) =>
      height - padY - ((v - minVal) / span) * (height - padY * 2);
    const toX = (idx: number) =>
      padX + (idx / Math.max(values.length - 1, 1)) * (width - padX * 2);

    const coords = values.map((v, idx) => ({ x: toX(idx), y: toY(v), v }));
    const pathD = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ');
    const zeroY = toY(0);
    const areaD = `${pathD} L${coords[coords.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;

    const maxBarAbs = Math.max(...pts.map((p) => Math.abs(p.pnlUsdt)), 1);
    return { width, height, zeroY, pathD, areaD, coords, pts, maxBarAbs, toX };
  }, [metrics.equityCurve]);

  const handleExportCsv = () => {
    if (filteredLogs.length === 0) return;
    const csv = formatOrderLogsCsv(filteredLogs);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apexrust-order-history-${modeFilter.toLowerCase()}-${dateStamp}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCsvExported(true);
    window.setTimeout(() => setCsvExported(false), 1800);
  };

  const handleCopyPayload = (log: OrderExecutionLog) => {
    void navigator.clipboard?.writeText(JSON.stringify(log, null, 2));
    setCopiedId(log.id);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const pnlPositive = metrics.netRealizedPnlUsdt >= 0;
  const accountPnlPositive = accountSummary.netRealizedPnlUsdt >= 0;
  const accountWlRatioDisplay = Number.isFinite(accountSummary.winLossRatio)
    ? accountSummary.winLossRatio.toFixed(2)
    : accountSummary.winCount > 0
      ? '∞'
      : '0.00';
  const accountModeLabel =
    modeFilter === 'ALL'
      ? 'All Accounts (Paper + Live)'
      : modeFilter === 'Live'
        ? 'Live Account'
        : 'Paper Sandbox';
  const pfDisplay = Number.isFinite(metrics.profitFactor)
    ? metrics.profitFactor.toFixed(2)
    : metrics.grossProfitUsdt > 0
      ? '∞'
      : '0.00';

  return (
    <div className="space-y-5">
      {/* Summary Header: Title, Account Mode Rollup & Actions */}
      <header className="rounded-xl border border-white/[0.06] bg-[#141820] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-slate-50">
              Order Execution History & Performance
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>Backend Ledger (/api/orders/history)</span>
              <span aria-hidden="true">·</span>
              <span>Binance Spot & USD-M Futures Audit</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-slate-300">
                {filteredLogs.length} / {logs.length} Records
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void fetchOrderHistory({ syncBinance: true })}
              disabled={syncingBinance}
              className="flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-[#0E121A] px-3.5 py-2 text-xs font-semibold text-amber-300 transition hover:border-amber-400/60 hover:bg-amber-950/25 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncingBinance ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{syncingBinance ? 'Syncing Binance…' : 'Sync Binance allOrders'}</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchOrderHistory()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0E121A] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-[#1A202C] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Refresh</span>
            </button>

            <button
              type="button"
              onClick={handleExportCsv}
              disabled={filteredLogs.length === 0}
              aria-label="Export to CSV"
              title={
                filteredLogs.length === 0
                  ? 'No matching order logs to export'
                  : `Download ${filteredLogs.length} filtered order log(s) as CSV`
              }
              className="flex items-center gap-1.5 rounded-lg bg-[#7DF2AD] px-4 py-2 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD] disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {csvExported ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Export to CSV</span>
            </button>
          </div>
        </div>

        {/* Selected Account Mode Executive Summary Strip */}
        <section
          aria-label="Selected account mode execution summary"
          className="mt-4 grid grid-cols-1 gap-4 border-t border-white/[0.06] pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Selected Account Mode
            </div>
            <div
              className={`mt-1 text-base font-bold tracking-tight ${
                modeFilter === 'Live'
                  ? 'text-amber-300'
                  : modeFilter === 'Paper'
                    ? 'text-[#7DF2AD]'
                    : 'text-slate-100'
              }`}
            >
              {accountModeLabel}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              Unfiltered account-level totals
            </div>
          </div>

          <div className="sm:border-l sm:border-white/[0.06] sm:pl-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Total Realized PnL
            </div>
            <div
              className={`mt-1 font-mono text-lg font-bold tracking-tight tabular-nums ${
                accountPnlPositive ? 'text-[#7DF2AD]' : 'text-[#F87171]'
              }`}
            >
              {accountPnlPositive ? '+' : '-'}${fmtUsd(accountSummary.netRealizedPnlUsdt)}
            </div>
            <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-400">
              Gross +${fmtUsd(accountSummary.grossProfitUsdt)} · Loss -${fmtUsd(accountSummary.grossLossUsdt)}
            </div>
          </div>

          <div className="lg:border-l lg:border-white/[0.06] lg:pl-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Win / Loss Ratio
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight tabular-nums text-slate-50">
              {accountWlRatioDisplay}
              <span className="ml-1.5 text-xs font-medium text-slate-400">
                ({accountSummary.winRatePct.toFixed(1)}% WR)
              </span>
            </div>
            <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-400">
              {accountSummary.winCount}W / {accountSummary.lossCount}L across {accountSummary.exitCount} exits
            </div>
          </div>

          <div className="sm:border-l sm:border-white/[0.06] sm:pl-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Total Trades Executed
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight tabular-nums text-slate-50">
              {accountSummary.filledOrders}
            </div>
            <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-400">
              {accountSummary.exitCount} closed exits · {accountSummary.totalOrders} total orders
            </div>
          </div>
        </section>
      </header>

      {/* Sync / API Error Notice */}
      {errorMessage && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-950/20 px-4 py-3 text-xs text-rose-200"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchOrderHistory()}
            className="rounded-md border border-rose-400/40 px-3 py-1 font-medium text-rose-100 hover:bg-rose-500/20 whitespace-nowrap shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {syncNotice && (
        <div
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-xs ${
            syncNotice.ok
              ? 'border-emerald-500/35 bg-emerald-950/20 text-emerald-200'
              : 'border-amber-500/35 bg-amber-950/20 text-amber-200'
          }`}
        >
          <span>{syncNotice.text}</span>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="text-xs text-slate-400 hover:text-slate-100 whitespace-nowrap shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 4-Card Performance KPI Strip */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs font-medium text-slate-400">Net Realized PnL</div>
          <div
            className={`mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums ${
              pnlPositive ? 'text-[#7DF2AD]' : 'text-[#F87171]'
            }`}
          >
            {pnlPositive ? '+' : '-'}${fmtUsd(metrics.netRealizedPnlUsdt)}
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
            <span>Profit Factor {pfDisplay}</span>
            <span aria-hidden="true">·</span>
            <span>Peak +${fmtUsd(metrics.peakPnlUsdt)}</span>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs font-medium text-slate-400">Exit Win Rate & Expectancy</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums text-slate-50">
            {metrics.winRatePct.toFixed(1)}%
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
            <span>
              {metrics.winCount}W / {metrics.lossCount}L ({metrics.exitCount} exits)
            </span>
            <span aria-hidden="true">·</span>
            <span className={metrics.avgRMultiple >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {metrics.avgRMultiple >= 0 ? '+' : ''}
              {metrics.avgRMultiple.toFixed(2)}R avg
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs font-medium text-slate-400">Executed Notional & Fees</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums text-slate-50">
            ${fmtUsd(metrics.totalVolumeUsdt)}
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
            <span>Fees ${metrics.totalCommissionUsdt.toFixed(4)}</span>
            <span aria-hidden="true">·</span>
            <span>{metrics.makerRatioPct.toFixed(0)}% Maker</span>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs font-medium text-slate-400">Execution Quality & Latency</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums text-slate-50">
            {metrics.avgLatencyMs !== null ? `${Math.round(metrics.avgLatencyMs)} ms` : '—'}
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
            <span>
              p95 {metrics.p95LatencyMs !== null ? `${Math.round(metrics.p95LatencyMs)} ms` : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {metrics.fillRatePct.toFixed(0)}% Fill ({metrics.filledOrders}/{metrics.totalOrders})
            </span>
          </div>
        </div>
      </div>

      {/* Cumulative Realized Performance Chart */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/[0.06]">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Cumulative Realized PnL Trajectory
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>Chronological exit fills</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Avg/Exit {metrics.avgPnlPerExitUsdt >= 0 ? '+' : '-'}${fmtUsd(metrics.avgPnlPerExitUsdt)}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-rose-300">
                Max Drawdown -${fmtUsd(metrics.maxDrawdownUsdt)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4 font-mono text-xs tabular-nums text-slate-400">
            <span>Gross +${fmtUsd(metrics.grossProfitUsdt)}</span>
            <span>Loss -${fmtUsd(metrics.grossLossUsdt)}</span>
          </div>
        </div>

        {equitySvg ? (
          <div className="mt-3">
            <svg
              viewBox={`0 0 ${equitySvg.width} ${equitySvg.height}`}
              className="h-44 w-full overflow-visible"
              role="img"
              aria-label="Cumulative realized PnL performance curve"
            >
              <defs>
                <linearGradient id="order-history-pnl-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={pnlPositive ? '#7DF2AD' : '#F87171'}
                    stopOpacity="0.28"
                  />
                  <stop
                    offset="100%"
                    stopColor={pnlPositive ? '#7DF2AD' : '#F87171'}
                    stopOpacity="0.0"
                  />
                </linearGradient>
              </defs>
              {/* Zero reference hairline */}
              <line
                x1={0}
                y1={equitySvg.zeroY}
                x2={equitySvg.width}
                y2={equitySvg.zeroY}
                stroke="rgba(148, 163, 184, 0.2)"
                strokeDasharray="4 4"
              />
              {/* Per-exit subtle PnL impulse bars */}
              {equitySvg.pts.map((pt, i) => {
                const barX = equitySvg.toX(i + 1) - 4;
                const barH = Math.max(4, (Math.abs(pt.pnlUsdt) / equitySvg.maxBarAbs) * 28);
                const barY = pt.pnlUsdt >= 0 ? equitySvg.zeroY - barH : equitySvg.zeroY;
                return (
                  <rect
                    key={pt.id}
                    x={barX}
                    y={barY}
                    width={8}
                    height={barH}
                    rx={1.5}
                    fill={pt.pnlUsdt >= 0 ? 'rgba(125, 242, 173, 0.25)' : 'rgba(248, 113, 113, 0.28)'}
                  />
                );
              })}
              <path d={equitySvg.areaD} fill="url(#order-history-pnl-grad)" />
              <path
                d={equitySvg.pathD}
                fill="none"
                stroke={pnlPositive ? '#7DF2AD' : '#F87171'}
                strokeWidth="2.2"
              />
              {equitySvg.coords.slice(1).map((c, idx) => (
                <circle
                  key={equitySvg.pts[idx]?.id ?? idx}
                  cx={c.x}
                  cy={c.y}
                  r="3.2"
                  fill={c.v >= 0 ? '#7DF2AD' : '#F87171'}
                  stroke="#141820"
                  strokeWidth="1.5"
                />
              ))}
            </svg>
          </div>
        ) : (
          <div className="py-10 text-center text-xs text-slate-400">
            No closed exit executions in the current filter scope yet. Cumulative PnL curve appears once an exit order fills.
          </div>
        )}
      </div>

      {/* Filter Bar + Execution Table */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820]">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-white/[0.06] bg-[#10141B] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Account Mode Filter */}
            <div
              className="flex items-center rounded-lg border border-white/[0.08] bg-[#0B0F17] p-0.5"
              role="group"
              aria-label="Filter order logs by account mode"
            >
              {(['ALL', 'Paper', 'Live'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModeFilter(m)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition whitespace-nowrap shrink-0 ${
                    modeFilter === m
                      ? m === 'Live'
                        ? 'bg-amber-400 text-[#0B0F17] font-semibold'
                        : 'bg-[#7DF2AD] text-[#0B0F17] font-semibold'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {m === 'ALL' ? 'All Accounts' : m}
                </button>
              ))}
            </div>

            {/* Order Status Filter */}
            <div
              className="flex items-center rounded-lg border border-white/[0.08] bg-[#0B0F17] p-0.5"
              role="group"
              aria-label="Filter order logs by execution status"
            >
              {(['ALL', 'FILLED', 'PARTIALLY_FILLED', 'NEW', 'CANCELED', 'EXPIRED', 'REJECTED'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-md px-2.5 py-1 text-xs font-mono transition whitespace-nowrap shrink-0 ${
                    statusFilter === st
                      ? 'bg-[#1C222D] text-slate-100 font-semibold'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {st === 'ALL' ? 'All Status' : st}
                </button>
              ))}
            </div>

            {/* Venue Filter */}
            <select
              aria-label="Filter order logs by venue"
              value={venueFilter}
              onChange={(e) => setVenueFilter(e.target.value as 'ALL' | ExchangeVenue)}
              className="rounded-lg border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-[#7DF2AD]"
            >
              <option value="ALL">All Venues</option>
              <option value="Spot">Spot</option>
              <option value="Futures">USD-M Futures</option>
            </select>

            {/* Symbol Filter */}
            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1.5">
              <Filter className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <select
                aria-label="Filter order logs by symbol"
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                className="bg-transparent text-xs font-mono text-slate-200 focus:outline-none"
              >
                <option value="ALL" className="bg-[#0B0F17]">
                  All Pairs ({symbols.length})
                </option>
                {symbols.map((sym) => (
                  <option key={sym} value={sym} className="bg-[#0B0F17]">
                    {sym}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker value={dateRange} onChange={setDateRange} />

            <div className="relative min-w-[220px] flex-1 sm:w-[230px] sm:flex-none">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                type="text"
                role="searchbox"
                inputMode="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Symbol or order ID…"
                aria-label="Filter execution records by symbol or order ID"
                className="w-full rounded-lg border border-white/[0.08] bg-[#0B0F17] pl-8 pr-8 py-1.5 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#7DF2AD]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-white/[0.08] hover:text-slate-100"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Loading Skeleton vs Empty State vs Data Table */}
        {loading ? (
          <div className="divide-y divide-white/[0.05] p-4" aria-busy="true" aria-label="Loading order execution logs">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-center justify-between py-3 animate-pulse">
                <div className="h-4 w-36 rounded bg-white/[0.06]" />
                <div className="h-4 w-24 rounded bg-white/[0.06]" />
                <div className="h-4 w-28 rounded bg-white/[0.06]" />
                <div className="h-4 w-20 rounded bg-white/[0.06]" />
                <div className="h-4 w-24 rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-semibold text-slate-200">
              No order execution logs match the active filters.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Submit an order in the Trade Desk, switch Account Mode filter to All Accounts, or sync historical Binance orders.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              {(searchQuery ||
                dateRange.startDate ||
                dateRange.endDate ||
                venueFilter !== 'ALL' ||
                statusFilter !== 'ALL' ||
                symbolFilter !== 'ALL') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setDateRange({ startDate: '', endDate: '' });
                    setVenueFilter('ALL');
                    setStatusFilter('ALL');
                    setSymbolFilter('ALL');
                  }}
                  className="rounded-lg border border-white/[0.1] bg-[#10141B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#1C222D]"
                >
                  Clear Search & Filters
                </button>
              )}
              {modeFilter !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setModeFilter('ALL')}
                  className="rounded-lg border border-white/[0.1] bg-[#10141B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#1C222D]"
                >
                  Show All Accounts
                </button>
              )}
              <button
                type="button"
                onClick={() => onSelectPairAndTrade(activeSymbol)}
                className="rounded-lg bg-[#7DF2AD] px-4 py-2 text-xs font-bold text-[#0B0F17] hover:bg-[#95F7BD]"
              >
                Open Trade Desk
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-b-xl">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-white/[0.06] bg-[#0E121A] text-[11px] font-mono text-slate-400">
                  <th className="px-3.5 py-2.5 font-medium">Time / Order ID</th>
                  <th className="px-3.5 py-2.5 font-medium">Pair / Account</th>
                  <th className="px-3.5 py-2.5 font-medium">Side / Type</th>
                  <th className="px-3.5 py-2.5 font-medium">Status</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Price / Qty</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Quote / Fee</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Latency</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Realized PnL</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-xs font-mono tabular-nums">
                {filteredLogs.map((log) => {
                  const isSelected = log.id === inspectedId;
                  const dt = new Date(log.timestampMs);
                  const hasPnl = log.realizedPnlUsdt !== null;
                  const rowPnlPos = (log.realizedPnlUsdt ?? 0) >= 0;

                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        className={`transition-colors ${
                          isSelected ? 'bg-[#19202D]' : 'hover:bg-white/[0.025]'
                        }`}
                      >
                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <div className="text-slate-100">
                            {dt.toISOString().slice(11, 19)} UTC · {dt.toISOString().slice(5, 10)}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            #{log.orderId}
                            {log.orderListId && log.orderListId > 0 ? ` · oco:#${log.orderListId}` : ''}
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectPairAndTrade(log.symbol)}
                            className="font-sans font-semibold text-slate-100 hover:text-[#7DF2AD] transition-colors"
                          >
                            {log.symbol}
                          </button>
                          <div className="font-sans text-[11px] text-slate-400">
                            {log.venue} · {log.environment} ·{' '}
                            <span className={log.accountMode === 'Live' ? 'text-amber-300' : 'text-emerald-300'}>
                              {log.accountMode}
                            </span>
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center gap-0.5 font-semibold ${
                                log.binanceSide === 'BUY' ? 'text-[#10B981]' : 'text-[#F43F5E]'
                              }`}
                            >
                              {log.binanceSide === 'BUY' ? (
                                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              {log.binanceSide}
                            </span>
                            <span className="text-slate-500">·</span>
                            <span className="text-slate-200">{log.orderType}</span>
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {log.lifecycle} · {log.timeInForce}
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          {(() => {
                            const badge = getOrderStatusBadgeMeta(log.status);
                            return (
                              <span
                                title={log.status}
                                className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-mono font-semibold tracking-wide ${statusBadgeClassName(log.status)}`}
                              >
                                {badge.label}
                              </span>
                            );
                          })()}
                          <div className="mt-1 font-sans text-[11px] text-slate-400">
                            {log.isMaker ? 'Maker' : 'Taker'} · {log.source}
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <div className="font-semibold text-slate-100">
                            {log.price > 0 ? `$${fmtPx(log.price)}` : 'Market'}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {log.executedQty.toFixed(4)} / {log.origQty.toFixed(4)}
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <div className="text-slate-100">${fmtUsd(log.quoteQty)}</div>
                          <div className="text-[11px] text-slate-400">
                            Fee ${log.commission.toFixed(4)} {log.commissionAsset}
                          </div>
                        </td>

                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap text-slate-300">
                          {log.latencyMs !== null ? `${Math.round(log.latencyMs)} ms` : '—'}
                        </td>

                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          {hasPnl ? (
                            <>
                              <div
                                className={`font-semibold ${
                                  rowPnlPos ? 'text-[#7DF2AD]' : 'text-[#F87171]'
                                }`}
                              >
                                {rowPnlPos ? '+' : '-'}${fmtUsd(log.realizedPnlUsdt!)}
                                {log.rMultiple !== null ? (
                                  <span className="ml-1 text-[11px] opacity-85">
                                    ({log.rMultiple >= 0 ? '+' : ''}
                                    {log.rMultiple.toFixed(2)}R)
                                  </span>
                                ) : null}
                              </div>
                              <div className="font-sans text-[11px] text-slate-400">
                                {log.exitReason ?? 'Exit'}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-slate-500">—</div>
                              <div className="font-sans text-[11px] text-slate-400">
                                {log.errorMessage ? 'Rejected' : log.lifecycle}
                              </div>
                            </>
                          )}
                        </td>

                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setInspectedId(isSelected ? null : log.id)}
                            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-mono transition-colors ${
                              isSelected
                                ? 'border-[#7DF2AD]/50 bg-[#7DF2AD]/15 text-[#7DF2AD]'
                                : 'border-white/[0.08] bg-[#0B0F17] text-slate-300 hover:text-white'
                            }`}
                          >
                            <Code2 className="h-3 w-3" aria-hidden="true" />
                            <span>{isSelected ? 'Hide' : 'Inspect'}</span>
                          </button>
                        </td>
                      </tr>

                      {isSelected && (
                        <tr className="bg-[#0B0F17]">
                          <td colSpan={9} className="px-4 py-3.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 font-sans">
                              <div className="text-xs text-slate-300">
                                <span className="font-mono font-semibold text-slate-100">
                                  {log.endpoint}
                                </span>
                                <span className="mx-2 text-slate-500" aria-hidden="true">·</span>
                                <span>{log.rationale}</span>
                                {log.errorMessage ? (
                                  <>
                                    <span className="mx-2 text-slate-500" aria-hidden="true">·</span>
                                    <span className="text-rose-400">{log.errorMessage}</span>
                                  </>
                                ) : null}
                              </div>

                              <button
                                type="button"
                                onClick={() => handleCopyPayload(log)}
                                className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#141820] px-2.5 py-1 text-xs font-mono text-slate-300 hover:text-white"
                              >
                                {copiedId === log.id ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                    <span>Copy JSON</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#07090D] p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                              {JSON.stringify(log, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
