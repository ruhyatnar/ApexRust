import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOrderPerformanceMetrics,
  computeUtcDatePresetRange,
  filterOrderLogs,
  formatOrderLogsCsv,
  getOrderStatusBadgeMeta,
  parseUtcDateRangeBounds,
} from './orderHistoryAnalytics';
import type { OrderExecutionLog } from './types';

function makeLog(overrides: Partial<OrderExecutionLog> = {}): OrderExecutionLog {
  return {
    id: 'log-1',
    orderId: '9001',
    clientOrderId: 'apex_9001',
    symbol: 'BTCUSDT',
    venue: 'Spot',
    environment: 'Testnet',
    accountMode: 'Paper',
    source: 'paper_engine',
    lifecycle: 'ENTRY',
    side: 'Long',
    binanceSide: 'BUY',
    orderType: 'MARKET',
    timeInForce: 'GTC',
    status: 'FILLED',
    price: 93000,
    executedQty: 0.01,
    origQty: 0.01,
    quoteQty: 930,
    commission: 0.93,
    commissionAsset: 'USDT',
    isMaker: false,
    realizedPnlUsdt: null,
    rMultiple: null,
    exitReason: null,
    latencyMs: 12,
    endpoint: 'POST /api/v3/order',
    rationale: 'EMA Stack Long entry',
    timestampMs: 1_760_000_000_000,
    ...overrides,
  };
}

test('computeOrderPerformanceMetrics computes win rate, profit factor, drawdown, and latency percentiles accurately', () => {
  const logs: OrderExecutionLog[] = [
    makeLog({ id: 'e1', orderId: '1', quoteQty: 1000, commission: 1.0, latencyMs: 10 }),
    makeLog({
      id: 'x1',
      orderId: '2',
      lifecycle: 'EXIT',
      binanceSide: 'SELL',
      quoteQty: 1100,
      commission: 1.1,
      isMaker: true,
      realizedPnlUsdt: 100,
      rMultiple: 2.0,
      exitReason: 'TakeProfit2',
      latencyMs: 20,
      timestampMs: 1_760_000_100_000,
    }),
    makeLog({
      id: 'x2',
      orderId: '3',
      symbol: 'ETHUSDT',
      lifecycle: 'EXIT',
      binanceSide: 'SELL',
      quoteQty: 960,
      commission: 0.96,
      realizedPnlUsdt: -40,
      rMultiple: -0.8,
      exitReason: 'StopLoss',
      latencyMs: 80,
      timestampMs: 1_760_000_200_000,
    }),
    makeLog({
      id: 'x3',
      orderId: '4',
      symbol: 'SOLUSDT',
      lifecycle: 'EXIT',
      binanceSide: 'SELL',
      quoteQty: 1060,
      commission: 1.06,
      realizedPnlUsdt: 60,
      rMultiple: 1.2,
      exitReason: 'TrailingStop',
      latencyMs: 40,
      timestampMs: 1_760_000_300_000,
    }),
    makeLog({
      id: 'rej',
      orderId: '5',
      status: 'REJECTED',
      quoteQty: 0,
      commission: 0,
      latencyMs: 120,
      timestampMs: 1_760_000_400_000,
    }),
  ];

  const m = computeOrderPerformanceMetrics(logs);
  assert.equal(m.totalOrders, 5);
  assert.equal(m.filledOrders, 4);
  assert.equal(m.rejectedOrders, 1);
  assert.equal(m.fillRatePct, 80);
  assert.equal(m.exitCount, 3);
  assert.equal(m.winCount, 2);
  assert.equal(m.lossCount, 1);
  assert.ok(Math.abs(m.winRatePct - 66.6666) < 0.01);
  assert.equal(m.winLossRatio, 2);
  assert.equal(m.netRealizedPnlUsdt, 120);
  assert.equal(m.grossProfitUsdt, 160);
  assert.equal(m.grossLossUsdt, 40);
  assert.equal(m.profitFactor, 4);
  assert.ok(Math.abs(m.avgRMultiple - 0.8) < 1e-6);
  assert.equal(m.peakPnlUsdt, 120);
  assert.equal(m.maxDrawdownUsdt, 40);
  assert.equal(m.equityCurve.length, 3);
  assert.equal(m.equityCurve[0].cumulativePnlUsdt, 100);
  assert.equal(m.equityCurve[1].drawdownUsdt, 40);
  assert.equal(m.equityCurve[2].cumulativePnlUsdt, 120);
  assert.equal(m.makerCount, 1);
  assert.equal(m.takerCount, 3);
  assert.equal(m.avgLatencyMs, 54);
  assert.equal(m.p95LatencyMs, 120);
});

test('computeOrderPerformanceMetrics returns Infinity profit factor and win/loss ratio when all exits are profitable', () => {
  const logs = [
    makeLog({
      id: 'w1',
      lifecycle: 'EXIT',
      realizedPnlUsdt: 55,
      rMultiple: 1.5,
    }),
  ];
  const m = computeOrderPerformanceMetrics(logs);
  assert.equal(m.profitFactor, Number.POSITIVE_INFINITY);
  assert.equal(m.winLossRatio, Number.POSITIVE_INFINITY);
});

test('filterOrderLogs enforces strict accountMode isolation, status/symbol filtering, and search query', () => {
  const logs = [
    makeLog({ id: 'p1', accountMode: 'Paper', symbol: 'BTCUSDT', status: 'FILLED', orderId: '101' }),
    makeLog({ id: 'l1', accountMode: 'Live', venue: 'Futures', symbol: 'ETHUSDT', status: 'CANCELED', orderId: '202' }),
  ];

  const liveOnly = filterOrderLogs(logs, {
    accountMode: 'Live',
    venue: 'ALL',
    status: 'ALL',
    symbol: 'ALL',
    query: '',
  });
  assert.equal(liveOnly.length, 1);
  assert.equal(liveOnly[0].id, 'l1');

  const queryMatch = filterOrderLogs(logs, {
    accountMode: 'ALL',
    venue: 'ALL',
    status: 'ALL',
    symbol: 'ALL',
    query: '#202',
  });
  assert.equal(queryMatch.length, 1);
  assert.equal(queryMatch[0].symbol, 'ETHUSDT');

  const symbolSlashMatch = filterOrderLogs(logs, {
    accountMode: 'ALL',
    venue: 'ALL',
    status: 'ALL',
    symbol: 'ALL',
    query: 'btc/usdt',
  });
  assert.equal(symbolSlashMatch.length, 1);
  assert.equal(symbolSlashMatch[0].orderId, '101');
});

test('formatOrderLogsCsv safely escapes commas and neutralizes formula injection', () => {
  const csv = formatOrderLogsCsv([
    makeLog({
      rationale: '=HYPERLINK("http://evil")',
      errorMessage: 'Filter failure: MIN_NOTIONAL, check size',
      symbol: 'BTCUSDT',
    }),
  ]);
  assert.match(csv, /^timestamp_iso,.*,error_message\n/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"Filter failure: MIN_NOTIONAL, check size"/);
});

test('parseUtcDateRangeBounds validates calendar dates and builds inclusive UTC bounds', () => {
  const valid = parseUtcDateRangeBounds('2026-11-10', '2026-11-12');
  assert.equal(valid.startMs, Date.UTC(2026, 10, 10, 0, 0, 0, 0));
  assert.equal(valid.endMs, Date.UTC(2026, 10, 12, 23, 59, 59, 999));
  assert.equal(valid.isInverted, false);

  const inverted = parseUtcDateRangeBounds('2026-11-15', '2026-11-10');
  assert.equal(inverted.isInverted, true);

  const invalidCalendar = parseUtcDateRangeBounds('2026-02-30', 'not-a-date');
  assert.equal(invalidCalendar.startMs, null);
  assert.equal(invalidCalendar.endMs, null);
  assert.equal(invalidCalendar.isInverted, false);
});

test('computeUtcDatePresetRange returns expected UTC ranges for today, 7d, and 30d', () => {
  const refMs = Date.UTC(2026, 10, 18, 4, 30, 0);
  assert.deepEqual(computeUtcDatePresetRange('today', refMs), {
    startDate: '2026-11-18',
    endDate: '2026-11-18',
  });
  assert.deepEqual(computeUtcDatePresetRange('7d', refMs), {
    startDate: '2026-11-12',
    endDate: '2026-11-18',
  });
  assert.deepEqual(computeUtcDatePresetRange('30d', refMs), {
    startDate: '2026-10-20',
    endDate: '2026-11-18',
  });
});

test('filterOrderLogs restricts records to inclusive UTC startDate and endDate bounds', () => {
  const logs = [
    makeLog({ id: 'before', orderId: '1', timestampMs: Date.UTC(2026, 10, 9, 23, 59, 59, 999) }),
    makeLog({ id: 'startEdge', orderId: '2', timestampMs: Date.UTC(2026, 10, 10, 0, 0, 0, 0) }),
    makeLog({ id: 'mid', orderId: '3', timestampMs: Date.UTC(2026, 10, 11, 12, 0, 0, 0) }),
    makeLog({ id: 'endEdge', orderId: '4', timestampMs: Date.UTC(2026, 10, 12, 23, 59, 59, 999) }),
    makeLog({ id: 'after', orderId: '5', timestampMs: Date.UTC(2026, 10, 13, 0, 0, 0, 0) }),
  ];

  const windowed = filterOrderLogs(logs, {
    accountMode: 'ALL',
    venue: 'ALL',
    status: 'ALL',
    symbol: 'ALL',
    query: '',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
  });
  assert.deepEqual(
    windowed.map((l) => l.id),
    ['endEdge', 'mid', 'startEdge']
  );

  const openStartOnly = filterOrderLogs(logs, {
    accountMode: 'ALL',
    venue: 'ALL',
    status: 'ALL',
    symbol: 'ALL',
    query: '',
    startDate: '2026-11-12',
    endDate: '',
  });
  assert.deepEqual(
    openStartOnly.map((l) => l.id),
    ['after', 'endEdge']
  );
});

test('getOrderStatusBadgeMeta maps each OrderExecutionStatus to deterministic label and tone', () => {
  assert.deepEqual(getOrderStatusBadgeMeta('FILLED'), { label: 'FILLED', tone: 'emerald' });
  assert.deepEqual(getOrderStatusBadgeMeta('PARTIALLY_FILLED'), { label: 'PARTIAL', tone: 'amber' });
  assert.deepEqual(getOrderStatusBadgeMeta('NEW'), { label: 'NEW', tone: 'amber' });
  assert.deepEqual(getOrderStatusBadgeMeta('CANCELED'), { label: 'CANCELED', tone: 'slate' });
  assert.deepEqual(getOrderStatusBadgeMeta('EXPIRED'), { label: 'EXPIRED', tone: 'slate' });
  assert.deepEqual(getOrderStatusBadgeMeta('REJECTED'), { label: 'REJECTED', tone: 'rose' });
});
