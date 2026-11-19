import { escapeCsvCell } from './formatters';
import type {
  ExchangeVenue,
  ExecutionAccountMode,
  OrderExecutionLog,
  OrderExecutionStatus,
  OrphanPairKind,
  OrphanPairRecord,
  SyncLookbackPreset,
} from './types';

interface OrderHistoryFilters {
  accountMode: 'ALL' | ExecutionAccountMode;
  venue: 'ALL' | ExchangeVenue;
  status: 'ALL' | OrderExecutionStatus;
  symbol: string; // 'ALL' or symbol string
  query: string;
  startDate?: string; // YYYY-MM-DD (UTC, inclusive from 00:00:00.000Z)
  endDate?: string; // YYYY-MM-DD (UTC, inclusive through 23:59:59.999Z)
}

interface UtcDateRangeBounds {
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
  preset: 'today' | '1d' | '3d' | '7d' | '30d',
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
  const offsetDays =
    preset === 'today'
      ? 0
      : preset === '1d'
        ? 1
        : preset === '3d'
          ? 2
          : preset === '7d'
            ? 6
            : 29;
  const startDayStartMs = endDayStartMs - offsetDays * 86_400_000;
  return {
    startDate: new Date(startDayStartMs).toISOString().slice(0, 10),
    endDate: new Date(endDayStartMs).toISOString().slice(0, 10),
  };
}

export function lookbackPresetToMs(preset: SyncLookbackPreset): number {
  switch (preset) {
    case '1d':
      return 1 * 86_400_000;
    case '3d':
      return 3 * 86_400_000;
    case '7d':
      return 7 * 86_400_000;
    case '30d':
      return 30 * 86_400_000;
  }
}

/**
 * Generates official Binance-compliant [startTime, endTime] slices:
 * - Spot (`GET /api/v3/allOrders`, `GET /api/v3/myTrades`): `endTime - startTime` MUST be < 24h (we use 23h59m59.999s = 86_399_999ms).
 * - USD-M Futures (`GET /fapi/v1/allOrders`, `GET /fapi/v1/userTrades`): `endTime - startTime` MUST be <= 7d (we use 6d = 518_400_000ms so 30d splits into 5 clean slices).
 */
export function buildBinanceSyncTimeWindows(
  venue: ExchangeVenue,
  lookback: SyncLookbackPreset,
  nowMs: number = Date.now()
): Array<{ startTime: number; endTime: number }> {
  const totalDurationMs = lookbackPresetToMs(lookback);
  const startBoundMs = Math.max(0, nowMs - totalDurationMs);
  const maxSliceMs = venue === 'Spot' ? 86_399_999 : 6 * 86_400_000;
  const windows: Array<{ startTime: number; endTime: number }> = [];
  let cursor = startBoundMs;
  while (cursor < nowMs) {
    const segEnd = Math.min(nowMs, cursor + maxSliceMs);
    windows.push({ startTime: cursor, endTime: segEnd });
    if (segEnd >= nowMs) break;
    cursor = segEnd + 1;
  }
  return windows;
}

interface AggregatedOrderTradeMetrics {
  orderId: string;
  commission: number;
  commissionAsset: string;
  isMaker: boolean;
  realizedPnlUsdt: number | null;
  executedQty: number;
  quoteQty: number;
}

export function aggregateTradesByOrderId(
  rawTrades: Array<Record<string, unknown>>,
  venue: ExchangeVenue
): Map<string, AggregatedOrderTradeMetrics> {
  const map = new Map<string, AggregatedOrderTradeMetrics>();
  for (const t of rawTrades) {
    const ordId = String(t.orderId ?? '').trim();
    if (!ordId) continue;
    const comm = Number(t.commission ?? 0) || 0;
    const commAsset = String(t.commissionAsset ?? 'USDT').trim() || 'USDT';
    const isMaker = Boolean(t.isMaker ?? t.maker ?? false);
    const qty = Number(t.qty ?? 0) || 0;
    const price = Number(t.price ?? 0) || 0;
    const quoteQty = Number(t.quoteQty ?? qty * price) || 0;
    const rawPnl = t.realizedPnl !== undefined ? Number(t.realizedPnl) : NaN;
    const hasPnl = venue === 'Futures' && Number.isFinite(rawPnl);

    const existing = map.get(ordId);
    if (!existing) {
      map.set(ordId, {
        orderId: ordId,
        commission: comm,
        commissionAsset: commAsset,
        isMaker,
        realizedPnlUsdt: hasPnl ? rawPnl : null,
        executedQty: qty,
        quoteQty,
      });
    } else {
      existing.commission += comm;
      existing.isMaker = existing.isMaker || isMaker;
      existing.executedQty += qty;
      existing.quoteQty += quoteQty;
      if (hasPnl) {
        existing.realizedPnlUsdt = (existing.realizedPnlUsdt ?? 0) + rawPnl;
      }
    }
  }
  return map;
}

export function detectOrphanPairs(params: {
  configuredPairs: string[];
  venue: ExchangeVenue;
  environment: 'Testnet' | 'Production';
  dbLogs: OrderExecutionLog[];
  exchangeOpenOrders?: Array<Record<string, unknown>>;
  exchangeAlgoOrders?: Array<Record<string, unknown>>;
  exchangePositions?: Array<Record<string, unknown>>;
  exchangeSpotBalances?: Array<{ asset: string; free: number; locked: number }>;
  knownQuoteAssets?: string[];
  nowMs?: number;
}): OrphanPairRecord[] {
  const nowMs = params.nowMs ?? Date.now();
  const configuredList = params.configuredPairs.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const configuredSet = new Set(configuredList);
  const quotesList = (params.knownQuoteAssets ?? ['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'BNB', 'ETH', 'BTC']).map((q) =>
    q.toUpperCase()
  );
  const quotes = new Set(quotesList);

  const openOrdersBySym = new Map<string, Set<string>>();
  for (const ord of params.exchangeOpenOrders ?? []) {
    const sym = String(ord.symbol ?? '').trim().toUpperCase();
    const ordId = String(ord.orderId ?? '').trim();
    if (!sym) continue;
    let set = openOrdersBySym.get(sym);
    if (!set) {
      set = new Set();
      openOrdersBySym.set(sym, set);
    }
    if (ordId) set.add(ordId);
  }

  const algoOrdersBySym = new Map<string, number>();
  const algoIdsBySym = new Map<string, Set<string>>();
  for (const algo of params.exchangeAlgoOrders ?? []) {
    const sym = String(algo.symbol ?? '').trim().toUpperCase();
    if (!sym) continue;
    algoOrdersBySym.set(sym, (algoOrdersBySym.get(sym) ?? 0) + 1);
    const algoId = String(algo.algoId ?? '').trim();
    if (algoId) {
      let set = algoIdsBySym.get(sym);
      if (!set) {
        set = new Set();
        algoIdsBySym.set(sym, set);
      }
      set.add(algoId);
    }
  }

  const posBySym = new Map<string, { positionAmt: number; unrealizedPnlUsdt: number }>();
  for (const pos of params.exchangePositions ?? []) {
    const sym = String(pos.symbol ?? '').trim().toUpperCase();
    const amt = Number(pos.positionAmt ?? 0) || 0;
    const upnl = Number(pos.unRealizedProfit ?? pos.unrealizedProfit ?? 0) || 0;
    if (!sym || Math.abs(amt) <= 1e-12) continue;
    const prev = posBySym.get(sym);
    posBySym.set(sym, {
      positionAmt: (prev?.positionAmt ?? 0) + amt,
      unrealizedPnlUsdt: (prev?.unrealizedPnlUsdt ?? 0) + upnl,
    });
  }

  const findExistingSymbolForBase = (asset: string): string | null => {
    const matchesAsset = (sym: string): boolean => {
      if (!sym.startsWith(asset)) return false;
      const suffix = sym.slice(asset.length);
      return quotes.has(suffix);
    };
    const fromConfigured = configuredList.find(matchesAsset);
    if (fromConfigured) return fromConfigured;
    for (const sym of openOrdersBySym.keys()) {
      if (matchesAsset(sym)) return sym;
    }
    for (const log of params.dbLogs) {
      const sym = log.symbol.toUpperCase();
      if (matchesAsset(sym)) return sym;
    }
    return null;
  };

  const spotBySym = new Map<string, { free: number; locked: number }>();
  if (params.venue === 'Spot') {
    for (const bal of params.exchangeSpotBalances ?? []) {
      const asset = String(bal.asset ?? '').trim().toUpperCase();
      if (!asset || quotes.has(asset)) continue;
      const total = (Number(bal.free) || 0) + (Number(bal.locked) || 0);
      if (total < 0.0001) continue;
      const sym = findExistingSymbolForBase(asset) ?? `${asset}USDT`;
      spotBySym.set(sym, { free: Number(bal.free) || 0, locked: Number(bal.locked) || 0 });
    }
  }

  const dbCountBySym = new Map<string, number>();
  const dbOpenIdsBySym = new Map<string, string[]>();
  for (const log of params.dbLogs) {
    if (log.accountMode !== 'Live' || log.venue !== params.venue || log.environment !== params.environment) {
      continue;
    }
    const sym = log.symbol.toUpperCase();
    dbCountBySym.set(sym, (dbCountBySym.get(sym) ?? 0) + 1);
    if (log.status === 'NEW' || log.status === 'PARTIALLY_FILLED') {
      const liveSet = openOrdersBySym.get(sym);
      const algoSet = algoIdsBySym.get(sym);
      const hasOpenMatch = Boolean(liveSet && liveSet.has(log.orderId));
      const hasAlgoMatch =
        Boolean(algoSet && (algoSet.has(log.orderId) || (log.algoId ? algoSet.has(String(log.algoId)) : false))) ||
        Boolean(algoSet && log.algoOrderIds?.some((id) => algoSet.has(String(id))));
      if (!hasOpenMatch && !hasAlgoMatch) {
        const list = dbOpenIdsBySym.get(sym) ?? [];
        if (!list.includes(log.orderId)) list.push(log.orderId);
        dbOpenIdsBySym.set(sym, list);
      }
    }
  }

  const candidateSymbols = new Set<string>([
    ...openOrdersBySym.keys(),
    ...algoOrdersBySym.keys(),
    ...posBySym.keys(),
    ...spotBySym.keys(),
    ...dbCountBySym.keys(),
  ]);

  const records: OrphanPairRecord[] = [];
  for (const symbol of candidateSymbols) {
    const inConfigured = configuredSet.has(symbol);
    const openOrdersCount = openOrdersBySym.get(symbol)?.size ?? 0;
    const algoOrdersCount = algoOrdersBySym.get(symbol) ?? 0;
    const pos = posBySym.get(symbol);
    const spotBal = spotBySym.get(symbol);
    const dbCount = dbCountBySym.get(symbol) ?? 0;
    const staleOpenIds = dbOpenIdsBySym.get(symbol) ?? [];

    const hasExchangeActivity =
      openOrdersCount > 0 ||
      algoOrdersCount > 0 ||
      Boolean(pos && Math.abs(pos.positionAmt) > 0) ||
      Boolean(spotBal && spotBal.free + spotBal.locked >= 0.0001);

    const kinds: OrphanPairKind[] = [];
    if (!inConfigured && hasExchangeActivity) {
      kinds.push('exchange_untracked_pair');
    }
    if (staleOpenIds.length > 0) {
      kinds.push('stale_local_open_order');
    }
    if (!inConfigured && dbCount > 0 && !hasExchangeActivity) {
      kinds.push('db_unconfigured_pair');
    }

    if (kinds.length === 0) continue;

    const summaryParts: string[] = [];
    if (!inConfigured) summaryParts.push('Not in active trading.pairs');
    if (openOrdersCount > 0) summaryParts.push(`${openOrdersCount} open order(s) on Binance`);
    if (algoOrdersCount > 0) summaryParts.push(`${algoOrdersCount} conditional algo order(s)`);
    if (pos && Math.abs(pos.positionAmt) > 0) {
      summaryParts.push(`Futures position: ${pos.positionAmt}`);
    }
    if (spotBal && spotBal.free + spotBal.locked >= 0.0001) {
      summaryParts.push(`Spot holding: ${(spotBal.free + spotBal.locked).toFixed(4)}`);
    }
    if (staleOpenIds.length > 0) {
      summaryParts.push(`${staleOpenIds.length} local NEW/PARTIAL order(s) missing from Binance openOrders`);
    }
    if (dbCount > 0 && !hasExchangeActivity && !inConfigured) {
      summaryParts.push(`${dbCount} archived local DB record(s)`);
    }

    records.push({
      symbol,
      venue: params.venue,
      environment: params.environment,
      kinds,
      inConfiguredPairs: inConfigured,
      exchangeOpenOrdersCount: openOrdersCount,
      exchangeAlgoOrdersCount: algoOrdersCount,
      exchangePositionAmt: pos?.positionAmt ?? 0,
      exchangeUnrealizedPnlUsdt: pos?.unrealizedPnlUsdt ?? 0,
      exchangeSpotFreeBalance: spotBal?.free ?? 0,
      exchangeSpotLockedBalance: spotBal?.locked ?? 0,
      localDbOrderCount: dbCount,
      localStaleOpenOrderIds: staleOpenIds,
      summary: summaryParts.join(' · '),
      detectedAtMs: nowMs,
    });
  }

  return records.sort((a, b) => {
    const score = (r: OrphanPairRecord) =>
      (r.kinds.includes('exchange_untracked_pair') ? 100 : 0) +
      (r.kinds.includes('stale_local_open_order') ? 50 : 0) +
      r.exchangeOpenOrdersCount +
      r.exchangeAlgoOrdersCount;
    return score(b) - score(a) || a.symbol.localeCompare(b.symbol);
  });
}

interface EquityCurvePoint {
  id: string;
  orderId: string;
  symbol: string;
  timestampMs: number;
  pnlUsdt: number;
  cumulativePnlUsdt: number;
  drawdownUsdt: number;
}

interface OrderPerformanceMetrics {
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
    } else if (log.status === 'NEW' || log.status === 'PENDING_CANCEL') {
      openOrders += 1;
    } else if (
      log.status === 'CANCELED' ||
      log.status === 'EXPIRED' ||
      log.status === 'EXPIRED_IN_MATCH'
    ) {
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

export function formatOrderLogsCsv(logs: OrderExecutionLog[]): string {
  const headers = [
    'order_time_iso',
    'update_time_iso',
    'order_id',
    'client_order_id',
    'order_list_id',
    'algo_id',
    'account_mode',
    'source',
    'venue',
    'environment',
    'symbol',
    'lifecycle',
    'side',
    'binance_side',
    'position_side',
    'order_type',
    'orig_type',
    'time_in_force',
    'status',
    'avg_price',
    'order_price',
    'stop_price',
    'working_type',
    'executed_qty',
    'orig_qty',
    'quote_qty_usdt',
    'reduce_only',
    'close_position',
    'price_protect',
    'self_trade_prevention_mode',
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
  const rows = logs.map((l) => {
    const orderTimeIso = new Date(l.orderTimeMs ?? l.timestampMs).toISOString();
    const updateTimeIso = new Date(l.updateTimeMs ?? l.timestampMs).toISOString();
    const avgPx = l.avgPrice !== undefined && l.avgPrice > 0 ? l.avgPrice : l.price;
    return [
      orderTimeIso,
      updateTimeIso,
      l.orderId,
      l.clientOrderId,
      l.orderListId ?? '',
      l.algoId ?? '',
      l.accountMode,
      l.source,
      l.venue,
      l.environment,
      l.symbol,
      l.lifecycle,
      l.side,
      l.binanceSide,
      l.positionSide ?? 'BOTH',
      l.orderType,
      l.origType ?? l.orderType,
      l.timeInForce,
      l.status,
      avgPx,
      l.price,
      l.stopPrice ?? 0,
      l.workingType ?? '',
      l.executedQty,
      l.origQty,
      l.quoteQty.toFixed(2),
      l.reduceOnly ? 'TRUE' : 'FALSE',
      l.closePosition ? 'TRUE' : 'FALSE',
      l.priceProtect ? 'TRUE' : 'FALSE',
      l.selfTradePreventionMode ?? 'NONE',
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
      .join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

interface OrderStatusBadgeMeta {
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
    case 'PENDING_CANCEL':
      return { label: 'PENDING CANCEL', tone: 'amber' };
    case 'CANCELED':
      return { label: 'CANCELED', tone: 'slate' };
    case 'EXPIRED':
    case 'EXPIRED_IN_MATCH':
      return { label: status === 'EXPIRED_IN_MATCH' ? 'EXP IN MATCH' : 'EXPIRED', tone: 'slate' };
    case 'REJECTED':
      return { label: 'REJECTED', tone: 'rose' };
  }
}
