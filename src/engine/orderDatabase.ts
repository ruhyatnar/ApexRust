import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type {
  ExchangeVenue,
  ExecutionAccountMode,
  ExitReason,
  OrderDatabaseSummary,
  OrderExecutionLog,
  OrderExecutionStatus,
  SymbolSyncWatermark,
  SyncLookbackPreset,
} from './types';

const requireModule = createRequire(import.meta.url);

interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

function tryOpenNodeSqlite(dbPath: string): SqliteDatabaseLike | null {
  try {
    const mod = requireModule('node:sqlite') as {
      DatabaseSync?: new (file: string) => SqliteDatabaseLike;
    };
    if (typeof mod?.DatabaseSync === 'function') {
      const db = new mod.DatabaseSync(dbPath);
      // Configure busy_timeout BEFORE switching journal_mode so startup WAL lock never triggers SQLITE_BUSY
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      return db;
    }
  } catch {
    // Fallback to JSONL/JSON engine when running on Node < 22.5
  }
  return null;
}

interface OrderDatabaseOptions {
  dbPath?: string;
  legacyJsonPath?: string;
  maxLiveQuota?: number;
  maxPaperQuota?: number;
  seedInitialPaperLogs?: () => OrderExecutionLog[];
  /** Drop previously seeded demo rows (default: false so the caller stays explicit). */
  purgeDemoLogs?: boolean;
}

/** Seeded showcase rows are identified by the flag or their legacy id prefix. */
export function isDemoOrderLog(log: OrderExecutionLog): boolean {
  return log.demo === true || log.id.startsWith('paper-seed-');
}

function normalizeLog(item: OrderExecutionLog): OrderExecutionLog {
  const ts =
    typeof item.timestampMs === 'number' && Number.isFinite(item.timestampMs)
      ? Math.round(item.timestampMs)
      : Date.now();
  const orderTimeMs =
    typeof item.orderTimeMs === 'number' && Number.isFinite(item.orderTimeMs) && item.orderTimeMs > 0
      ? Math.round(item.orderTimeMs)
      : ts;
  const updateTimeMs =
    typeof item.updateTimeMs === 'number' && Number.isFinite(item.updateTimeMs) && item.updateTimeMs > 0
      ? Math.round(item.updateTimeMs)
      : ts;
  const price = Number.isFinite(Number(item.price)) ? Number(item.price) : 0;
  const executedQty = Number.isFinite(Number(item.executedQty)) ? Number(item.executedQty) : 0;
  const origQty = Number.isFinite(Number(item.origQty)) ? Number(item.origQty) : executedQty;
  const quoteQty = Number.isFinite(Number(item.quoteQty))
    ? Number(item.quoteQty)
    : price * executedQty;
  const avgPriceRaw = Number(item.avgPrice);
  const avgPrice =
    Number.isFinite(avgPriceRaw) && avgPriceRaw > 0
      ? avgPriceRaw
      : executedQty > 0 && quoteQty > 0
        ? quoteQty / executedQty
        : price;
  const cleanSym =
    String(item.symbol ?? 'BTCUSDT')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '') || 'BTCUSDT';

  return {
    ...item,
    orderId: String(item.orderId ?? '').trim() || String(ts),
    clientOrderId: String(item.clientOrderId ?? '').trim() || `apex_${ts}`,
    symbol: cleanSym,
    venue: String(item.venue ?? '').trim().toLowerCase() === 'futures' ? 'Futures' : 'Spot',
    environment: item.environment === 'Production' ? 'Production' : 'Testnet',
    accountMode: item.accountMode === 'Live' ? 'Live' : 'Paper',
    source:
      item.source === 'binance_all_orders'
        ? 'binance_all_orders'
        : item.source === 'live_proxy'
          ? 'live_proxy'
          : 'paper_engine',
    lifecycle:
      item.lifecycle === 'EXIT' || item.lifecycle === 'CANCEL' || item.lifecycle === 'PREFLIGHT'
        ? item.lifecycle
        : 'ENTRY',
    side: item.side === 'Short' ? 'Short' : 'Long',
    binanceSide: item.binanceSide === 'SELL' ? 'SELL' : 'BUY',
    positionSide:
      item.positionSide === 'LONG' || item.positionSide === 'SHORT' ? item.positionSide : 'BOTH',
    orderType: String(item.orderType ?? 'MARKET').toUpperCase(),
    origType: String(item.origType ?? item.orderType ?? 'MARKET').toUpperCase(),
    timeInForce: String(item.timeInForce ?? 'GTC').toUpperCase(),
    status: (item.status ?? 'FILLED') as OrderExecutionStatus,
    price,
    avgPrice,
    stopPrice: Number.isFinite(Number(item.stopPrice)) ? Number(item.stopPrice) : 0,
    activatePrice:
      item.activatePrice !== undefined && item.activatePrice !== null && Number.isFinite(Number(item.activatePrice))
        ? Number(item.activatePrice)
        : null,
    priceRate:
      item.priceRate !== undefined && item.priceRate !== null && Number.isFinite(Number(item.priceRate))
        ? Number(item.priceRate)
        : null,
    executedQty,
    origQty,
    quoteQty,
    commission: Number.isFinite(Number(item.commission)) ? Number(item.commission) : 0,
    commissionAsset: String(item.commissionAsset ?? 'USDT').trim() || 'USDT',
    isMaker: Boolean(item.isMaker),
    reduceOnly: Boolean(item.reduceOnly),
    closePosition: Boolean(item.closePosition),
    priceProtect: Boolean(item.priceProtect),
    workingType:
      item.workingType === 'CONTRACT_PRICE'
        ? 'CONTRACT_PRICE'
        : item.workingType === 'MARK_PRICE' || item.venue === 'Futures'
          ? 'MARK_PRICE'
          : undefined,
    selfTradePreventionMode: String(item.selfTradePreventionMode ?? 'NONE').toUpperCase(),
    realizedPnlUsdt:
      item.realizedPnlUsdt !== null &&
      item.realizedPnlUsdt !== undefined &&
      Number.isFinite(Number(item.realizedPnlUsdt))
        ? Number(item.realizedPnlUsdt)
        : null,
    rMultiple:
      item.rMultiple !== null &&
      item.rMultiple !== undefined &&
      Number.isFinite(Number(item.rMultiple))
        ? Number(item.rMultiple)
        : null,
    exitReason: item.exitReason ?? null,
    latencyMs:
      item.latencyMs !== null &&
      item.latencyMs !== undefined &&
      Number.isFinite(Number(item.latencyMs))
        ? Math.round(Number(item.latencyMs))
        : null,
    endpoint: String(item.endpoint ?? 'POST /api/v3/order'),
    rationale: String(item.rationale ?? ''),
    errorMessage: item.errorMessage,
    orderTimeMs,
    updateTimeMs,
    workingTimeMs:
      item.workingTimeMs !== undefined &&
      item.workingTimeMs !== null &&
      Number.isFinite(Number(item.workingTimeMs))
        ? Math.round(Number(item.workingTimeMs))
        : null,
    timestampMs: ts,
  };
}

function mergeOrderLogRecords(prev: OrderExecutionLog, incoming: OrderExecutionLog): OrderExecutionLog {
  const fromClientLive = incoming.id.startsWith('client-live-') && prev.source === 'live_proxy';
  const fromBinanceSync = incoming.source === 'binance_all_orders' && prev.source === 'live_proxy';
  return normalizeLog({
    ...prev,
    ...incoming,
    id: prev.id,
    source: fromClientLive || fromBinanceSync ? prev.source : incoming.source,
    latencyMs:
      fromClientLive || fromBinanceSync
        ? prev.latencyMs ?? incoming.latencyMs
        : incoming.latencyMs ?? prev.latencyMs,
    endpoint: fromClientLive ? prev.endpoint : incoming.endpoint || prev.endpoint,
    rationale:
      fromBinanceSync && prev.rationale && !prev.rationale.startsWith('Synced from Binance')
        ? prev.rationale
        : incoming.rationale || prev.rationale,
    realizedPnlUsdt: incoming.realizedPnlUsdt ?? prev.realizedPnlUsdt,
    rMultiple: incoming.rMultiple ?? prev.rMultiple,
    exitReason: incoming.exitReason ?? prev.exitReason,
    commission: incoming.commission > 0 ? incoming.commission : prev.commission,
    commissionAsset:
      incoming.commission > 0 ? incoming.commissionAsset : prev.commissionAsset || incoming.commissionAsset,
    algoId: incoming.algoId ?? prev.algoId,
    algoOrderIds: incoming.algoOrderIds ?? prev.algoOrderIds,
    orderListId: incoming.orderListId ?? prev.orderListId,
    orderTimeMs: prev.orderTimeMs ?? incoming.orderTimeMs,
    updateTimeMs: Math.max(prev.updateTimeMs ?? 0, incoming.updateTimeMs ?? incoming.timestampMs),
    timestampMs: Math.max(prev.timestampMs, incoming.timestampMs),
  });
}

function compositeKeyOf(item: OrderExecutionLog): string {
  return `${item.accountMode}:${item.environment}:${item.venue}:${item.symbol}:${item.orderId}:${item.lifecycle}`;
}

export class OrderHistoryDatabase {
  private readonly dbPath: string;
  private readonly legacyJsonPath: string;
  private readonly maxLiveQuota: number;
  private readonly maxPaperQuota: number;
  private readonly sqlite: SqliteDatabaseLike | null;
  private logs: OrderExecutionLog[] = [];
  private watermarks = new Map<string, SymbolSyncWatermark>();
  private lastUpdatedAtMs = Date.now();
  private lastSqliteDataVersion = -1;

  constructor(options: OrderDatabaseOptions = {}) {
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), '.apexrust-orders.sqlite');
    this.legacyJsonPath =
      options.legacyJsonPath ?? path.resolve(process.cwd(), '.apexrust-order-logs.json');
    this.maxLiveQuota = Math.max(100, options.maxLiveQuota ?? 5000);
    this.maxPaperQuota = Math.max(100, options.maxPaperQuota ?? 1000);
    this.sqlite = tryOpenNodeSqlite(this.dbPath);

    if (this.sqlite) {
      this.initSqliteSchema();
      this.loadFromSqlite();
    } else {
      this.loadFromFallbackFile();
    }

    // Migrate legacy .apexrust-order-logs.json if DB is empty and legacy file exists
    if (this.logs.length === 0 && fs.existsSync(this.legacyJsonPath)) {
      try {
        const raw = fs.readFileSync(this.legacyJsonPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(
            (x): x is OrderExecutionLog =>
              typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string'
          );
          if (valid.length > 0) {
            this.upsertLogs(valid);
          }
        }
      } catch {
        // Ignore corrupt legacy file
      }
    }

    if (options.purgeDemoLogs) {
      this.purgeDemoLogs();
    }

    // Demo rows are opt-in only; they must never be fabricated in a live ledger.
    if (this.logs.length === 0 && options.seedInitialPaperLogs) {
      this.upsertLogs(options.seedInitialPaperLogs());
    }
  }

  private purgeDemoLogs(): void {
    const demoIds = this.logs.filter(isDemoOrderLog).map((log) => log.id);
    if (demoIds.length === 0) return;
    this.logs = this.logs.filter((log) => !isDemoOrderLog(log));
    this.lastUpdatedAtMs = Date.now();
    if (!this.sqlite) {
      this.persistAll();
      return;
    }
    try {
      this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION;');
      const stmt = this.sqlite.prepare('DELETE FROM order_history WHERE id = ?');
      for (const id of demoIds) stmt.run(id);
      this.sqlite.exec('COMMIT;');
    } catch {
      try {
        this.sqlite.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error
      }
    }
  }

  private initSqliteSchema(): void {
    if (!this.sqlite) return;
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS order_history (
        id TEXT PRIMARY KEY,
        composite_key TEXT NOT NULL UNIQUE,
        account_mode TEXT NOT NULL,
        venue TEXT NOT NULL,
        environment TEXT NOT NULL,
        symbol TEXT NOT NULL,
        order_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_order_history_query
        ON order_history (account_mode, venue, environment, symbol, status, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_order_history_ts
        ON order_history (timestamp_ms DESC);
      CREATE TABLE IF NOT EXISTS sync_watermarks (
        key TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        venue TEXT NOT NULL,
        environment TEXT NOT NULL,
        last_synced_at_ms INTEGER NOT NULL,
        oldest_synced_start_ms INTEGER NOT NULL,
        last_lookback TEXT NOT NULL,
        last_synced_count INTEGER NOT NULL
      );
    `);
  }

  private readSqliteDataVersion(): number {
    if (!this.sqlite) return -1;
    try {
      const row = this.sqlite.prepare('PRAGMA data_version').get();
      if (row && row.data_version !== undefined) {
        return Number(row.data_version);
      }
    } catch {
      // Ignore pragma error
    }
    return -1;
  }

  private syncIfExternallyModified(): void {
    if (!this.sqlite) return;
    const ver = this.readSqliteDataVersion();
    if (ver !== -1 && ver !== this.lastSqliteDataVersion) {
      this.loadFromSqlite();
    }
  }

  private loadFromSqlite(): void {
    if (!this.sqlite) return;
    try {
      const rows = this.sqlite
        .prepare('SELECT payload_json FROM order_history ORDER BY timestamp_ms DESC')
        .all();
      const loaded: OrderExecutionLog[] = [];
      for (const r of rows) {
        try {
          const parsed = JSON.parse(String(r.payload_json ?? '')) as OrderExecutionLog;
          if (parsed && typeof parsed.id === 'string') {
            loaded.push(normalizeLog(parsed));
          }
        } catch {
          // Ignore malformed row
        }
      }
      this.logs = loaded;

      this.watermarks.clear();
      const wmRows = this.sqlite.prepare('SELECT * FROM sync_watermarks').all();
      for (const w of wmRows) {
        const key = String(w.key ?? '');
        if (!key) continue;
        this.watermarks.set(key, {
          key,
          symbol: String(w.symbol ?? ''),
          venue: w.venue === 'Futures' ? 'Futures' : 'Spot',
          environment: w.environment === 'Production' ? 'Production' : 'Testnet',
          lastSyncedAtMs: Number(w.last_synced_at_ms ?? 0),
          oldestSyncedStartMs: Number(w.oldest_synced_start_ms ?? 0),
          lastLookback: (String(w.last_lookback ?? '7d') as SyncLookbackPreset) || '7d',
          lastSyncedCount: Number(w.last_synced_count ?? 0),
        });
      }
      this.lastSqliteDataVersion = this.readSqliteDataVersion();
    } catch {
      this.logs = [];
    }
  }

  private fallbackJsonPath(): string {
    return this.dbPath.endsWith('.json') ? this.dbPath : `${this.dbPath}.json`;
  }

  private loadFromFallbackFile(): void {
    const fpath = this.fallbackJsonPath();
    if (!fs.existsSync(fpath)) return;
    try {
      const raw = fs.readFileSync(fpath, 'utf8');
      const parsed = JSON.parse(raw) as {
        logs?: OrderExecutionLog[];
        watermarks?: SymbolSyncWatermark[];
      };
      if (Array.isArray(parsed?.logs)) {
        this.logs = parsed.logs.map(normalizeLog);
      }
      if (Array.isArray(parsed?.watermarks)) {
        for (const w of parsed.watermarks) {
          if (w && typeof w.key === 'string') {
            this.watermarks.set(w.key, w);
          }
        }
      }
    } catch {
      this.logs = [];
    }
  }

  private persistAll(): void {
    this.lastUpdatedAtMs = Date.now();
    // Never wipe SQLite WAL rows via DELETE FROM order_history; active SQLite writes
    // always commit incrementally through writeUpsertRowsInOpenTx / persistWatermark / deleteLogs.
    if (this.sqlite) {
      return;
    }

    try {
      const fpath = this.fallbackJsonPath();
      const tmp = `${fpath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            version: 2,
            updatedAtMs: this.lastUpdatedAtMs,
            watermarks: Array.from(this.watermarks.values()),
            logs: this.logs,
          },
          null,
          2
        ),
        'utf8'
      );
      fs.renameSync(tmp, fpath);
    } catch {
      // Ignore read-only filesystem error
    }
  }

  private writeUpsertRowsInOpenTx(
    touchedLogs: OrderExecutionLog[],
    evictedIds: string[]
  ): void {
    this.lastUpdatedAtMs = Date.now();
    if (!this.sqlite) {
      this.persistAll();
      return;
    }
    const delByIdStmt = this.sqlite.prepare('DELETE FROM order_history WHERE id = ?');
    const upsertStmt = this.sqlite.prepare(`
      INSERT INTO order_history (
        id, composite_key, account_mode, venue, environment, symbol, order_id, lifecycle, status, timestamp_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(composite_key) DO UPDATE SET
        id = excluded.id,
        status = excluded.status,
        timestamp_ms = excluded.timestamp_ms,
        payload_json = excluded.payload_json
    `);
    for (const log of touchedLogs) {
      // Remove any existing row with the same primary `id` first in case composite_key changed during merge
      delByIdStmt.run(log.id);
      upsertStmt.run(
        log.id,
        compositeKeyOf(log),
        log.accountMode,
        log.venue,
        log.environment,
        log.symbol,
        log.orderId,
        log.lifecycle,
        log.status,
        log.timestampMs,
        JSON.stringify(log)
      );
    }
    for (const evictedId of evictedIds) {
      delByIdStmt.run(evictedId);
    }
  }

  private persistWatermark(wm: SymbolSyncWatermark): void {
    this.lastUpdatedAtMs = Date.now();
    if (!this.sqlite) {
      this.persistAll();
      return;
    }
    try {
      const wmStmt = this.sqlite.prepare(`
        INSERT OR REPLACE INTO sync_watermarks (
          key, symbol, venue, environment, last_synced_at_ms, oldest_synced_start_ms, last_lookback, last_synced_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      wmStmt.run(
        wm.key,
        wm.symbol,
        wm.venue,
        wm.environment,
        wm.lastSyncedAtMs,
        wm.oldestSyncedStartMs,
        wm.lastLookback,
        wm.lastSyncedCount
      );
    } catch {
      // Ignore read-only SQLite watermark failure
    }
  }

  private enforcePartitionQuotas(all: OrderExecutionLog[]): OrderExecutionLog[] {
    const sorted = all.slice().sort((a, b) => b.timestampMs - a.timestampMs);
    const result: OrderExecutionLog[] = [];
    let liveCount = 0;
    let paperCount = 0;
    for (const item of sorted) {
      if (item.accountMode === 'Live') {
        if (liveCount < this.maxLiveQuota) {
          result.push(item);
          liveCount += 1;
        }
      } else if (paperCount < this.maxPaperQuota) {
        result.push(item);
        paperCount += 1;
      }
    }
    return result;
  }

  upsertLogs(entries: OrderExecutionLog[]): { added: number; updated: number; total: number } {
    if (!Array.isArray(entries) || entries.length === 0) {
      this.syncIfExternallyModified();
      return { added: 0, updated: 0, total: this.logs.length };
    }
    let added = 0;
    let updated = 0;
    const txStarted = Boolean(this.sqlite);
    if (this.sqlite) {
      try {
        this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION;');
      } catch {
        // Ignore tx begin error and run best-effort
      }
    }
    try {
      this.syncIfExternallyModified();
      const byId = new Map<string, OrderExecutionLog>();
      const byComposite = new Map<string, string>();
      const touchedIds = new Set<string>();

      for (const existing of this.logs) {
        byId.set(existing.id, existing);
        byComposite.set(compositeKeyOf(existing), existing.id);
      }

      for (const raw of entries) {
        const item = normalizeLog(raw);
        const comp = compositeKeyOf(item);
        const existingId = byId.has(item.id) ? item.id : byComposite.get(comp);
        if (!existingId) {
          added += 1;
          byId.set(item.id, item);
          byComposite.set(comp, item.id);
          touchedIds.add(item.id);
        } else {
          updated += 1;
          const prev = byId.get(existingId)!;
          const merged = mergeOrderLogRecords(prev, item);
          byId.set(existingId, merged);
          byComposite.set(compositeKeyOf(merged), existingId);
          touchedIds.add(existingId);
        }
      }

      const allCandidateLogs = Array.from(byId.values());
      const retainedLogs = this.enforcePartitionQuotas(allCandidateLogs);
      const retainedIdSet = new Set(retainedLogs.map((l) => l.id));
      const evictedIds = allCandidateLogs
        .filter((l) => !retainedIdSet.has(l.id))
        .map((l) => l.id);
      const touchedLogs = retainedLogs.filter((l) => touchedIds.has(l.id));

      this.logs = retainedLogs;
      this.writeUpsertRowsInOpenTx(touchedLogs, evictedIds);
      if (txStarted && this.sqlite) {
        this.sqlite.exec('COMMIT;');
        this.lastSqliteDataVersion = this.readSqliteDataVersion();
      }
    } catch {
      if (txStarted && this.sqlite) {
        try {
          this.sqlite.exec('ROLLBACK;');
        } catch {
          // Ignore rollback error
        }
      }
    }
    return { added, updated, total: this.logs.length };
  }

  /**
   * Transitions a resting ENTRY order (NEW / PARTIALLY_FILLED) to CANCELED in-place
   * on the same composite_key so DB queries never double-count canceled pending entries.
   */
  markEntryCanceled(params: {
    symbol: string;
    venue: ExchangeVenue;
    environment: 'Testnet' | 'Production';
    accountMode?: ExecutionAccountMode;
    orderId?: string;
    clientOrderId?: string;
    rationale?: string;
    exitReason?: ExitReason | string | null;
    timestampMs?: number;
  }): OrderExecutionLog | null {
    this.syncIfExternallyModified();
    const cleanSym = params.symbol.trim().toUpperCase();
    const oid = String(params.orderId ?? '').trim();
    const cid = String(params.clientOrderId ?? '').trim();
    const target = this.logs.find((log) => {
      if (log.lifecycle !== 'ENTRY') return false;
      if (log.symbol !== cleanSym || log.venue !== params.venue || log.environment !== params.environment) {
        return false;
      }
      if (params.accountMode && log.accountMode !== params.accountMode) return false;
      if (oid && log.orderId === oid) return true;
      if (cid && log.clientOrderId === cid) return true;
      return !oid && !cid && (log.status === 'NEW' || log.status === 'PARTIALLY_FILLED');
    });
    if (!target) return null;

    const nowMs = params.timestampMs ?? Date.now();
    const updated: OrderExecutionLog = {
      ...target,
      status: 'CANCELED',
      exitReason: params.exitReason ?? target.exitReason ?? 'Canceled',
      rationale: params.rationale?.trim() ? params.rationale : target.rationale,
      updateTimeMs: nowMs,
      timestampMs: Math.max(target.timestampMs, nowMs),
    };
    this.upsertLogs([updated]);
    return updated;
  }

  /**
   * Transitions a resting ENTRY order (NEW / PARTIALLY_FILLED) to FILLED or PARTIALLY_FILLED
   * in-place when cancel races with a fill or partial-fill-before-cancel occurs on Binance.
   */
  markEntryFilledOrPartial(params: {
    symbol: string;
    venue: ExchangeVenue;
    environment: 'Testnet' | 'Production';
    accountMode?: ExecutionAccountMode;
    orderId?: string;
    clientOrderId?: string;
    status: 'FILLED' | 'PARTIALLY_FILLED';
    executedQty: number;
    avgPrice?: number;
    quoteQty?: number;
    rationale?: string;
    timestampMs?: number;
  }): OrderExecutionLog | null {
    this.syncIfExternallyModified();
    const cleanSym = params.symbol.trim().toUpperCase();
    const oid = String(params.orderId ?? '').trim();
    const cid = String(params.clientOrderId ?? '').trim();
    const target = this.logs.find((log) => {
      if (log.lifecycle !== 'ENTRY') return false;
      if (log.symbol !== cleanSym || log.venue !== params.venue || log.environment !== params.environment) {
        return false;
      }
      if (params.accountMode && log.accountMode !== params.accountMode) return false;
      if (oid && log.orderId === oid) return true;
      if (cid && log.clientOrderId === cid) return true;
      return !oid && !cid && (log.status === 'NEW' || log.status === 'PARTIALLY_FILLED');
    });
    if (!target) return null;

    const nowMs = params.timestampMs ?? Date.now();
    const execQty = Math.max(target.executedQty, Number(params.executedQty) || 0);
    const avgPx =
      typeof params.avgPrice === 'number' && params.avgPrice > 0
        ? params.avgPrice
        : target.avgPrice ?? target.price;
    const quoteQty =
      typeof params.quoteQty === 'number' && params.quoteQty > 0
        ? params.quoteQty
        : execQty > 0 && avgPx > 0
          ? execQty * avgPx
          : target.quoteQty;
    const updated: OrderExecutionLog = {
      ...target,
      status: params.status,
      executedQty: execQty,
      avgPrice: avgPx,
      price: avgPx > 0 ? avgPx : target.price,
      quoteQty,
      exitReason: null,
      rationale: params.rationale?.trim() ? params.rationale : target.rationale,
      updateTimeMs: nowMs,
      timestampMs: Math.max(target.timestampMs, nowMs),
    };
    this.upsertLogs([updated]);
    return updated;
  }

  getAllLogs(): OrderExecutionLog[] {
    this.syncIfExternallyModified();
    return this.logs.slice();
  }

  queryLogs(filters?: {
    symbol?: string;
    venue?: ExchangeVenue;
    environment?: 'Testnet' | 'Production';
    status?: string;
    accountMode?: ExecutionAccountMode;
    startTimeMs?: number;
    endTimeMs?: number;
    limit?: number;
  }): OrderExecutionLog[] {
    this.syncIfExternallyModified();
    if (!filters) return this.logs.slice();
    const limit = Math.min(5000, Math.max(1, filters.limit ?? 500));
    return this.logs
      .filter((log) => {
        if (filters.symbol && log.symbol !== filters.symbol) return false;
        if (filters.venue && log.venue !== filters.venue) return false;
        if (filters.environment && log.environment !== filters.environment) return false;
        if (filters.status && log.status !== filters.status) return false;
        if (filters.accountMode && log.accountMode !== filters.accountMode) return false;
        if (filters.startTimeMs !== undefined && log.timestampMs < filters.startTimeMs) return false;
        if (filters.endTimeMs !== undefined && log.timestampMs > filters.endTimeMs) return false;
        return true;
      })
      .slice(0, limit);
  }

  recordSyncWatermark(params: {
    symbol: string;
    venue: ExchangeVenue;
    environment: 'Testnet' | 'Production';
    lookback: SyncLookbackPreset;
    windowStartMs: number;
    syncedCount: number;
    nowMs?: number;
  }): SymbolSyncWatermark {
    this.syncIfExternallyModified();
    const nowMs = params.nowMs ?? Date.now();
    const sym = params.symbol.trim().toUpperCase();
    const key = `${params.venue}:${params.environment}:${sym}`;
    const prev = this.watermarks.get(key);
    const wm: SymbolSyncWatermark = {
      key,
      symbol: sym,
      venue: params.venue,
      environment: params.environment,
      lastSyncedAtMs: nowMs,
      oldestSyncedStartMs:
        prev && prev.oldestSyncedStartMs > 0
          ? Math.min(prev.oldestSyncedStartMs, params.windowStartMs)
          : params.windowStartMs,
      lastLookback: params.lookback,
      lastSyncedCount: params.syncedCount,
    };
    this.watermarks.set(key, wm);
    this.persistWatermark(wm);
    return wm;
  }

  deleteLogs(opts?: {
    accountMode?: 'Paper' | 'Live' | 'ALL';
    symbol?: string;
    olderThanDays?: number;
    nowMs?: number;
  }): { deleted: number; remaining: number } {
    const mode = opts?.accountMode ?? 'ALL';
    const symbol = opts?.symbol?.trim().toUpperCase();
    const olderThanDays =
      opts?.olderThanDays !== undefined && Number.isFinite(opts.olderThanDays) && opts.olderThanDays > 0
        ? opts.olderThanDays
        : null;
    const cutoffMs = olderThanDays !== null ? (opts?.nowMs ?? Date.now()) - olderThanDays * 86_400_000 : null;

    if (this.sqlite) {
      try {
        this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION;');
      } catch {
        // Ignore begin error
      }
    }

    let before = 0;
    try {
      this.syncIfExternallyModified();
      before = this.logs.length;

      const deletedIds: string[] = [];
      this.logs = this.logs.filter((log) => {
        const matchMode = mode === 'ALL' || log.accountMode === mode;
        const matchSym = !symbol || log.symbol === symbol;
        const matchAge = cutoffMs === null || log.timestampMs < cutoffMs;
        const shouldDelete = matchMode && matchSym && matchAge;
        if (shouldDelete) {
          deletedIds.push(log.id);
        }
        return !shouldDelete;
      });

      const deletedWatermarkKeys: string[] = [];
      const clearAllWatermarks = mode === 'ALL' && !symbol && cutoffMs === null;
      if (clearAllWatermarks) {
        this.watermarks.clear();
      } else if (symbol && mode !== 'Paper' && cutoffMs === null && !this.logs.some((l) => l.symbol === symbol)) {
        for (const k of Array.from(this.watermarks.keys())) {
          if (k.endsWith(`:${symbol}`)) {
            this.watermarks.delete(k);
            deletedWatermarkKeys.push(k);
          }
        }
      }

      if (this.sqlite) {
        this.lastUpdatedAtMs = Date.now();
        if (deletedIds.length > 0) {
          const delStmt = this.sqlite.prepare('DELETE FROM order_history WHERE id = ?');
          for (const id of deletedIds) {
            delStmt.run(id);
          }
        }
        if (clearAllWatermarks) {
          this.sqlite.exec('DELETE FROM sync_watermarks;');
        } else if (deletedWatermarkKeys.length > 0) {
          const delWm = this.sqlite.prepare('DELETE FROM sync_watermarks WHERE key = ?');
          for (const k of deletedWatermarkKeys) {
            delWm.run(k);
          }
        }
        this.sqlite.exec('COMMIT;');
        this.lastSqliteDataVersion = this.readSqliteDataVersion();
      } else {
        this.persistAll();
      }
    } catch {
      if (this.sqlite) {
        try {
          this.sqlite.exec('ROLLBACK;');
        } catch {
          // Ignore rollback error
        }
      }
    }
    return { deleted: before - this.logs.length, remaining: this.logs.length };
  }

  getSummary(): OrderDatabaseSummary {
    this.syncIfExternallyModified();
    let liveCount = 0;
    let paperCount = 0;
    const symbols = new Set<string>();
    for (const log of this.logs) {
      if (log.accountMode === 'Live') liveCount += 1;
      else paperCount += 1;
      symbols.add(log.symbol);
    }
    return {
      engine: this.sqlite ? 'sqlite_wal' : 'jsonl_fallback',
      dbPath: path.basename(this.sqlite ? this.dbPath : this.fallbackJsonPath()),
      totalCount: this.logs.length,
      liveCount,
      paperCount,
      maxLiveQuota: this.maxLiveQuota,
      maxPaperQuota: this.maxPaperQuota,
      distinctSymbols: Array.from(symbols).sort(),
      watermarks: Array.from(this.watermarks.values()).sort((a, b) => b.lastSyncedAtMs - a.lastSyncedAtMs),
      lastUpdatedAtMs: this.lastUpdatedAtMs,
    };
  }

  close(): void {
    if (this.sqlite) {
      try {
        this.sqlite.close();
      } catch {
        // Ignore close error
      }
    }
  }
}
