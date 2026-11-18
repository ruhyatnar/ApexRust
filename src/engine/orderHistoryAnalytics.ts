import type { ExchangeVenue, ExecutionAccountMode, OrderExecutionLog, OrderExecutionStatus } from './types';

export interface OrderHistoryFilters {
  accountMode: 'ALL' | ExecutionAccountMode;
  venue: 'ALL' | ExchangeVenue;
  status: 'ALL' | OrderExecutionStatus;
  symbol: string; // 'ALL' or symbol string
  query: string;
  startDate?: string; // YYYY-MM-DD (UTC, inclusive from 00:00:00.000Z)
  endDate?: string; // YYYY-MM-DD (UTC, inclusive through 23:59:59.999Z)
}

export interface UtcDateRangeBounds {
  startMs: number | null;
  endMs: number | null;
  isInverted: boolean;
}

function parseIsoUtcDateParts(dateStr?: string): { year: number; month: number; day: number } | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function parseUtcDateRangeBounds(
  startDate?: string,
  endDate?: string
): UtcDateRangeBounds {
  const startParts = parseIsoUtcDateParts(startDate);
  const endParts = parseIsoUtcDateParts(endDate);
  const startMs = startParts
    ? Date.UTC(startParts.year, startParts.month - 1, startParts.day, 0, 0, 0, 0)
    : null;
  const endMs = endParts
    ? Date.UTC(endParts.year, endParts.month - 1, endParts.day, 23, 59, 59, 999)
    : null;
  const isInverted = startMs !== null && endMs !== null && startMs > endMs;
  return { startMs, endMs, isInverted };
}

export function computeUtcDatePresetRange(
  preset: 'today' | '7d' | '30d',
  nowMs: number = Date.now()
): { startDate: string; endDate: string } {
  const endUtc = new Date(nowMs);
  const endDayStartMs = Date.UTC(
    endUtc.getUTCFullYear(),
    endUtc.getUTCMonth(),
    endUtc.getUTCDate(),
    0,
    0,
    0,
    0
  );
  const offsetDays = preset === 'today' ? 0 : preset === '7d' ? 6 : 29;
  const startDayStartMs = endDayStartMs - offsetDays * 86_400_000;
  return {
    startDate: new Date(startDayStartMs).toISOString().slice(0, 10),
    endDate: new Date(endDayStartMs).toISOString().slice(0, 10),
  };
}

export interface EquityCurvePoint {
  id: string;
  orderId: string;
  symbol: string;
  timestampMs: number;
  pnlUsdt: number;
  cumulativePnlUsdt: number;
  drawdownUsdt: number;
}

export interface OrderPerformanceMetrics {
  totalOrders: number;
  filledOrders: number;
  openOrders: number;
  canceledOrders: number;
  rejectedOrders: number;
  fillRatePct: number;
  totalVolumeUsdt: number;
  totalCommissionUsdt: number;
  makerCount: number;
  takerCount: number;
  makerRatioPct: number;
  exitCount: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;
  winLossRatio: number;
  netRealizedPnlUsdt: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  profitFactor: number;
  avgRMultiple: number;
  avgPnlPerExitUsdt: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  peakPnlUsdt: number;
  maxDrawdownUsdt: number;
  equityCurve: EquityCurvePoint[];
}

export function filterOrderLogs(
  logs: OrderExecutionLog[],
  filters: OrderHistoryFilters
): OrderExecutionLog[] {
  const q = filters.query.trim().toLowerCase();
  const qNormalized = q.replace(/^[#]+/, '').replace(/[/-]/g, '');
  const { startMs, endMs } = parseUtcDateRangeBounds(filters.startDate, filters.endDate);
  return logs
    .filter((log) => {
      if (filters.accountMode !== 'ALL' && log.accountMode !== filters.accountMode) return false;
      if (filters.venue !== 'ALL' && log.venue !== filters.venue) return false;
      if (filters.status !== 'ALL' && log.status !== filters.status) return false;
      if (filters.symbol !== 'ALL' && log.symbol !== filters.symbol) return false;
      if (startMs !== null && log.timestampMs < startMs) return false;
      if (endMs !== null && log.timestampMs > endMs) return false;
      if (q) {
        const listPart = log.orderListId && log.orderListId > 0 ? `oco:#${log.orderListId} ${log.orderListId}` : '';
        const hay = `${log.orderId} #${log.orderId} ${log.clientOrderId} ${listPart} ${log.symbol} ${log.orderType} ${log.rationale} ${log.exitReason ?? ''} ${log.errorMessage ?? ''}`.toLowerCase();
        if (!hay.includes(q) && (!qNormalized || !hay.replace(/[/-]/g, '').includes(qNormalized))) {
          return false;
        }
      }
      return true;
    })
    .slice()
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

export function computeOrderPerformanceMetrics(logs: OrderExecutionLog[]): OrderPerformanceMetrics {
  let filledOrders = 0;
  let openOrders = 0;
  let canceledOrders = 0;
  let rejectedOrders = 0;
  let totalVolumeUsdt = 0;
  let totalCommissionUsdt = 0;
  let makerCount = 0;
  let takerCount = 0;

  const latencies: number[] = [];

  for (const log of logs) {
    if (log.status === 'FILLED' || log.status === 'PARTIALLY_FILLED') {
      filledOrders += 1;
      totalVolumeUsdt += Math.max(0, log.quoteQty);
      totalCommissionUsdt += Math.max(0, log.commission);
      if (log.isMaker) makerCount += 1;
      else takerCount += 1;
    } else if (log.status === 'NEW') {
      openOrders += 1;
    } else if (log.status === 'CANCELED' || log.status === 'EXPIRED') {
      canceledOrders += 1;
    } else if (log.status === 'REJECTED') {
      rejectedOrders += 1;
    }

    if (typeof log.latencyMs === 'number' && Number.isFinite(log.latencyMs) && log.latencyMs >= 0) {
      latencies.push(log.latencyMs);
    }
  }

  const actionableCount = filledOrders + canceledOrders + rejectedOrders;
  const fillRatePct = actionableCount > 0 ? (filledOrders / actionableCount) * 100 : 0;
  const makerRatioPct = filledOrders > 0 ? (makerCount / filledOrders) * 100 : 0;

  const exitLogs = logs
    .filter(
      (l) =>
        l.lifecycle === 'EXIT' &&
        (l.status === 'FILLED' || l.status === 'PARTIALLY_FILLED') &&
        typeof l.realizedPnlUsdt === 'number' &&
        Number.isFinite(l.realizedPnlUsdt)
    )
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

  let winCount = 0;
  let lossCount = 0;
  let netRealizedPnlUsdt = 0;
  let grossProfitUsdt = 0;
  let grossLossUsdt = 0;
  let rSum = 0;
  let rCount = 0;

  let peakPnlUsdt = 0;
  let maxDrawdownUsdt = 0;
  const equityCurve: EquityCurvePoint[] = [];

  for (const exit of exitLogs) {
    const pnl = exit.realizedPnlUsdt ?? 0;
    netRealizedPnlUsdt += pnl;
    if (pnl > 1e-9) {
      winCount += 1;
      grossProfitUsdt += pnl;
    } else if (pnl < -1e-9) {
      lossCount += 1;
      grossLossUsdt += Math.abs(pnl);
    }
    if (typeof exit.rMultiple === 'number' && Number.isFinite(exit.rMultiple)) {
      rSum += exit.rMultiple;
      rCount += 1;
    }
    if (netRealizedPnlUsdt > peakPnlUsdt) {
      peakPnlUsdt = netRealizedPnlUsdt;
    }
    const drawdownUsdt = Math.max(0, peakPnlUsdt - netRealizedPnlUsdt);
    if (drawdownUsdt > maxDrawdownUsdt) {
      maxDrawdownUsdt = drawdownUsdt;
    }
    equityCurve.push({
      id: exit.id,
      orderId: exit.orderId,
      symbol: exit.symbol,
      timestampMs: exit.timestampMs,
      pnlUsdt: pnl,
      cumulativePnlUsdt: netRealizedPnlUsdt,
      drawdownUsdt,
    });
  }

  const exitCount = exitLogs.length;
  const winRatePct = exitCount > 0 ? (winCount / exitCount) * 100 : 0;
  const winLossRatio =
    lossCount > 0
      ? winCount / lossCount
      : winCount > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  const profitFactor =
    grossLossUsdt > 1e-9
      ? grossProfitUsdt / grossLossUsdt
      : grossProfitUsdt > 1e-9
        ? Number.POSITIVE_INFINITY
        : 0;
  const avgRMultiple = rCount > 0 ? rSum / rCount : 0;
  const avgPnlPerExitUsdt = exitCount > 0 ? netRealizedPnlUsdt / exitCount : 0;

  let avgLatencyMs: number | null = null;
  let p95LatencyMs: number | null = null;
  if (latencies.length > 0) {
    const sorted = latencies.slice().sort((a, b) => a - b);
    avgLatencyMs = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
    const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    p95LatencyMs = sorted[Math.max(0, p95Idx)];
  }

  return {
    totalOrders: logs.length,
    filledOrders,
    openOrders,
    canceledOrders,
    rejectedOrders,
    fillRatePct,
    totalVolumeUsdt,
    totalCommissionUsdt,
    makerCount,
    takerCount,
    makerRatioPct,
    exitCount,
    winCount,
    lossCount,
    winRatePct,
    winLossRatio,
    netRealizedPnlUsdt,
    grossProfitUsdt,
    grossLossUsdt,
    profitFactor,
    avgRMultiple,
    avgPnlPerExitUsdt,
    avgLatencyMs,
    p95LatencyMs,
    peakPnlUsdt,
    maxDrawdownUsdt,
    equityCurve,
  };
}

function escapeCsvCell(raw: string | number | null | undefined): string {
  const s = raw === null || raw === undefined ? '' : String(raw);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function formatOrderLogsCsv(logs: OrderExecutionLog[]): string {
  const headers = [
    'timestamp_iso',
    'order_id',
    'client_order_id',
    'account_mode',
    'source',
    'venue',
    'environment',
    'symbol',
    'lifecycle',
    'side',
    'binance_side',
    'order_type',
    'time_in_force',
    'status',
    'price',
    'executed_qty',
    'orig_qty',
    'quote_qty_usdt',
    'commission',
    'commission_asset',
    'is_maker',
    'realized_pnl_usdt',
    'r_multiple',
    'exit_reason',
    'latency_ms',
    'endpoint',
    'rationale',
    'error_message',
  ];
  const rows = logs.map((l) =>
    [
      new Date(l.timestampMs).toISOString(),
      l.orderId,
      l.clientOrderId,
      l.accountMode,
      l.source,
      l.venue,
      l.environment,
      l.symbol,
      l.lifecycle,
      l.side,
      l.binanceSide,
      l.orderType,
      l.timeInForce,
      l.status,
      l.price,
      l.executedQty,
      l.origQty,
      l.quoteQty.toFixed(2),
      l.commission.toFixed(6),
      l.commissionAsset,
      l.isMaker ? 'MAKER' : 'TAKER',
      l.realizedPnlUsdt !== null ? l.realizedPnlUsdt.toFixed(2) : '',
      l.rMultiple !== null ? l.rMultiple.toFixed(2) : '',
      l.exitReason ?? '',
      l.latencyMs ?? '',
      l.endpoint,
      l.rationale,
      l.errorMessage ?? '',
    ]
      .map(escapeCsvCell)
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

export interface OrderStatusBadgeMeta {
  label: string;
  tone: 'emerald' | 'amber' | 'slate' | 'rose';
}

export function getOrderStatusBadgeMeta(status: OrderExecutionStatus): OrderStatusBadgeMeta {
  switch (status) {
    case 'FILLED':
      return { label: 'FILLED', tone: 'emerald' };
    case 'PARTIALLY_FILLED':
      return { label: 'PARTIAL', tone: 'amber' };
    case 'NEW':
      return { label: 'NEW', tone: 'amber' };
    case 'CANCELED':
      return { label: 'CANCELED', tone: 'slate' };
    case 'EXPIRED':
      return { label: 'EXPIRED', tone: 'slate' };
    case 'REJECTED':
      return { label: 'REJECTED', tone: 'rose' };
  }
}
