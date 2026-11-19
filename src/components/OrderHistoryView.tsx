import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Clock,
  Code2,
  Copy,
  Database,
  Download,
  Filter,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  computeOrderPerformanceMetrics,
  filterOrderLogs,
  formatOrderLogsCsv,
  getOrderStatusBadgeMeta,
} from '../engine/orderHistoryAnalytics';
import { apiFetch } from '../engine/apiClient';
import { fmtPx as formatPx, fmtUsdMagnitude } from '../engine/formatters';
import type {
  ExchangeVenue,
  ExecutionAccountMode,
  OrderAutoPollInterval,
  OrderDatabaseSummary,
  OrderExecutionLog,
  OrderExecutionStatus,
  OrphanPairRecord,
  OrphanResolutionAction,
  SyncLookbackPreset,
} from '../engine/types';
import { DateRangePicker, type DateRangeValue } from './DateRangePicker';

interface OrderHistoryViewProps {
  accountMode: ExecutionAccountMode;
  activeSymbol: string;
  activeVenue: ExchangeVenue;
  symbols: string[];
  refreshKey?: number;
  serverTargetLabel?: string;
  onSelectPairAndTrade: (symbol: string) => void;
  onAdoptOrphanPair?: (symbol: string) => void;
}

function fmtPx(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '0.00';
  return formatPx(px);
}

const fmtUsd = fmtUsdMagnitude;

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
  serverTargetLabel = '🖥️ This Computer',
  onSelectPairAndTrade,
  onAdoptOrphanPair,
}) => {
  const [logs, setLogs] = useState<OrderExecutionLog[]>([]);
  const [dbSummary, setDbSummary] = useState<OrderDatabaseSummary | null>(null);
  const [orphans, setOrphans] = useState<OrphanPairRecord[]>([]);
  const [scanningOrphans, setScanningOrphans] = useState<boolean>(false);
  const [resolvingOrphanKey, setResolvingOrphanKey] = useState<string | null>(null);
  const [showOrphanPanel, setShowOrphanPanel] = useState<boolean>(false);
  const [showDbAdmin, setShowDbAdmin] = useState<boolean>(false);
  const [syncLookback, setSyncLookback] = useState<SyncLookbackPreset>('7d');
  const [includeOrphansOnSync, setIncludeOrphansOnSync] = useState<boolean>(true);
  const [autoPollInterval, setAutoPollInterval] = useState<OrderAutoPollInterval>('off');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  const copyTimerRef = useRef<number | null>(null);
  const exportTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    };
  }, []);

  // Follow global account mode switch while allowing explicit ALL inspection
  const symbolFilterRef = useRef(symbolFilter);
  symbolFilterRef.current = symbolFilter;
  const venueFilterRef = useRef(venueFilter);
  venueFilterRef.current = venueFilter;
  const syncLookbackRef = useRef(syncLookback);
  syncLookbackRef.current = syncLookback;
  const includeOrphansRef = useRef(includeOrphansOnSync);
  includeOrphansRef.current = includeOrphansOnSync;
  const hasLogsRef = useRef(false);
  hasLogsRef.current = logs.length > 0;

  useEffect(() => {
    setModeFilter(accountMode);
  }, [accountMode]);

  const fetchOrphanPairs = useCallback(async () => {
    setScanningOrphans(true);
    try {
      const curVenue = venueFilterRef.current !== 'ALL' ? venueFilterRef.current : activeVenue;
      const params = new URLSearchParams({
        venue: curVenue,
        configuredPairs: symbols.join(','),
      });
      const resp = await apiFetch(`/api/orders/orphans?${params.toString()}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        ok?: boolean;
        orphans?: OrphanPairRecord[];
        dbSummary?: OrderDatabaseSummary;
      };
      if (data.ok && Array.isArray(data.orphans)) {
        setOrphans(data.orphans);
      }
      if (data.dbSummary) {
        setDbSummary(data.dbSummary);
      }
    } catch {
      // Ignore offline orphan scan failure
    } finally {
      setScanningOrphans(false);
    }
  }, [activeVenue, symbols]);

  const fetchOrderHistory = useCallback(
    async (opts?: { syncBinance?: boolean; lookbackOverride?: SyncLookbackPreset }) => {
      const isSync = Boolean(opts?.syncBinance);
      const effectiveLookback = opts?.lookbackOverride ?? syncLookbackRef.current;
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
          params.set('lookback', effectiveLookback);
          if (includeOrphansRef.current) {
            params.set('includeOrphans', '1');
          }
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
        const resp = await apiFetch(url);
        const data = (await resp.json()) as {
          ok?: boolean;
          error?: string;
          logs?: OrderExecutionLog[];
          dbSummary?: OrderDatabaseSummary;
          syncResult?: {
            synced: boolean;
            count?: number;
            lookback?: SyncLookbackPreset;
            symbolsSynced?: string[];
            orphanCount?: number;
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
        if (data.dbSummary) {
          setDbSummary(data.dbSummary);
        }

        if (isSync && data.syncResult) {
          if (data.syncResult.synced) {
            const symCount = data.syncResult.symbolsSynced?.length ?? 1;
            const orphSuffix =
              (data.syncResult.orphanCount ?? 0) > 0
                ? ` · ${data.syncResult.orphanCount} orphan pair(s) included`
                : '';
            setSyncNotice({
              ok: true,
              text: `Synced ${data.syncResult.count ?? 0} order(s) across ${symCount} pair(s) (${(data.syncResult.lookback ?? effectiveLookback).toUpperCase()}) via ${data.syncResult.endpoint ?? ''} (${data.syncResult.latencyMs ?? 0}ms)${orphSuffix}.`,
            });
            void fetchOrphanPairs();
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
    [activeSymbol, activeVenue, symbols, fetchOrphanPairs]
  );

  useEffect(() => {
    void fetchOrderHistory();
    void fetchOrphanPairs();
  }, [refreshKey, fetchOrderHistory, fetchOrphanPairs]);

  // Optional background auto-polling for Binance order history
  useEffect(() => {
    if (autoPollInterval === 'off') return;
    const intervalMs =
      autoPollInterval === '1m'
        ? 60_000
        : autoPollInterval === '5m'
          ? 300_000
          : 900_000;
    const timer = window.setInterval(() => {
      void fetchOrderHistory({ syncBinance: true });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoPollInterval, fetchOrderHistory]);

  const handleResolveOrphan = async (
    symbol: string,
    venue: ExchangeVenue,
    action: OrphanResolutionAction
  ) => {
    const key = `${symbol}:${action}`;
    setResolvingOrphanKey(key);
    try {
      if (action === 'adopt_pair') {
        onAdoptOrphanPair?.(symbol);
      }
      const resp = await apiFetch('/api/orders/orphans/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          venue,
          action,
          lookback: syncLookback,
        }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        dbSummary?: OrderDatabaseSummary;
      };
      if (data.dbSummary) setDbSummary(data.dbSummary);
      setSyncNotice({
        ok: Boolean(resp.ok && data.ok),
        text: data.message ?? data.error ?? `${action} completed for ${symbol}`,
      });
      await fetchOrderHistory();
      await fetchOrphanPairs();
    } catch (err) {
      setSyncNotice({
        ok: false,
        text: err instanceof Error ? err.message : `Failed to run ${action} on ${symbol}`,
      });
    } finally {
      setResolvingOrphanKey(null);
    }
  };

  const handlePruneOrClearDb = async (opts: {
    accountMode?: 'Paper' | 'Live' | 'ALL';
    olderThanDays?: number;
  }) => {
    try {
      const params = new URLSearchParams();
      if (opts.accountMode) params.set('accountMode', opts.accountMode);
      if (opts.accountMode === 'ALL') params.set('confirmAll', 'true');
      if (opts.olderThanDays) params.set('olderThanDays', String(opts.olderThanDays));
      const resp = await apiFetch(`/api/orders/history?${params.toString()}`, {
        method: 'DELETE',
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        deleted?: number;
        remaining?: number;
        dbSummary?: OrderDatabaseSummary;
      };
      if (data.dbSummary) setDbSummary(data.dbSummary);
      setSyncNotice({
        ok: true,
        text: `Database maintenance complete: removed ${data.deleted ?? 0} record(s), ${data.remaining ?? 0} remaining.`,
      });
      await fetchOrderHistory();
      await fetchOrphanPairs();
    } catch {
      setSyncNotice({ ok: false, text: 'Database maintenance request failed.' });
    }
  };

  const handleExportJsonDb = () => {
    const payload = {
      version: 2,
      exportedAtIso: new Date().toISOString(),
      dbSummary,
      logs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apexrust-order-db-${dateStamp}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportJsonFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { logs?: OrderExecutionLog[] } | OrderExecutionLog[];
      const importLogs = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.logs)
          ? parsed.logs
          : [];
      if (importLogs.length === 0) {
        setSyncNotice({ ok: false, text: 'Selected JSON file contains no valid order logs.' });
        return;
      }
      const resp = await apiFetch('/api/orders/history/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: importLogs }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        added?: number;
        updated?: number;
        total?: number;
        error?: string;
        dbSummary?: OrderDatabaseSummary;
      };
      if (!resp.ok || !data.ok) {
        setSyncNotice({ ok: false, text: data.error ?? 'Failed to import JSON database.' });
        return;
      }
      if (data.dbSummary) setDbSummary(data.dbSummary);
      setSyncNotice({
        ok: true,
        text: `Imported JSON backup: +${data.added ?? 0} new, ${data.updated ?? 0} updated (${data.total ?? 0} total).`,
      });
      await fetchOrderHistory();
    } catch (err) {
      setSyncNotice({
        ok: false,
        text: err instanceof Error ? err.message : 'Invalid JSON backup file.',
      });
    }
  };

  const allAvailableSymbols = useMemo(
    () => Array.from(new Set([...symbols, ...(dbSummary?.distinctSymbols ?? [])])).sort(),
    [symbols, dbSummary]
  );

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
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    exportTimerRef.current = window.setTimeout(() => setCsvExported(false), 1800);
  };

  const handleCopyPayload = (log: OrderExecutionLog) => {
    void navigator.clipboard?.writeText(JSON.stringify(log, null, 2));
    setCopiedId(log.id);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 1800);
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
              <span className="rounded border border-cyan-400/30 bg-cyan-950/30 px-2 py-0.5 font-semibold text-cyan-200">
                📂 Database Location: {serverTargetLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Database ({dbSummary?.engine === 'sqlite_wal' ? 'SQLite WAL' : 'JSONL Store'})
              </span>
              <span aria-hidden="true">·</span>
              <span>Binance Spot & USD-M Futures Audit</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-slate-300">
                {filteredLogs.length} / {logs.length} Records
              </span>
              {dbSummary && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-amber-300">
                    Live {dbSummary.liveCount}/{dbSummary.maxLiveQuota}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-[#7DF2AD]">
                    Paper {dbSummary.paperCount}/{dbSummary.maxPaperQuota}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Lookback Window Selector (1D / 3D / 7D / 1M) */}
            <div
              className="flex items-center rounded-lg border border-white/[0.08] bg-[#0E121A] p-0.5"
              role="group"
              aria-label="Binance sync lookback period"
            >
              {(
                [
                  { id: '1d', label: '1D' },
                  { id: '3d', label: '3D' },
                  { id: '7d', label: '7D' },
                  { id: '30d', label: '1M' },
                ] as const
              ).map((lb) => (
                <button
                  key={lb.id}
                  type="button"
                  onClick={() => setSyncLookback(lb.id)}
                  className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition ${
                    syncLookback === lb.id
                      ? 'bg-amber-400 text-[#0B0F17]'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {lb.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void fetchOrderHistory({ syncBinance: true })}
              disabled={syncingBinance}
              className="flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-[#0E121A] px-3.5 py-2 text-xs font-semibold text-amber-300 transition hover:border-amber-400/60 hover:bg-amber-950/25 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncingBinance ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>
                {syncingBinance
                  ? `Syncing (${syncLookback.toUpperCase()})…`
                  : `Sync Binance (${syncLookback === '30d' ? '1M' : syncLookback.toUpperCase()})`}
              </span>
            </button>

            {/* Auto-Poll Interval Selector */}
            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0E121A] px-2.5 py-1.5 text-xs">
              <Clock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <label htmlFor="order-auto-poll" className="text-[11px] text-slate-400">
                Auto-Poll:
              </label>
              <select
                id="order-auto-poll"
                value={autoPollInterval}
                onChange={(e) => setAutoPollInterval(e.target.value as OrderAutoPollInterval)}
                className="bg-transparent font-mono text-xs font-semibold text-[#7DF2AD] focus:outline-none"
              >
                <option value="off" className="bg-[#0E121A]">Off</option>
                <option value="1m" className="bg-[#0E121A]">1m</option>
                <option value="5m" className="bg-[#0E121A]">5m</option>
                <option value="15m" className="bg-[#0E121A]">15m</option>
              </select>
            </div>

            {/* Orphan Pair Manager Toggle */}
            <button
              type="button"
              onClick={() => {
                setShowOrphanPanel((v) => !v);
                void fetchOrphanPairs();
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                orphans.length > 0
                  ? 'border-rose-400/40 bg-rose-950/30 text-rose-200 hover:bg-rose-950/50'
                  : 'border-white/[0.08] bg-[#0E121A] text-slate-200 hover:bg-[#1A202C]'
              }`}
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Orphan Pairs ({orphans.length})</span>
            </button>

            {/* Database Management Toggle */}
            <button
              type="button"
              onClick={() => setShowDbAdmin((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0E121A] px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-[#1A202C] whitespace-nowrap shrink-0"
            >
              <Database className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
              <span>DB Admin</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchOrderHistory()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0E121A] px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-[#1A202C] disabled:opacity-50 whitespace-nowrap shrink-0"
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

      {/* Database Management Drawer */}
      {showDbAdmin && (
        <section
          aria-label="Order History Database Administration"
          className="rounded-xl border border-white/[0.08] bg-[#141820] p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Order History Database Management ({dbSummary?.dbPath ?? '.apexrust-orders.sqlite'})
              </h2>
              <p className="text-xs text-slate-400">
                Engine:{' '}
                <strong className="font-mono text-[#7DF2AD]">
                  {dbSummary?.engine === 'sqlite_wal' ? 'SQLite WAL (ACID Indexed)' : 'JSONL Fallback'}
                </strong>{' '}
                · Partitioned Quotas keep Paper simulation fills from evicting Live Binance audit records.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={includeOrphansOnSync}
                onChange={(e) => setIncludeOrphansOnSync(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/20 bg-[#0B0F17]"
              />
              <span>Auto-include discovered orphan pairs during Binance sync</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleExportJsonDb}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0E121A] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-[#7DF2AD]/50 hover:text-[#7DF2AD]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Backup JSON DB</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleImportJsonFile(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0E121A] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-sky-400/50 hover:text-sky-300"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Restore JSON DB</span>
            </button>

            <button
              type="button"
              onClick={() => void handlePruneOrClearDb({ olderThanDays: 30 })}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0E121A] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-amber-400/50 hover:text-amber-200"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Prune Older Than 30D</span>
            </button>

            <button
              type="button"
              onClick={() => void handlePruneOrClearDb({ accountMode: 'Paper' })}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0E121A] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-rose-400/50 hover:text-rose-200"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear Paper Logs</span>
            </button>

            <button
              type="button"
              onClick={() => void handlePruneOrClearDb({ accountMode: 'ALL' })}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-950/25 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-950/45"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear All DB Records</span>
            </button>
          </div>
        </section>
      )}

      {/* Orphan Pair Detection & Reconciliation Panel */}
      {(showOrphanPanel || orphans.length > 0) && (
        <section
          aria-label="Orphan Pair Management"
          className="rounded-xl border border-amber-500/30 bg-[#141820] p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-100">
                  Orphan Pair & Exchange Desync Management ({orphans.length})
                </h2>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Detects symbols with active Binance orders/positions outside{' '}
                <code className="font-mono text-slate-300">trading.pairs</code> or local DB orders out of sync with Binance.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={scanningOrphans}
                onClick={() => void fetchOrphanPairs()}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0E121A] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-[#7DF2AD]/50 disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${scanningOrphans ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{scanningOrphans ? 'Scanning…' : 'Scan Exchange & DB'}</span>
              </button>
              {showOrphanPanel && (
                <button
                  type="button"
                  onClick={() => setShowOrphanPanel(false)}
                  className="rounded-md p-1 text-slate-400 hover:text-slate-200"
                  aria-label="Close orphan pair panel"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {orphans.length === 0 ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-950/20 px-3.5 py-2.5 text-xs text-emerald-200">
              No orphan pairs or stale local orders detected. All exchange open orders, positions, and DB symbols match your active configuration.
            </div>
          ) : (
            <div className="space-y-2">
              {orphans.map((orph) => {
                const isBusy = resolvingOrphanKey?.startsWith(`${orph.symbol}:`);
                return (
                  <div
                    key={`${orph.venue}:${orph.symbol}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-[#0E121A] px-3.5 py-2.5 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-slate-100">
                          {orph.symbol}
                        </span>
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                          {orph.venue} · {orph.environment}
                        </span>
                        {orph.kinds.includes('exchange_untracked_pair') && (
                          <span className="rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300">
                            EXCHANGE UNTRACKED PAIR
                          </span>
                        )}
                        {orph.kinds.includes('stale_local_open_order') && (
                          <span className="rounded border border-amber-400/40 bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300">
                            STALE LOCAL OPEN ORDER
                          </span>
                        )}
                        {orph.kinds.includes('db_unconfigured_pair') && (
                          <span className="rounded border border-slate-500/40 bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
                            UNCONFIGURED DB PAIR
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">{orph.summary}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {!orph.inConfiguredPairs && (
                        <button
                          type="button"
                          disabled={Boolean(isBusy)}
                          onClick={() => void handleResolveOrphan(orph.symbol, orph.venue, 'adopt_pair')}
                          className="flex items-center gap-1 rounded-md bg-[#7DF2AD] px-2.5 py-1 text-[11px] font-bold text-[#0B0F17] hover:bg-[#95F7BD] disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                          <span>Adopt Pair</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={Boolean(isBusy)}
                        onClick={() => void handleResolveOrphan(orph.symbol, orph.venue, 'sync_history')}
                        className="rounded-md border border-amber-400/40 bg-amber-950/25 px-2.5 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-950/45 disabled:opacity-40"
                      >
                        Sync ({syncLookback === '30d' ? '1M' : syncLookback.toUpperCase()})
                      </button>
                      {orph.localStaleOpenOrderIds.length > 0 && (
                        <button
                          type="button"
                          disabled={Boolean(isBusy)}
                          onClick={() =>
                            void handleResolveOrphan(orph.symbol, orph.venue, 'reconcile_orders')
                          }
                          className="rounded-md border border-sky-400/40 bg-sky-950/25 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-950/45 disabled:opacity-40"
                        >
                          Reconcile Orders ({orph.localStaleOpenOrderIds.length})
                        </button>
                      )}
                      {orph.exchangeOpenOrdersCount + orph.exchangeAlgoOrdersCount > 0 && (
                        <button
                          type="button"
                          disabled={Boolean(isBusy)}
                          onClick={() =>
                            void handleResolveOrphan(orph.symbol, orph.venue, 'cancel_exchange_orders')
                          }
                          className="rounded-md border border-rose-500/40 bg-rose-950/30 px-2.5 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-950/50 disabled:opacity-40"
                        >
                          Cancel Exchange Orders
                        </button>
                      )}
                      {orph.localDbOrderCount > 0 &&
                        orph.exchangeOpenOrdersCount === 0 &&
                        Math.abs(orph.exchangePositionAmt) === 0 && (
                          <button
                            type="button"
                            disabled={Boolean(isBusy)}
                            onClick={() =>
                              void handleResolveOrphan(orph.symbol, orph.venue, 'purge_local_records')
                            }
                            className="rounded-md border border-white/[0.1] bg-[#141820] px-2.5 py-1 text-[11px] text-slate-300 hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-40"
                          >
                            Purge DB ({orph.localDbOrderCount})
                          </button>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

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
                  All Pairs ({allAvailableSymbols.length})
                </option>
                {allAvailableSymbols.map((sym) => (
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
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">Time / Updated</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">Symbol / Venue</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">Type</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">Side</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Average / Price</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Executed / Amount</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total (USDT)</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Trigger Conditions</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">ReduceOnly / Flags</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Fee / Realized Profit</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-xs font-mono tabular-nums">
                {filteredLogs.map((log) => {
                  const isSelected = log.id === inspectedId;
                  const createdDt = new Date(log.orderTimeMs ?? log.timestampMs);
                  const updatedDt = new Date(log.updateTimeMs ?? log.timestampMs);
                  const hasPnl = log.realizedPnlUsdt !== null;
                  const rowPnlPos = (log.realizedPnlUsdt ?? 0) >= 0;
                  const avgPx =
                    log.avgPrice !== undefined && log.avgPrice > 0
                      ? log.avgPrice
                      : log.executedQty > 0 && log.quoteQty > 0
                        ? log.quoteQty / log.executedQty
                        : log.price;
                  const fillPct =
                    log.origQty > 0 ? Math.min(100, (log.executedQty / log.origQty) * 100) : 0;
                  const stopPx = log.stopPrice ?? 0;
                  const triggerLabel =
                    stopPx > 0
                      ? `${log.workingType === 'CONTRACT_PRICE' ? 'Last' : 'Mark'} ${
                          log.binanceSide === 'SELL' ? '<=' : '>='
                        } $${fmtPx(stopPx)}`
                      : log.activatePrice && log.activatePrice > 0
                        ? `Act $${fmtPx(log.activatePrice)}${log.priceRate ? ` (${log.priceRate}%)` : ''}`
                        : '—';
                  const isPostOnly =
                    log.orderType === 'LIMIT_MAKER' || log.timeInForce === 'GTX';

                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        className={`transition-colors ${
                          isSelected ? 'bg-[#19202D]' : 'hover:bg-white/[0.025]'
                        }`}
                      >
                        {/* 1. Time / Updated & Order ID */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="text-slate-100">
                            {createdDt.toISOString().slice(0, 10)} {createdDt.toISOString().slice(11, 19)}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            Upd {updatedDt.toISOString().slice(11, 19)} · #{log.orderId}
                          </div>
                        </td>

                        {/* 2. Symbol / Venue */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onSelectPairAndTrade(log.symbol)}
                              className="font-sans font-semibold text-slate-100 hover:text-[#7DF2AD] transition-colors"
                            >
                              {log.symbol}
                            </button>
                            <span className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[10px] text-slate-300">
                              {log.venue === 'Futures' ? 'Perp' : 'Spot'}
                            </span>
                          </div>
                          <div className="font-sans text-[10px] text-slate-400">
                            {log.environment} ·{' '}
                            <span className={log.accountMode === 'Live' ? 'text-amber-300' : 'text-emerald-300'}>
                              {log.accountMode}
                            </span>
                            {log.orderListId && log.orderListId > 0 ? ` · OCO#${log.orderListId}` : ''}
                          </div>
                        </td>

                        {/* 3. Type */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="font-semibold text-slate-200">{log.orderType}</div>
                          {log.origType && log.origType !== log.orderType ? (
                            <div className="text-[10px] text-slate-400">Orig: {log.origType}</div>
                          ) : (
                            <div className="text-[10px] text-slate-500">{log.timeInForce}</div>
                          )}
                        </td>

                        {/* 4. Side / PositionSide */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1">
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
                            {log.venue === 'Futures' && (
                              <span className="rounded bg-white/[0.05] px-1 py-0.5 text-[10px] text-slate-300">
                                {log.positionSide ?? 'BOTH'}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {log.lifecycle} ({log.side})
                          </div>
                        </td>

                        {/* 5. Average / Order Price */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="font-semibold text-slate-100">
                            {avgPx > 0 ? `$${fmtPx(avgPx)}` : '—'}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {log.orderType === 'MARKET' || log.price <= 0
                              ? 'Market'
                              : `Lim $${fmtPx(log.price)}`}
                          </div>
                        </td>

                        {/* 6. Executed / Amount */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="text-slate-100">
                            {log.executedQty.toFixed(4)} / {log.origQty.toFixed(4)}
                          </div>
                          <div className="text-[10px] text-slate-400">{fillPct.toFixed(1)}% Filled</div>
                        </td>

                        {/* 7. Total (Cum. Quote) */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="font-semibold text-slate-100">${fmtUsd(log.quoteQty)}</div>
                          <div className="text-[10px] text-slate-400">USDT</div>
                        </td>

                        {/* 8. Trigger Conditions */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="text-slate-200">{triggerLabel}</div>
                          {log.priceProtect ? (
                            <div className="text-[10px] text-emerald-400">PriceProtect</div>
                          ) : null}
                        </td>

                        {/* 9. ReduceOnly / PostOnly / Flags */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex flex-wrap items-center gap-1">
                            {log.reduceOnly && (
                              <span className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                                ReduceOnly
                              </span>
                            )}
                            {log.closePosition && (
                              <span className="rounded border border-rose-400/30 bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-300">
                                CloseAll
                              </span>
                            )}
                            {isPostOnly && (
                              <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                                PostOnly
                              </span>
                            )}
                            {!log.reduceOnly && !log.closePosition && !isPostOnly && (
                              <span className="text-[10px] text-slate-500">
                                {log.selfTradePreventionMode && log.selfTradePreventionMode !== 'NONE'
                                  ? `STP:${log.selfTradePreventionMode}`
                                  : 'Standard'}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 10. Fee & Realized Profit */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {hasPnl ? (
                            <div
                              className={`font-semibold ${
                                rowPnlPos ? 'text-[#7DF2AD]' : 'text-[#F87171]'
                              }`}
                            >
                              {rowPnlPos ? '+' : '-'}${fmtUsd(log.realizedPnlUsdt!)}
                              {log.rMultiple !== null ? (
                                <span className="ml-1 text-[10px] opacity-85">
                                  ({log.rMultiple >= 0 ? '+' : ''}
                                  {log.rMultiple.toFixed(2)}R)
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <div className="text-slate-400">
                              {log.exitReason ?? '—'}
                            </div>
                          )}
                          <div className="text-[10px] text-slate-400">
                            Fee {log.commission.toFixed(4)} {log.commissionAsset} ({log.isMaker ? 'M' : 'T'})
                          </div>
                        </td>

                        {/* 11. Status & Inspect */}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
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
                            <button
                              type="button"
                              onClick={() => setInspectedId(isSelected ? null : log.id)}
                              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-mono transition-colors ${
                                isSelected
                                  ? 'border-[#7DF2AD]/50 bg-[#7DF2AD]/15 text-[#7DF2AD]'
                                  : 'border-white/[0.08] bg-[#0B0F17] text-slate-300 hover:text-white'
                              }`}
                            >
                              <Code2 className="h-3 w-3" aria-hidden="true" />
                              <span>{isSelected ? 'Hide' : 'JSON'}</span>
                            </button>
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-500">
                            {log.latencyMs !== null ? `${Math.round(log.latencyMs)}ms · ` : ''}
                            {log.source}
                          </div>
                        </td>
                      </tr>

                      {isSelected && (
                        <tr className="bg-[#0B0F17]">
                          <td colSpan={11} className="px-4 py-3.5">
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
