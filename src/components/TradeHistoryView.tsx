import React, { useEffect, useMemo, useRef, useState } from 'react';
import { escapeCsvCell, fmtPx } from '../engine/formatters';
import {
  BinanceExecutionRecord,
  ExchangeVenue,
} from '../engine/types';
import {
  Code2,
  Copy,
  Check,
  Download,
  RefreshCw,
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';

interface TradeHistoryViewProps {
  executions: BinanceExecutionRecord[];
  activeSymbol: string;
  activeVenue: ExchangeVenue;
  symbols: string[];
  onSelectSymbol?: (symbol: string) => void;
  onSyncLiveTrades?: (symbol: string) => Promise<{
    ok: boolean;
    added: number;
    latencyMs?: number;
    message: string;
  }>;
}

function buildBinanceRestPayload(rec: BinanceExecutionRecord): Record<string, unknown> {
  if (rec.venue === 'Futures') {
    // Official Binance USD-M Futures GET /fapi/v1/userTrades schema
    return {
      symbol: rec.symbol,
      id: rec.tradeId,
      orderId: rec.orderId,
      side: rec.binanceSide,
      price: fmtPx(rec.price),
      qty: rec.executedQty.toFixed(4),
      realizedPnl: (rec.realizedPnlUsdt ?? 0).toFixed(4),
      marginAsset: 'USDT',
      quoteQty: rec.cummulativeQuoteQty.toFixed(2),
      commission: rec.commission.toFixed(4),
      commissionAsset: rec.commissionAsset,
      time: rec.transactTime,
      positionSide: rec.positionSide,
      buyer: rec.binanceSide === 'BUY',
      maker: rec.isMaker,
    };
  }
  // Official Binance Spot GET /api/v3/myTrades schema
  return {
    symbol: rec.symbol,
    id: rec.tradeId,
    orderId: rec.orderId,
    orderListId: rec.orderListId,
    price: fmtPx(rec.price),
    qty: rec.executedQty.toFixed(4),
    quoteQty: rec.cummulativeQuoteQty.toFixed(2),
    commission: rec.commission.toFixed(4),
    commissionAsset: rec.commissionAsset,
    time: rec.transactTime,
    isBuyer: rec.binanceSide === 'BUY',
    isMaker: rec.isMaker,
    isBestMatch: true,
  };
}

function buildBinanceWsPayload(rec: BinanceExecutionRecord): Record<string, unknown> {
  if (rec.venue === 'Futures') {
    // Official Binance USD-M Futures User Data Stream ORDER_TRADE_UPDATE schema
    return {
      e: 'ORDER_TRADE_UPDATE',
      T: rec.transactTime,
      E: rec.transactTime + 2,
      o: {
        s: rec.symbol,
        c: rec.clientOrderId,
        S: rec.binanceSide,
        o: rec.orderType,
        f: rec.timeInForce,
        q: rec.origQty.toFixed(4),
        p: fmtPx(rec.price),
        ap: fmtPx(rec.price),
        x: rec.execType,
        X: rec.orderStatus,
        i: rec.orderId,
        l: rec.executedQty.toFixed(4),
        z: rec.executedQty.toFixed(4),
        L: fmtPx(rec.price),
        n: rec.commission.toFixed(4),
        N: rec.commissionAsset,
        T: rec.transactTime,
        t: rec.tradeId,
        m: rec.isMaker,
        R: rec.lifecycle === 'EXIT',
        ps: rec.positionSide,
        rp: (rec.realizedPnlUsdt ?? 0).toFixed(4),
      },
    };
  }
  // Official Binance Spot User Data Stream executionReport schema
  return {
    e: 'executionReport',
    E: rec.transactTime + 2,
    s: rec.symbol,
    c: rec.clientOrderId,
    S: rec.binanceSide,
    o: rec.orderType,
    f: rec.timeInForce,
    q: rec.origQty.toFixed(4),
    p: fmtPx(rec.price),
    x: rec.execType,
    X: rec.orderStatus,
    r: 'NONE',
    i: rec.orderId,
    l: rec.executedQty.toFixed(4),
    z: rec.executedQty.toFixed(4),
    L: fmtPx(rec.price),
    n: rec.commission.toFixed(4),
    N: rec.commissionAsset,
    T: rec.transactTime,
    t: rec.tradeId,
    g: rec.orderListId,
    m: rec.isMaker,
    O: rec.transactTime - 15,
    Z: rec.cummulativeQuoteQty.toFixed(2),
    Y: rec.cummulativeQuoteQty.toFixed(2),
  };
}

function buildBinanceOrderResponsePayload(rec: BinanceExecutionRecord): Record<string, unknown> {
  if (rec.venue === 'Futures') {
    const isConditionalAlgo =
      rec.orderType === 'TAKE_PROFIT_MARKET' || rec.orderType === 'STOP_MARKET';
    if (isConditionalAlgo) {
      // Official Binance USD-M Futures POST /fapi/v1/algoOrder conditional bracket schema
      return {
        endpoint: 'POST /fapi/v1/algoOrder',
        algoId: rec.orderId,
        clientAlgoId: rec.clientOrderId,
        algoType: 'CONDITIONAL',
        orderType: rec.orderType,
        symbol: rec.symbol,
        side: rec.binanceSide,
        positionSide: rec.positionSide,
        triggerPrice: fmtPx(rec.price),
        closePosition: true,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        algoStatus: rec.orderStatus === 'FILLED' ? 'TRIGGERED' : 'NEW',
        createTime: rec.transactTime,
      };
    }
    // Official Binance USD-M Futures POST /fapi/v1/order (newOrderRespType=RESULT) response schema
    return {
      endpoint: 'POST /fapi/v1/order',
      clientOrderId: rec.clientOrderId,
      cumQty: rec.executedQty.toFixed(4),
      cumQuote: rec.cummulativeQuoteQty.toFixed(2),
      executedQty: rec.executedQty.toFixed(4),
      orderId: rec.orderId,
      avgPrice: fmtPx(rec.price),
      origQty: rec.origQty.toFixed(4),
      price: rec.orderType === 'MARKET' ? '0' : fmtPx(rec.price),
      reduceOnly: rec.lifecycle === 'EXIT',
      side: rec.binanceSide,
      positionSide: rec.positionSide,
      status: rec.orderStatus,
      symbol: rec.symbol,
      timeInForce: rec.timeInForce,
      type: rec.orderType,
      updateTime: rec.transactTime,
    };
  }
  if (rec.orderListId !== -1) {
    // Official Binance Spot POST /api/v3/orderList/oco (above/below Spot OCO legs) response schema
    const tpSide = rec.side === 'Long' ? 'SELL' : 'BUY';
    const tpPx = rec.side === 'Long' ? rec.price * 1.025 : rec.price * 0.975;
    const slPx = rec.side === 'Long' ? rec.price * 0.985 : rec.price * 1.015;
    return {
      endpoint: 'POST /api/v3/orderList/oco',
      orderListId: rec.orderListId,
      contingencyType: 'OCO',
      listStatusType: 'EXEC_STARTED',
      listOrderStatus: 'EXECUTING',
      listClientOrderId: `oco_${rec.clientOrderId}`,
      transactionTime: rec.transactTime,
      symbol: rec.symbol,
      orders: [
        {
          symbol: rec.symbol,
          orderId: rec.orderId + 1,
          clientOrderId: `${rec.clientOrderId}_tp_maker`,
        },
        {
          symbol: rec.symbol,
          orderId: rec.orderId + 2,
          clientOrderId: `${rec.clientOrderId}_sl_limit`,
        },
      ],
      orderReports: [
        {
          symbol: rec.symbol,
          orderId: rec.orderId + 1,
          orderListId: rec.orderListId,
          clientOrderId: `${rec.clientOrderId}_tp_maker`,
          transactTime: rec.transactTime,
          price: fmtPx(tpPx),
          origQty: rec.origQty.toFixed(4),
          executedQty: '0.0000',
          cummulativeQuoteQty: '0.00',
          status: 'NEW',
          type: 'LIMIT_MAKER',
          side: tpSide,
        },
        {
          symbol: rec.symbol,
          orderId: rec.orderId + 2,
          orderListId: rec.orderListId,
          clientOrderId: `${rec.clientOrderId}_sl_limit`,
          transactTime: rec.transactTime,
          price: fmtPx(slPx * 0.998),
          stopPrice: fmtPx(slPx),
          origQty: rec.origQty.toFixed(4),
          executedQty: '0.0000',
          cummulativeQuoteQty: '0.00',
          status: 'NEW',
          timeInForce: 'GTC',
          type: 'STOP_LOSS_LIMIT',
          side: tpSide,
        },
      ],
    };
  }
  // Official Binance Spot POST /api/v3/order (newOrderRespType=FULL) response schema
  return {
    endpoint: 'POST /api/v3/order',
    symbol: rec.symbol,
    orderId: rec.orderId,
    orderListId: -1,
    clientOrderId: rec.clientOrderId,
    transactTime: rec.transactTime,
    price: rec.orderType === 'MARKET' ? '0.00000000' : fmtPx(rec.price),
    origQty: rec.origQty.toFixed(4),
    executedQty: rec.executedQty.toFixed(4),
    cummulativeQuoteQty: rec.cummulativeQuoteQty.toFixed(2),
    status: rec.orderStatus,
    timeInForce: rec.timeInForce,
    type: rec.orderType,
    side: rec.binanceSide,
    workingTime: rec.transactTime,
    selfTradePreventionMode: 'EXPIRE_MAKER',
    fills: [
      {
        price: fmtPx(rec.price),
        qty: rec.executedQty.toFixed(4),
        commission: rec.commission.toFixed(4),
        commissionAsset: rec.commissionAsset,
        tradeId: rec.tradeId,
      },
    ],
  };
}

export const TradeHistoryView: React.FC<TradeHistoryViewProps> = ({
  executions,
  activeSymbol,
  activeVenue,
  symbols,
  onSelectSymbol,
  onSyncLiveTrades,
}) => {
  const [lifecycleFilter, setLifecycleFilter] = useState<'ALL' | 'ENTRY' | 'EXIT'>('ALL');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [symbolFilter, setSymbolFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [payloadSchemaMode, setPayloadSchemaMode] = useState<'REST' | 'ORDER' | 'WS'>('REST');
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);
  const [syncBanner, setSyncBanner] = useState<{
    ok: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);

  const filteredExecutions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return executions.filter((rec) => {
      if (lifecycleFilter !== 'ALL' && rec.lifecycle !== lifecycleFilter) return false;
      if (sideFilter !== 'ALL' && rec.binanceSide !== sideFilter) return false;
      if (symbolFilter !== 'ALL' && rec.symbol !== symbolFilter) return false;
      if (q) {
        const hay = [
          rec.symbol,
          String(rec.tradeId),
          String(rec.orderId),
          rec.clientOrderId,
          rec.orderType,
          rec.uiOrderType,
          rec.exitReason ?? 'ENTRY',
          rec.strategyRationale,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [executions, lifecycleFilter, sideFilter, symbolFilter, searchQuery]);

  const metrics = useMemo(() => {
    const entryCount = filteredExecutions.filter((r) => r.lifecycle === 'ENTRY').length;
    const exitRecords = filteredExecutions.filter((r) => r.lifecycle === 'EXIT');
    const exitCount = exitRecords.length;
    const totalVolumeUsdt = filteredExecutions.reduce((sum, r) => sum + r.cummulativeQuoteQty, 0);
    const totalCommissionUsdt = filteredExecutions.reduce((sum, r) => sum + r.commission, 0);
    const makerCount = filteredExecutions.filter((r) => r.isMaker).length;
    const netRealizedPnl = exitRecords.reduce((sum, r) => sum + (r.realizedPnlUsdt ?? 0), 0);
    const winningExits = exitRecords.filter((r) => (r.realizedPnlUsdt ?? 0) > 0).length;
    const exitWinRate = exitCount > 0 ? (winningExits / exitCount) * 100 : 0;

    return {
      totalCount: filteredExecutions.length,
      entryCount,
      exitCount,
      totalVolumeUsdt,
      totalCommissionUsdt,
      makerCount,
      takerCount: filteredExecutions.length - makerCount,
      netRealizedPnl,
      exitWinRate,
    };
  }, [filteredExecutions]);

  const inspectedRecord = useMemo(() => {
    if (!selectedRecordId) return null;
    return executions.find((r) => r.id === selectedRecordId) ?? null;
  }, [executions, selectedRecordId]);

  const handleSyncClick = async () => {
    if (!onSyncLiveTrades || syncing) return;
    setSyncing(true);
    try {
      const targetSym = symbolFilter === 'ALL' ? activeSymbol : symbolFilter;
      const res = await onSyncLiveTrades(targetSym);
      setSyncBanner({
        ok: res.ok,
        message: res.message,
        latencyMs: res.latencyMs,
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'transactTime',
      'isoTime',
      'tradeId',
      'orderId',
      'orderListId',
      'clientOrderId',
      'symbol',
      'venue',
      'accountMode',
      'lifecycle',
      'binanceSide',
      'positionSide',
      'orderType',
      'orderStatus',
      'timeInForce',
      'price',
      'entryPrice',
      'executedQty',
      'cummulativeQuoteQty',
      'commission',
      'commissionAsset',
      'isMaker',
      'realizedPnlUsdt',
      'rMultiple',
      'exitReason',
    ];
    const rows = filteredExecutions.map((r) => [
      r.transactTime,
      new Date(r.transactTime).toISOString(),
      r.tradeId,
      r.orderId,
      r.orderListId,
      r.clientOrderId,
      r.symbol,
      r.venue,
      r.accountMode,
      r.lifecycle,
      r.binanceSide,
      r.positionSide,
      r.orderType,
      r.orderStatus,
      r.timeInForce,
      fmtPx(r.price),
      fmtPx(r.entryPrice),
      r.executedQty.toFixed(5),
      r.cummulativeQuoteQty.toFixed(2),
      r.commission.toFixed(4),
      r.commissionAsset,
      r.isMaker,
      r.realizedPnlUsdt !== null ? r.realizedPnlUsdt.toFixed(2) : '',
      r.rMultiple !== null ? r.rMultiple.toFixed(2) : '',
      r.exitReason ?? 'ENTRY_FILL',
    ]);
    const csvContent = [
      headers.map(escapeCsvCell).join(','),
      ...rows.map((row) => row.map((cell) => escapeCsvCell(typeof cell === 'boolean' ? String(cell) : cell)).join(',')),
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `binance-execution-history-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyJson = (rec: BinanceExecutionRecord) => {
    const payload =
      payloadSchemaMode === 'REST'
        ? buildBinanceRestPayload(rec)
        : payloadSchemaMode === 'ORDER'
          ? buildBinanceOrderResponsePayload(rec)
          : buildBinanceWsPayload(rec);
    try {
      void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
      setCopiedPayload(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      // Clipboard API unavailable in non-secure context
    }
  };

  return (
    <div className="bg-[#11151E] border border-[#1C2230] rounded-sm overflow-hidden">
      {/* Top Header & Official Binance Docs Compliance Bar */}
      <div className="px-3.5 py-2.5 border-b border-[#1C2230] bg-[#0B0E14] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#F1F5F9]">
            Trade &amp; Execution Fill Ledger
          </span>
          <span className="text-[11px] font-mono text-[#64748B]">
            · {activeVenue === 'Futures' ? 'GET /fapi/v1/userTrades · ORDER_TRADE_UPDATE' : 'GET /api/v3/myTrades · executionReport'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {onSyncLiveTrades && (
            <button
              onClick={handleSyncClick}
              disabled={syncing}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-mono font-semibold border border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#60A5FA] hover:bg-[#3B82F6]/20 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              title="Query signed Binance REST myTrades / userTrades endpoint"
            >
              <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
              {syncing
                ? 'Syncing...'
                : `Sync Binance ${activeVenue === 'Futures' ? 'userTrades' : 'myTrades'}`}
            </button>
          )}
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-mono text-[#94A3B8] hover:text-[#F1F5F9] bg-[#161B26] hover:bg-[#1C2230] border border-[#1C2230] transition-colors whitespace-nowrap shrink-0"
            title="Export filtered execution fills to CSV"
          >
            <Download className="w-3 h-3" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Optional Sync Feedback Banner */}
      {syncBanner && (
        <div
          className={`px-3.5 py-1.5 text-[11px] font-mono border-b flex items-center justify-between gap-2 ${
            syncBanner.ok
              ? 'bg-[#10B981]/10 border-[#10B981]/30 text-[#10B981]'
              : 'bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B]'
          }`}
        >
          <span>
            {syncBanner.message}
            {typeof syncBanner.latencyMs === 'number' ? ` · RTT ${syncBanner.latencyMs}ms` : ''}
          </span>
          <button
            onClick={() => setSyncBanner(null)}
            className="text-[10px] underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 4-Card KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-[#1C2230] border-b border-[#1C2230] bg-[#0E121A]">
        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
            Total Fills (execType: TRADE)
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span className="text-sm font-mono font-bold tabular-nums text-[#F1F5F9]">
              {metrics.totalCount} Fills
            </span>
            <span className="text-[11px] font-mono tabular-nums text-[#94A3B8]">
              {metrics.entryCount} Entries · {metrics.exitCount} Exits
            </span>
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
            Cum. Quote Volume (Z / quoteQty)
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span className="text-sm font-mono font-bold tabular-nums text-[#F1F5F9]">
              ${metrics.totalVolumeUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="text-[11px] font-mono tabular-nums text-[#94A3B8]">
              {metrics.makerCount} Maker · {metrics.takerCount} Taker
            </span>
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
            Realized Exit PnL (rp / realizedPnl)
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span
              className={`text-sm font-mono font-bold tabular-nums ${
                metrics.netRealizedPnl >= 0 ? 'text-[#10B981]' : 'text-[#F43F5E]'
              }`}
            >
              {metrics.netRealizedPnl >= 0 ? '+' : ''}${metrics.netRealizedPnl.toFixed(2)} USDT
            </span>
            <span className="text-[11px] font-mono tabular-nums text-[#94A3B8]">
              Win Rate {metrics.exitWinRate.toFixed(0)}%
            </span>
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
            Total Fees (commission / n)
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span className="text-sm font-mono font-bold tabular-nums text-[#F59E0B]">
              ${metrics.totalCommissionUsdt.toFixed(4)} USDT
            </span>
            <span className="text-[11px] font-mono text-[#64748B]">
              {activeVenue === 'Futures' ? '2/4 bps' : '7.5/10 bps'}
            </span>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-3.5 py-2 border-b border-[#1C2230] bg-[#11151E] flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Lifecycle Filter: ALL / ENTRY / EXIT */}
          <div className="flex items-center bg-[#0B0E14] p-0.5 rounded-sm border border-[#1C2230]">
            {(['ALL', 'ENTRY', 'EXIT'] as const).map((lf) => (
              <button
                key={lf}
                onClick={() => setLifecycleFilter(lf)}
                className={`px-2 py-0.5 text-[11px] font-mono rounded-sm transition-colors whitespace-nowrap shrink-0 ${
                  lifecycleFilter === lf
                    ? 'bg-[#161B26] text-[#F1F5F9] font-semibold'
                    : 'text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                {lf === 'ALL' ? 'All Fills' : lf === 'ENTRY' ? 'Entries Only' : 'Exits Only'}
              </button>
            ))}
          </div>

          {/* Side Filter: ALL / BUY / SELL */}
          <div className="flex items-center bg-[#0B0E14] p-0.5 rounded-sm border border-[#1C2230]">
            {(['ALL', 'BUY', 'SELL'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSideFilter(s)}
                className={`px-2 py-0.5 text-[11px] font-mono rounded-sm transition-colors whitespace-nowrap shrink-0 ${
                  sideFilter === s
                    ? s === 'BUY'
                      ? 'bg-[#10B981]/20 text-[#10B981] font-semibold'
                      : s === 'SELL'
                        ? 'bg-[#F43F5E]/20 text-[#F43F5E] font-semibold'
                        : 'bg-[#161B26] text-[#F1F5F9] font-semibold'
                    : 'text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Symbol Filter */}
          <div className="flex items-center gap-1.5 bg-[#0B0E14] px-2 py-1 rounded-sm border border-[#1C2230]">
            <Filter className="w-3 h-3 text-[#64748B]" />
            <select
              aria-label="Filter trade history by symbol"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              className="bg-transparent text-[11px] font-mono text-[#F1F5F9] focus:outline-none"
            >
              <option value="ALL" className="bg-[#0B0E14]">
                All Pairs ({symbols.length})
              </option>
              {symbols.map((sym) => (
                <option key={sym} value={sym} className="bg-[#0B0E14]">
                  {sym}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative min-w-[210px] flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tradeId, orderId, reason..."
            className="w-full bg-[#0B0E14] border border-[#1C2230] rounded-sm pl-8 pr-2.5 py-1 text-[11px] font-mono text-[#F1F5F9] placeholder-[#64748B] focus:outline-none focus:border-[#3B82F6]"
          />
        </div>
      </div>

      {/* Execution Table */}
      <div className="overflow-x-auto max-h-[340px] overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#1C2230] text-[10px] font-mono uppercase text-[#64748B] bg-[#0B0E14] sticky top-0 z-10">
              <th className="py-2 px-3">Time / Trade &amp; Order ID</th>
              <th className="py-2 px-3">Pair / Venue</th>
              <th className="py-2 px-3">Lifecycle / Side</th>
              <th className="py-2 px-3">Type / Status</th>
              <th className="py-2 px-3 text-right">Fill Price</th>
              <th className="py-2 px-3 text-right">Exec Qty / Quote</th>
              <th className="py-2 px-3 text-right">Role / Fee</th>
              <th className="py-2 px-3 text-right">Realized PnL / Reason</th>
              <th className="py-2 px-3 text-right">Binance JSON</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1C2230] text-xs font-mono">
            {filteredExecutions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-[#64748B]">
                  No filled orders or exits match the current filter criteria.
                </td>
              </tr>
            ) : (
              filteredExecutions.map((rec) => {
                const isSelected = rec.id === selectedRecordId;
                const isEntry = rec.lifecycle === 'ENTRY';
                const hasPnl = rec.realizedPnlUsdt !== null;
                const pnlPositive = (rec.realizedPnlUsdt ?? 0) >= 0;

                return (
                  <tr
                    key={rec.id}
                    className={`transition-colors ${
                      isSelected ? 'bg-[#161B26]' : 'hover:bg-[#161B26]/60'
                    }`}
                  >
                    {/* Time + TradeId + OrderId */}
                    <td className="py-2 px-3 tabular-nums whitespace-nowrap">
                      <div className="text-[#F1F5F9]">
                        {new Date(rec.transactTime).toLocaleTimeString([], {
                          hour12: false,
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </div>
                      <div className="text-[10px] text-[#64748B]">
                        t:#{rec.tradeId} · i:#{rec.orderId}
                        {rec.orderListId !== -1 ? ` · oco:#${rec.orderListId}` : ''}
                      </div>
                    </td>

                    {/* Pair + Venue + Mode */}
                    <td className="py-2 px-3 whitespace-nowrap">
                      <button
                        onClick={() => onSelectSymbol?.(rec.symbol)}
                        className="font-semibold text-[#F1F5F9] hover:text-[#60A5FA] transition-colors"
                      >
                        {rec.symbol}
                      </button>
                      <div className="text-[10px] text-[#64748B]">
                        {rec.venue}
                        {rec.venue === 'Futures' ? ` ${rec.leverage}x` : ''} · {rec.accountMode}
                      </div>
                    </td>

                    {/* Lifecycle + Binance Side + Position Direction */}
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[10px] font-semibold tracking-wider uppercase ${
                            isEntry ? 'text-[#60A5FA]' : 'text-[#A855F7]'
                          }`}
                        >
                          {rec.lifecycle}
                        </span>
                        <span className="text-[#64748B]">·</span>
                        <span
                          className={`inline-flex items-center gap-0.5 font-semibold ${
                            rec.binanceSide === 'BUY' ? 'text-[#10B981]' : 'text-[#F43F5E]'
                          }`}
                        >
                          {rec.binanceSide === 'BUY' ? (
                            <ArrowUpRight className="w-3 h-3" />
                          ) : (
                            <ArrowDownRight className="w-3 h-3" />
                          )}
                          {rec.binanceSide}
                        </span>
                      </div>
                      <div className="text-[10px] text-[#64748B]">
                        {rec.side} ({rec.positionSide})
                      </div>
                    </td>

                    {/* Order Type + TimeInForce + Status */}
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="text-[#F1F5F9]">
                        {rec.orderType}{' '}
                        <span className="text-[10px] text-[#64748B]">({rec.timeInForce})</span>
                      </div>
                      <div
                        className={`text-[10px] ${
                          rec.orderStatus === 'PARTIALLY_FILLED'
                            ? 'text-[#F59E0B]'
                            : 'text-[#10B981]'
                        }`}
                      >
                        {rec.orderStatus}
                      </div>
                    </td>

                    {/* Fill Price + Entry Ref */}
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                      <div className="text-[#F1F5F9] font-semibold">
                        ${fmtPx(rec.price)}
                      </div>
                      {!isEntry && (
                        <div className="text-[10px] text-[#64748B]">
                          Entry ${fmtPx(rec.entryPrice)}
                        </div>
                      )}
                    </td>

                    {/* Executed Qty + Cumulative Quote Qty */}
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                      <div className="text-[#F1F5F9]">{rec.executedQty.toFixed(4)}</div>
                      <div className="text-[10px] text-[#64748B]">
                        ${rec.cummulativeQuoteQty.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
                      </div>
                    </td>

                    {/* Maker/Taker Role + Commission */}
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                      <div
                        className={`text-[11px] font-semibold ${
                          rec.isMaker ? 'text-[#38BDF8]' : 'text-[#94A3B8]'
                        }`}
                      >
                        {rec.isMaker ? 'MAKER' : 'TAKER'}
                      </div>
                      <div className="text-[10px] text-[#64748B]">
                        ${rec.commission.toFixed(4)} {rec.commissionAsset}
                      </div>
                    </td>

                    {/* Realized PnL + Exit Reason */}
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                      {hasPnl ? (
                        <>
                          <div
                            className={`font-semibold ${
                              pnlPositive ? 'text-[#10B981]' : 'text-[#F43F5E]'
                            }`}
                          >
                            {pnlPositive ? '+' : ''}${rec.realizedPnlUsdt!.toFixed(2)}
                            {rec.rMultiple !== null ? (
                              <span className="text-[10px] ml-1 opacity-80">
                                ({rec.rMultiple >= 0 ? '+' : ''}
                                {rec.rMultiple.toFixed(2)}R)
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-[#94A3B8]">
                            {rec.exitReason ?? 'ExitFill'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-[#64748B]">—</div>
                          <div className="text-[10px] text-[#60A5FA]">OPENING FILL</div>
                        </>
                      )}
                    </td>

                    {/* Inspect JSON Button */}
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <button
                        onClick={() =>
                          setSelectedRecordId(isSelected ? null : rec.id)
                        }
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono border transition-colors ${
                          isSelected
                            ? 'bg-[#3B82F6]/20 border-[#3B82F6] text-[#60A5FA]'
                            : 'bg-[#0B0E14] border-[#1C2230] text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        <Code2 className="w-3 h-3" />
                        {isSelected ? 'Hide JSON' : 'Inspect'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Expandable Binance Official Payload Inspector */}
      {inspectedRecord && (
        <div className="border-t border-[#1C2230] bg-[#0B0E14] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-semibold text-[#F1F5F9]">
                Binance Execution Payload Inspector · #{inspectedRecord.tradeId} ({inspectedRecord.symbol})
              </span>
              <span className="text-[11px] font-mono text-[#64748B]">
                · {inspectedRecord.strategyRationale}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center bg-[#11151E] p-0.5 rounded-sm border border-[#1C2230]">
                <button
                  onClick={() => setPayloadSchemaMode('REST')}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded-sm transition-colors ${
                    payloadSchemaMode === 'REST'
                      ? 'bg-[#3B82F6]/20 text-[#60A5FA] font-semibold'
                      : 'text-[#64748B] hover:text-[#94A3B8]'
                  }`}
                >
                  REST ({inspectedRecord.venue === 'Futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades'})
                </button>
                <button
                  onClick={() => setPayloadSchemaMode('ORDER')}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded-sm transition-colors ${
                    payloadSchemaMode === 'ORDER'
                      ? 'bg-[#3B82F6]/20 text-[#60A5FA] font-semibold'
                      : 'text-[#64748B] hover:text-[#94A3B8]'
                  }`}
                >
                  ORDER (
                  {inspectedRecord.venue === 'Futures'
                    ? inspectedRecord.orderType === 'TAKE_PROFIT_MARKET' ||
                      inspectedRecord.orderType === 'STOP_MARKET'
                      ? '/fapi/v1/algoOrder'
                      : '/fapi/v1/order'
                    : inspectedRecord.orderListId !== -1
                      ? '/api/v3/orderList/oco'
                      : '/api/v3/order'}
                  )
                </button>
                <button
                  onClick={() => setPayloadSchemaMode('WS')}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded-sm transition-colors ${
                    payloadSchemaMode === 'WS'
                      ? 'bg-[#3B82F6]/20 text-[#60A5FA] font-semibold'
                      : 'text-[#64748B] hover:text-[#94A3B8]'
                  }`}
                >
                  WS ({inspectedRecord.venue === 'Futures' ? 'ORDER_TRADE_UPDATE' : 'executionReport'})
                </button>
              </div>

              <button
                onClick={() => handleCopyJson(inspectedRecord)}
                className="flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono bg-[#161B26] hover:bg-[#1C2230] text-[#94A3B8] hover:text-[#F1F5F9] border border-[#1C2230] transition-colors"
              >
                {copiedPayload ? (
                  <>
                    <Check className="w-3 h-3 text-[#10B981]" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy JSON
                  </>
                )}
              </button>
            </div>
          </div>

          <pre className="p-3 rounded-sm bg-[#07090D] border border-[#1C2230] text-[11px] font-mono text-[#E2E8F0] overflow-x-auto leading-relaxed">
            {JSON.stringify(
              payloadSchemaMode === 'REST'
                ? buildBinanceRestPayload(inspectedRecord)
                : payloadSchemaMode === 'ORDER'
                  ? buildBinanceOrderResponsePayload(inspectedRecord)
                  : buildBinanceWsPayload(inspectedRecord),
              null,
              2
            )}
          </pre>
        </div>
      )}
    </div>
  );
};
