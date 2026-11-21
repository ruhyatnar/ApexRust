import type {
  ExchangeVenue,
  MarketTicker24h,
  ScreenerSnapshotPayload,
  TrendingCategory,
  TrendingRankingSource,
} from '../engine/types';
import { computeCtsScore, rankScreenerTickers } from '../engine/watchlist';

export type BinanceEnv = 'Testnet' | 'Production';

export interface ScreenerQueryOptions {
  venue: ExchangeVenue;
  environment: BinanceEnv;
  rankingSource?: TrendingRankingSource;
  category?: TrendingCategory;
  quoteAsset?: string;
  minQuoteVolumeUsdt?: number;
  onlyTradable?: boolean;
  limit?: number;
  searchQuery?: string;
  activeWatchlist?: string[];
  sourceTagsBySymbol?: Record<string, 'pinned' | 'trending' | 'protected_position'>;
  ctsWeights?: { rvol?: number; momentum?: number; volume?: number };
  ctsMinRvol?: number;
}

interface CtsCacheEntry {
  fetchedAtMs: number;
  metrics: Map<string, { rvol1h: number; momentum1hPct: number; ctsScore: number }>;
}

const CTS_CACHE_TTL_MS = 5 * 60 * 1000;
const CTS_MAX_SYMBOLS = 30;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Derives 1h RVOL and 1h momentum from Binance kline rows, then blends them
 * into a CTS score with cross-sectionally normalized volume.
 */
export function buildCtsMetrics(
  tickers: MarketTicker24h[],
  klinesBySymbol: Map<string, Array<Array<string | number>>>,
  weights?: { rvol?: number; momentum?: number; volume?: number }
): Map<string, { rvol1h: number; momentum1hPct: number; ctsScore: number }> {
  const now = Date.now();
  const medianVolume = median(tickers.map((t) => t.quoteVolume).filter((v) => v > 0));
  const out = new Map<string, { rvol1h: number; momentum1hPct: number; ctsScore: number }>();

  for (const ticker of tickers) {
    const rows = klinesBySymbol.get(ticker.symbol);
    if (!rows || rows.length < 6) continue;
    const closed = rows.filter((r) => Number(r[6] ?? 0) > 0 && Number(r[6]) <= now);
    if (closed.length < 6) continue;
    const last = closed[closed.length - 1];
    const baselineBars = closed.slice(Math.max(0, closed.length - 25), closed.length - 1);
    const volumes = baselineBars.map((r) => Number(r[5] ?? 0)).filter((v) => v > 0);
    if (volumes.length < 3) continue;
    const baseline = volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const lastVolume = Number(last[5] ?? 0);
    if (baseline <= 0 || lastVolume <= 0) continue;
    const rvol1h = lastVolume / baseline;
    const anchor = closed[Math.max(0, closed.length - 25)];
    const anchorClose = Number(anchor[4] ?? 0);
    const lastClose = Number(last[4] ?? 0);
    if (anchorClose <= 0 || lastClose <= 0) continue;
    const momentum1hPct = ((lastClose - anchorClose) / anchorClose) * 100;
    const ctsScore = computeCtsScore({
      rvol1h,
      momentum1hPct,
      quoteVolume: ticker.quoteVolume,
      medianQuoteVolume: medianVolume,
      weights,
    });
    if (ctsScore === null) continue;
    out.set(ticker.symbol, { rvol1h, momentum1hPct, ctsScore });
  }
  return out;
}

interface StreamBucket {
  key: string;
  env: BinanceEnv;
  venue: ExchangeVenue;
  tickers: Map<string, MarketTicker24h>;
  ws: WebSocket | null;
  streamConnected: boolean;
  lastWsMessageAtMs: number;
  lastAccessedAtMs: number;
  lastSeedAttemptAtMs: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  rotateTimer: ReturnType<typeof setTimeout> | null;
  connecting: boolean;
}

interface ExchangeInfoCacheEntry {
  symbols: Set<string>;
  fetchedAtMs: number;
  inFlight: Promise<Set<string>> | null;
}

interface RateBudgetEntry {
  usedWeight1m: number;
  updatedAtMs: number;
  blockedUntilMs: number;
}

const EXCHANGE_INFO_TTL_MS = 30 * 60 * 1000; // 30m cache (Spot weight 20, Futures weight 1)
const SEED_COOLDOWN_MS = 120 * 1000;
const WS_PROACTIVE_ROTATE_MS = 23 * 60 * 60 * 1000; // Rotate < 24h Binance limit
const WS_STALE_TIMEOUT_MS = 60_000; // Force reconnect if upstream !miniTicker@arr goes silent for 60s
const BUCKET_IDLE_SHUTDOWN_MS = 15 * 60 * 1000;
const EXCHANGE_INFO_STALE_MS = 60 * 60 * 1000;

function formatMiniTickerOverrideUrl(rawOverride: string): string {
  const clean = rawOverride.trim().replace(/\/+$/, '');
  if (clean.endsWith('/!miniTicker@arr') || clean.includes('streams=!miniTicker@arr')) {
    return clean;
  }
  if (clean.endsWith('/stream')) {
    return `${clean}?streams=!miniTicker@arr`;
  }
  if (clean.endsWith('/ws')) {
    return `${clean}/!miniTicker@arr`;
  }
  return `${clean}/ws/!miniTicker@arr`;
}

function getScreenerRestBaseUrl(env: BinanceEnv, venue: ExchangeVenue): string {
  if (venue === 'Futures') {
    if (env === 'Production') return 'https://fapi.binance.com';
    const override = (process.env.BINANCE_FUTURES_TESTNET_REST ?? '').trim();
    return override || 'https://testnet.binancefuture.com';
  }
  if (env === 'Production') return 'https://api.binance.com';
  const spotOverride = (process.env.BINANCE_SPOT_TESTNET_REST ?? '').trim();
  return spotOverride || 'https://testnet.binance.vision';
}

function getMiniTickerWsUrl(env: BinanceEnv, venue: ExchangeVenue): string {
  if (venue === 'Futures') {
    if (env === 'Production') {
      const override = (process.env.BINANCE_FUTURES_WS_URL ?? '').trim();
      return override
        ? formatMiniTickerOverrideUrl(override)
        : 'wss://fstream.binance.com/ws/!miniTicker@arr';
    }
    const override = (process.env.BINANCE_FUTURES_TESTNET_WS_URL ?? '').trim();
    return override
      ? formatMiniTickerOverrideUrl(override)
      : 'wss://stream.binancefuture.com/ws/!miniTicker@arr';
  }
  if (env === 'Production') {
    const override = (process.env.BINANCE_SPOT_WS_URL ?? '').trim();
    return override
      ? formatMiniTickerOverrideUrl(override)
      : 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
  }
  const override = (process.env.BINANCE_SPOT_TESTNET_WS_URL ?? '').trim();
  return override
    ? formatMiniTickerOverrideUrl(override)
    : 'wss://stream.testnet.binance.vision/ws/!miniTicker@arr';
}

export class BinanceScreenerHub {
  private readonly buckets = new Map<string, StreamBucket>();
  private readonly exchangeInfoCache = new Map<string, ExchangeInfoCacheEntry>();
  private readonly rateBudgets = new Map<string, RateBudgetEntry>();
  private readonly listeners = new Set<(env: BinanceEnv, venue: ExchangeVenue) => void>();
  private readonly ctsCache = new Map<string, CtsCacheEntry>();
  private readonly ctsInFlight = new Map<string, Promise<void>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastEmitAtMs = new Map<string, number>();

  constructor() {
    this.idleTimer = setInterval(() => {
      this.cleanupIdleBuckets();
      this.checkStaleSockets();
    }, 30_000);
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  onUpdate(cb: (env: BinanceEnv, venue: ExchangeVenue) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emitUpdate(env: BinanceEnv, venue: ExchangeVenue): void {
    const key = `${env}:${venue}`;
    const now = Date.now();
    const prev = this.lastEmitAtMs.get(key) ?? 0;
    if (now - prev < 950) return;
    this.lastEmitAtMs.set(key, now);
    for (const cb of this.listeners) {
      try {
        cb(env, venue);
      } catch {
        // Ignore subscriber callback errors
      }
    }
  }

  reportRestHeaders(
    env: BinanceEnv,
    venue: ExchangeVenue,
    status: number,
    usedWeightHeader?: string | number | null,
    retryAfterHeader?: string | null
  ): void {
    const key = `${env}:${venue}`;
    const now = Date.now();
    const prev = this.rateBudgets.get(key) ?? {
      usedWeight1m: 0,
      updatedAtMs: now,
      blockedUntilMs: 0,
    };

    const parsedWeight = Number(usedWeightHeader ?? 0);
    if (Number.isFinite(parsedWeight) && parsedWeight > 0) {
      prev.usedWeight1m = parsedWeight;
      prev.updatedAtMs = now;
    }

    if (status === 429 || status === 418) {
      const retrySec = Number(retryAfterHeader ?? 0);
      const waitMs =
        Number.isFinite(retrySec) && retrySec > 0
          ? retrySec * 1000
          : status === 418
            ? 120_000
            : 15_000;
      prev.blockedUntilMs = Math.max(prev.blockedUntilMs, now + waitMs);
    }

    this.rateBudgets.set(key, prev);
  }

  getRateWeightUsed(env: BinanceEnv, venue: ExchangeVenue): number {
    const entry = this.rateBudgets.get(`${env}:${venue}`);
    if (!entry) return 0;
    const ageMs = Date.now() - entry.updatedAtMs;
    if (ageMs > 65_000) return 0;
    return entry.usedWeight1m;
  }

  isRateBudgetConstrained(env: BinanceEnv, venue: ExchangeVenue): boolean {
    const entry = this.rateBudgets.get(`${env}:${venue}`);
    if (!entry) return false;
    const now = Date.now();
    if (entry.blockedUntilMs > now) return true;
    const limit = venue === 'Futures' ? 2400 : 6000;
    if (now - entry.updatedAtMs < 60_000 && entry.usedWeight1m >= limit * 0.7) {
      return true;
    }
    return false;
  }

  async getTradableSymbols(
    env: BinanceEnv,
    venue: ExchangeVenue,
    forceRefresh = false
  ): Promise<Set<string>> {
    const key = `${env}:${venue}`;
    const existing = this.exchangeInfoCache.get(key);
    const now = Date.now();

    if (!forceRefresh && existing && now - existing.fetchedAtMs < EXCHANGE_INFO_TTL_MS && existing.symbols.size > 0) {
      return existing.symbols;
    }
    if (existing?.inFlight) {
      return existing.inFlight;
    }
    if (this.isRateBudgetConstrained(env, venue) && existing && now - existing.fetchedAtMs < EXCHANGE_INFO_STALE_MS) {
      return existing.symbols;
    }

    const promise = this.fetchExchangeInfo(env, venue)
      .then((symbols) => {
        this.exchangeInfoCache.set(key, {
          symbols,
          fetchedAtMs: Date.now(),
          inFlight: null,
        });
        return symbols;
      })
      .catch(() => {
        const current = this.exchangeInfoCache.get(key);
        if (current) {
          current.inFlight = null;
          if (current.symbols.size === 0) {
            this.exchangeInfoCache.delete(key);
          } else {
            return current.symbols;
          }
        }
        return existing?.symbols ?? new Set<string>();
      });

    this.exchangeInfoCache.set(key, {
      symbols: existing?.symbols ?? new Set<string>(),
      fetchedAtMs: existing?.fetchedAtMs ?? 0,
      inFlight: promise,
    });

    return promise;
  }

  private async fetchExchangeInfo(env: BinanceEnv, venue: ExchangeVenue): Promise<Set<string>> {
    const baseUrl = getScreenerRestBaseUrl(env, venue);
    const url = venue === 'Futures' ? `${baseUrl}/fapi/v1/exchangeInfo` : `${baseUrl}/api/v3/exchangeInfo`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    this.reportRestHeaders(
      env,
      venue,
      resp.status,
      resp.headers.get('x-mbx-used-weight-1m'),
      resp.headers.get('retry-after')
    );
    if (!resp.ok) {
      throw new Error(`exchangeInfo HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      symbols?: Array<{
        symbol?: string;
        status?: string;
        contractType?: string;
        isSpotTradingAllowed?: boolean;
        permissions?: string[];
      }>;
    };
    const out = new Set<string>();
    for (const s of json.symbols ?? []) {
      const sym = String(s.symbol ?? '').trim().toUpperCase();
      if (!sym) continue;
      if (String(s.status ?? '').toUpperCase() !== 'TRADING') continue;
      if (venue === 'Futures') {
        if (s.contractType && String(s.contractType).toUpperCase() !== 'PERPETUAL') continue;
      } else if (s.isSpotTradingAllowed === false) {
        continue;
      }
      out.add(sym);
    }
    return out;
  }

  private ensureBucket(env: BinanceEnv, venue: ExchangeVenue): StreamBucket {
    const key = `${env}:${venue}`;
    let bucket = this.buckets.get(key);
    const now = Date.now();
    if (!bucket) {
      bucket = {
        key,
        env,
        venue,
        tickers: new Map<string, MarketTicker24h>(),
        ws: null,
        streamConnected: false,
        lastWsMessageAtMs: 0,
        lastAccessedAtMs: now,
        lastSeedAttemptAtMs: 0,
        reconnectAttempts: 0,
        reconnectTimer: null,
        rotateTimer: null,
        connecting: false,
      };
      this.buckets.set(key, bucket);
    }
    bucket.lastAccessedAtMs = now;
    if (!bucket.ws && !bucket.connecting && !bucket.reconnectTimer) {
      this.connectBucketWs(bucket);
    }
    return bucket;
  }

  private connectBucketWs(bucket: StreamBucket): void {
    if (typeof globalThis.WebSocket !== 'function') return;
    if (bucket.connecting || bucket.ws) return;
    bucket.connecting = true;
    const url = getMiniTickerWsUrl(bucket.env, bucket.venue);

    try {
      const ws = new globalThis.WebSocket(url);
      bucket.ws = ws;

      ws.addEventListener('open', () => {
        bucket.connecting = false;
        bucket.streamConnected = true;
        bucket.lastWsMessageAtMs = Date.now();
        bucket.reconnectAttempts = 0;
        if (bucket.rotateTimer) clearTimeout(bucket.rotateTimer);
        bucket.rotateTimer = setTimeout(() => {
          this.rotateBucketWs(bucket);
        }, WS_PROACTIVE_ROTATE_MS);
        if (typeof bucket.rotateTimer.unref === 'function') {
          bucket.rotateTimer.unref();
        }
      });

      ws.addEventListener('message', (ev) => {
        const rawText = typeof ev.data === 'string' ? ev.data : '';
        if (!rawText) return;
        this.ingestMiniTickerPayload(bucket, rawText);
      });

      ws.addEventListener('error', () => {
        bucket.streamConnected = false;
      });

      ws.addEventListener('close', () => {
        bucket.connecting = false;
        bucket.streamConnected = false;
        bucket.ws = null;
        if (bucket.rotateTimer) {
          clearTimeout(bucket.rotateTimer);
          bucket.rotateTimer = null;
        }
        if (this.buckets.has(bucket.key) && Date.now() - bucket.lastAccessedAtMs < BUCKET_IDLE_SHUTDOWN_MS) {
          this.scheduleReconnect(bucket);
        }
      });
    } catch {
      bucket.connecting = false;
      bucket.streamConnected = false;
      bucket.ws = null;
      this.scheduleReconnect(bucket);
    }
  }

  private rotateBucketWs(bucket: StreamBucket): void {
    try {
      bucket.ws?.close(1000, 'Proactive <24h rotation');
    } catch {
      // Ignore close error
    }
  }

  private scheduleReconnect(bucket: StreamBucket): void {
    if (bucket.reconnectTimer) return;
    const delays = [1000, 2000, 5000, 15_000, 30_000];
    const delay = delays[Math.min(delays.length - 1, bucket.reconnectAttempts)];
    bucket.reconnectAttempts += 1;
    bucket.reconnectTimer = setTimeout(() => {
      bucket.reconnectTimer = null;
      if (this.buckets.has(bucket.key)) {
        this.connectBucketWs(bucket);
      }
    }, delay);
    if (typeof bucket.reconnectTimer.unref === 'function') {
      bucket.reconnectTimer.unref();
    }
  }

  private ingestMiniTickerPayload(bucket: StreamBucket, rawText: string): void {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      const arr = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown[] }).data)
          ? ((parsed as { data: Array<Record<string, unknown>> }).data)
          : [];
      if (arr.length === 0) return;

      const now = Date.now();
      bucket.lastWsMessageAtMs = now;
      for (const item of arr) {
        const sym = String(item.s ?? '').trim().toUpperCase();
        if (!sym) continue;
        const lastPrice = Number(item.c ?? 0);
        const openPrice = Number(item.o ?? 0);
        const highPrice = Number(item.h ?? 0);
        const lowPrice = Number(item.l ?? 0);
        const baseVolume = Number(item.v ?? 0);
        const quoteVolume = Number(item.q ?? 0);
        if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;

        const priceChangePercent =
          openPrice > 0 && Number.isFinite(openPrice)
            ? ((lastPrice - openPrice) / openPrice) * 100
            : 0;
        const rangePct24h =
          lowPrice > 0 && highPrice >= lowPrice
            ? ((highPrice - lowPrice) / Math.max(lowPrice, 1e-12)) * 100
            : 0;

        bucket.tickers.set(sym, {
          symbol: sym,
          venue: bucket.venue,
          lastPrice,
          openPrice24h: Number.isFinite(openPrice) ? openPrice : lastPrice,
          highPrice24h: Number.isFinite(highPrice) ? highPrice : lastPrice,
          lowPrice24h: Number.isFinite(lowPrice) ? lowPrice : lastPrice,
          priceChangePercent: Number.isFinite(priceChangePercent) ? priceChangePercent : 0,
          baseVolume: Number.isFinite(baseVolume) ? baseVolume : 0,
          quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
          rangePct24h: Number.isFinite(rangePct24h) ? rangePct24h : 0,
          tradableOnActiveEnv: true,
          updatedAtMs: Number(item.E ?? now) || now,
        });
      }
      this.emitUpdate(bucket.env, bucket.venue);
    } catch {
      // Ignore malformed frame
    }
  }

  private async seedFromRestOnceIfEmpty(bucket: StreamBucket): Promise<void> {
    if (bucket.tickers.size > 0) return;
    const now = Date.now();
    if (now - bucket.lastSeedAttemptAtMs < SEED_COOLDOWN_MS) return;
    if (this.isRateBudgetConstrained(bucket.env, bucket.venue)) return;

    bucket.lastSeedAttemptAtMs = now;
    try {
      const baseUrl = getScreenerRestBaseUrl(bucket.env, bucket.venue);
      const url = bucket.venue === 'Futures' ? `${baseUrl}/fapi/v1/ticker/24hr` : `${baseUrl}/api/v3/ticker/24hr`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      this.reportRestHeaders(
        bucket.env,
        bucket.venue,
        resp.status,
        resp.headers.get('x-mbx-used-weight-1m'),
        resp.headers.get('retry-after')
      );
      if (!resp.ok) return;
      const rows = (await resp.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) return;
      const stamped = Date.now();
      for (const r of rows) {
        const sym = String(r.symbol ?? '').trim().toUpperCase();
        if (!sym) continue;
        const lastPrice = Number(r.lastPrice ?? 0);
        const openPrice = Number(r.openPrice ?? lastPrice);
        const highPrice = Number(r.highPrice ?? lastPrice);
        const lowPrice = Number(r.lowPrice ?? lastPrice);
        const baseVolume = Number(r.volume ?? 0);
        const quoteVolume = Number(r.quoteVolume ?? 0);
        const priceChangePercent = Number(r.priceChangePercent ?? 0);
        if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;

        const rangePct24h =
          lowPrice > 0 && highPrice >= lowPrice
            ? ((highPrice - lowPrice) / Math.max(lowPrice, 1e-12)) * 100
            : 0;
        bucket.tickers.set(sym, {
          symbol: sym,
          venue: bucket.venue,
          lastPrice,
          openPrice24h: Number.isFinite(openPrice) ? openPrice : lastPrice,
          highPrice24h: Number.isFinite(highPrice) ? highPrice : lastPrice,
          lowPrice24h: Number.isFinite(lowPrice) ? lowPrice : lastPrice,
          priceChangePercent: Number.isFinite(priceChangePercent) ? priceChangePercent : 0,
          baseVolume: Number.isFinite(baseVolume) ? baseVolume : 0,
          quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
          rangePct24h: Number.isFinite(rangePct24h) ? rangePct24h : 0,
          tradableOnActiveEnv: true,
          updatedAtMs: Number(r.closeTime ?? stamped) || stamped,
        });
      }
      this.emitUpdate(bucket.env, bucket.venue);
    } catch {
      // Seed best-effort only; WS !miniTicker@arr remains primary
    }
  }

  async getScreenerSnapshot(options: ScreenerQueryOptions): Promise<ScreenerSnapshotPayload> {
    const rankingSource = options.rankingSource ?? 'auto';
    const rankingEnv: BinanceEnv =
      rankingSource === 'production'
        ? 'Production'
        : rankingSource === 'environment'
          ? options.environment
          : 'Production'; // 'auto': Production WS rankings give realistic market flow while validating active env tradability

    const [activeTradableSet, bucket] = await Promise.all([
      this.getTradableSymbols(options.environment, options.venue),
      Promise.resolve(this.ensureBucket(rankingEnv, options.venue)),
    ]);

    if (bucket.tickers.size === 0) {
      await this.seedFromRestOnceIfEmpty(bucket);
    }

    const watchlistSet = new Set((options.activeWatchlist ?? []).map((s) => s.trim().toUpperCase()));
    const sourceTags = options.sourceTagsBySymbol ?? {};
    const enriched: MarketTicker24h[] = [];
    for (const rawTicker of bucket.tickers.values()) {
      const tradable =
        activeTradableSet.size > 0 ? activeTradableSet.has(rawTicker.symbol) : true;
      enriched.push({
        ...rawTicker,
        tradableOnActiveEnv: tradable,
        inWatchlist: watchlistSet.has(rawTicker.symbol),
        sourceTag: sourceTags[rawTicker.symbol],
      });
    }

    const category = options.category ?? 'hot_volume';
    if (category === 'cts_momentum') {
      await this.enrichCtsMetrics(bucket, enriched, options);
    }

    const ranked = rankScreenerTickers(enriched, {
      category,
      quoteAsset: options.quoteAsset ?? 'USDT',
      minQuoteVolumeUsdt: options.minQuoteVolumeUsdt ?? 0,
      onlyTradable: options.onlyTradable ?? true,
      limit: options.limit ?? 50,
      searchQuery: options.searchQuery,
      ctsMinRvol: options.ctsMinRvol,
    });

    return {
      venue: options.venue,
      environment: options.environment,
      rankingSourceUsed: rankingEnv === 'Production' ? 'production' : 'environment',
      streamConnected: bucket.streamConnected,
      totalTradableSymbols: activeTradableSet.size > 0 ? activeTradableSet.size : bucket.tickers.size,
      updatedAtMs: bucket.lastWsMessageAtMs || Date.now(),
      rateWeightUsed1m: this.getRateWeightUsed(options.environment, options.venue),
      tickers: ranked,
    };
  }

  /**
   * Fetches 1h klines for the most liquid candidates and stamps CTS metrics onto
   * the tickers. Cached for 5 minutes per env/venue to stay far below weight limits.
   */
  private async enrichCtsMetrics(
    bucket: StreamBucket,
    tickers: MarketTicker24h[],
    options: ScreenerQueryOptions
  ): Promise<void> {
    const key = bucket.key;
    const cached = this.ctsCache.get(key);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs < CTS_CACHE_TTL_MS) {
      this.applyCtsMetrics(tickers, cached.metrics);
      return;
    }
    const inFlight = this.ctsInFlight.get(key);
    if (inFlight) {
      await inFlight;
      const refreshed = this.ctsCache.get(key);
      if (refreshed) this.applyCtsMetrics(tickers, refreshed.metrics);
      return;
    }

    const task = (async () => {
      const candidates = [...tickers]
        .filter((t) => t.lastPrice > 0 && t.quoteVolume > 0)
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, CTS_MAX_SYMBOLS);
      const klinesBySymbol = new Map<string, Array<Array<string | number>>>();
      const concurrency = 4;
      for (let i = 0; i < candidates.length; i += concurrency) {
        if (this.isRateBudgetConstrained(bucket.env, bucket.venue)) break;
        const batch = candidates.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (t) => {
            try {
              const rows = await this.fetchKlines1h(bucket.env, bucket.venue, t.symbol);
              if (rows.length > 0) klinesBySymbol.set(t.symbol, rows);
            } catch {
              // Skip symbol on failure; ranking simply omits it.
            }
          })
        );
      }
      const metrics = buildCtsMetrics(tickers, klinesBySymbol, options.ctsWeights);
      this.ctsCache.set(key, { fetchedAtMs: Date.now(), metrics });
    })();

    this.ctsInFlight.set(key, task);
    try {
      await task;
    } finally {
      this.ctsInFlight.delete(key);
    }
    const refreshed = this.ctsCache.get(key);
    if (refreshed) this.applyCtsMetrics(tickers, refreshed.metrics);
  }

  private applyCtsMetrics(
    tickers: MarketTicker24h[],
    metrics: Map<string, { rvol1h: number; momentum1hPct: number; ctsScore: number }>
  ): void {
    for (const ticker of tickers) {
      const m = metrics.get(ticker.symbol);
      if (!m) continue;
      ticker.rvol1h = m.rvol1h;
      ticker.momentum1hPct = m.momentum1hPct;
      ticker.ctsScore = m.ctsScore;
    }
  }

  private async fetchKlines1h(
    env: BinanceEnv,
    venue: ExchangeVenue,
    symbol: string
  ): Promise<Array<Array<string | number>>> {
    const baseUrl = getScreenerRestBaseUrl(env, venue);
    const path =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=26`
        : `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=26`;
    const resp = await fetch(path, { signal: AbortSignal.timeout(8000) });
    this.reportRestHeaders(
      env,
      venue,
      resp.status,
      resp.headers.get('x-mbx-used-weight-1m'),
      resp.headers.get('retry-after')
    );
    if (!resp.ok) return [];
    const rows = (await resp.json()) as unknown;
    return Array.isArray(rows) ? (rows as Array<Array<string | number>>) : [];
  }

  private checkStaleSockets(): void {
    const now = Date.now();
    for (const bucket of this.buckets.values()) {
      if (
        bucket.streamConnected &&
        bucket.ws &&
        bucket.lastWsMessageAtMs > 0 &&
        now - bucket.lastWsMessageAtMs > WS_STALE_TIMEOUT_MS
      ) {
        bucket.streamConnected = false;
        try {
          bucket.ws.close(4000, 'Stale heartbeat watchdog');
        } catch {
          // Ignore close error
        }
      }
    }
  }

  private cleanupIdleBuckets(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastAccessedAtMs >= BUCKET_IDLE_SHUTDOWN_MS) {
        this.closeBucket(bucket);
        this.buckets.delete(key);
      }
    }
  }

  private closeBucket(bucket: StreamBucket): void {
    if (bucket.reconnectTimer) {
      clearTimeout(bucket.reconnectTimer);
      bucket.reconnectTimer = null;
    }
    if (bucket.rotateTimer) {
      clearTimeout(bucket.rotateTimer);
      bucket.rotateTimer = null;
    }
    try {
      bucket.ws?.close(1000, 'Idle shutdown');
    } catch {
      // Ignore close error
    }
    bucket.ws = null;
    bucket.streamConnected = false;
  }

  shutdown(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const bucket of this.buckets.values()) {
      this.closeBucket(bucket);
    }
    this.buckets.clear();
  }
}
