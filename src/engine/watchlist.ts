import type {
  MarketTicker24h,
  PairSelectionMode,
  PairSourceTag,
  Timeframe,
  TradingConfig,
  TrendingCategory,
} from './types';

interface ResolvedWatchlistEntry {
  symbol: string;
  sourceTag: PairSourceTag;
}

export interface WatchlistDwellState {
  enteredAtMs: Map<string, number>;
}

const MAX_WATCHLIST_HARD_CAP = 40;

function sanitizeTradingSymbol(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

export function normalizeSymbolList(raw: unknown, fallback: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const items = Array.isArray(raw) ? raw : [];
  for (const item of items) {
    const sym = sanitizeTradingSymbol(item);
    if (sym.length >= 4 && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

export function timeframeToMs(tf: Timeframe | string): number {
  switch (tf) {
    case '1m':
      return 60_000;
    case '3m':
      return 180_000;
    case '5m':
      return 300_000;
    case '15m':
      return 900_000;
    case '30m':
      return 1_800_000;
    case '1h':
      return 3_600_000;
    case '2h':
      return 7_200_000;
    case '4h':
      return 14_400_000;
    case '6h':
      return 21_600_000;
    case '8h':
      return 28_800_000;
    case '12h':
      return 43_200_000;
    case '1d':
      return 86_400_000;
    default:
      return 300_000;
  }
}

/**
 * Detects whether consecutive closed candles have a missing interval gap (> 1.5x timeframe).
 */
export function hasCandleSequenceGap(
  prevOpenTimeMs: number | undefined | null,
  nextOpenTimeMs: number,
  timeframe: Timeframe | string
): boolean {
  if (!prevOpenTimeMs || prevOpenTimeMs <= 0 || nextOpenTimeMs <= prevOpenTimeMs) {
    return false;
  }
  const stepMs = timeframeToMs(timeframe);
  return nextOpenTimeMs - prevOpenTimeMs > stepMs * 1.5;
}

/**
 * Ranks live Binance 24h market tickers by requested screener category
 * while enforcing quote-asset suffix and minimum 24h USDT liquidity filters.
 */
export function rankScreenerTickers(
  tickers: MarketTicker24h[],
  options: {
    category: TrendingCategory;
    quoteAsset?: string;
    minQuoteVolumeUsdt?: number;
    onlyTradable?: boolean;
    limit?: number;
    searchQuery?: string;
  }
): MarketTicker24h[] {
  const quote = (options.quoteAsset ?? 'USDT').trim().toUpperCase() || 'USDT';
  const minVol = Math.max(0, options.minQuoteVolumeUsdt ?? 0);
  const query = sanitizeTradingSymbol(options.searchQuery ?? '');
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  const filtered = tickers.filter((t) => {
    if (!t.symbol.endsWith(quote)) return false;
    if (options.onlyTradable && !t.tradableOnActiveEnv) return false;
    if (t.quoteVolume < minVol) return false;
    if (query && !t.symbol.includes(query)) return false;
    return t.lastPrice > 0;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (options.category) {
      case 'top_gainers':
        return b.priceChangePercent - a.priceChangePercent || b.quoteVolume - a.quoteVolume;
      case 'top_losers':
        return a.priceChangePercent - b.priceChangePercent || b.quoteVolume - a.quoteVolume;
      case 'volatility_leaders':
        return b.rangePct24h - a.rangePct24h || b.quoteVolume - a.quoteVolume;
      case 'hot_volume':
      default:
        return b.quoteVolume - a.quoteVolume;
    }
  });

  return sorted.slice(0, limit);
}

/**
 * Computes effective active scan pairs honoring Static Only / Hybrid / Dynamic modes,
 * active venue tradability (`exchangeInfo`), Top-N rank hysteresis + dwell time,
 * and strict Zero Orphan Lock for any symbol with an open position or pending limit order.
 */
export function resolveEffectiveWatchlist(params: {
  mode: PairSelectionMode;
  pinnedPairs: string[];
  trendingTickers: MarketTicker24h[];
  protectedSymbols?: Iterable<string>;
  currentlyActiveTrending?: Iterable<string>;
  dwellState?: WatchlistDwellState;
  tradableVenueSymbols?: Set<string> | null;
  tradingCfg: Pick<
    TradingConfig,
    | 'venue'
    | 'quoteAsset'
    | 'maxWatchlistPairs'
    | 'trendingCategory'
    | 'trendingTopN'
    | 'trendingMinQuoteVolumeUsdt'
    | 'trendingMinDwellMinutes'
    | 'trendingHysteresisRankBuffer'
  >;
  nowMs?: number;
}): ResolvedWatchlistEntry[] {
  const {
    mode,
    pinnedPairs,
    trendingTickers,
    protectedSymbols = [],
    currentlyActiveTrending = [],
    dwellState,
    tradableVenueSymbols,
    tradingCfg,
    nowMs = Date.now(),
  } = params;

  const cap = Math.max(1, Math.min(MAX_WATCHLIST_HARD_CAP, tradingCfg.maxWatchlistPairs ?? 20));
  const topN = Math.max(1, Math.min(cap, tradingCfg.trendingTopN ?? 5));
  const hysteresisBuf = Math.max(0, tradingCfg.trendingHysteresisRankBuffer ?? 3);
  const minDwellMs = Math.max(0, tradingCfg.trendingMinDwellMinutes ?? 15) * 60_000;
  const quoteAsset = tradingCfg.quoteAsset ?? 'USDT';
  const minQuoteVol = tradingCfg.trendingMinQuoteVolumeUsdt ?? 10_000_000;
  const category = tradingCfg.trendingCategory ?? 'hot_volume';

  const isTradableOnVenue = (sym: string): boolean => {
    if (!tradableVenueSymbols || tradableVenueSymbols.size === 0) return true;
    return tradableVenueSymbols.has(sym);
  };

  const out: ResolvedWatchlistEntry[] = [];
  const added = new Set<string>();

  const pushUnique = (sym: string, tag: PairSourceTag) => {
    const clean = sanitizeTradingSymbol(sym);
    if (!clean || added.has(clean)) return;
    added.add(clean);
    out.push({ symbol: clean, sourceTag: tag });
  };

  // 1. Always lock symbols carrying an open position or resting pending limit order (Zero Orphan Guarantee)
  for (const sym of protectedSymbols) {
    pushUnique(sym, 'protected_position');
  }

  // 2. Include user's pinned watchlist pairs in `static` and `hybrid` modes
  if (mode === 'static' || mode === 'hybrid') {
    for (const sym of normalizeSymbolList(pinnedPairs)) {
      if (out.length >= cap) break;
      if (isTradableOnVenue(sym) || added.has(sym)) {
        pushUnique(sym, 'pinned');
      }
    }
  }

  // 3. Populate trending slots in `hybrid` and `dynamic` modes with hysteresis + dwell protection
  if (mode === 'hybrid' || mode === 'dynamic') {
    const targetTrendingLimit = mode === 'dynamic' ? topN : Math.min(topN, Math.max(0, cap - out.length));
    const rankedPool = rankScreenerTickers(trendingTickers, {
      category,
      quoteAsset,
      minQuoteVolumeUsdt: minQuoteVol,
      onlyTradable: true,
      limit: Math.max(targetTrendingLimit + hysteresisBuf + 5, 25),
    }).filter((t) => isTradableOnVenue(t.symbol));

    const rankBySymbol = new Map<string, number>();
    rankedPool.forEach((t, idx) => rankBySymbol.set(t.symbol, idx));

    const retainedTrending: string[] = [];
    for (const prevSym of currentlyActiveTrending) {
      const sym = sanitizeTradingSymbol(prevSym);
      if (!sym || added.has(sym) || !isTradableOnVenue(sym)) continue;
      const rank = rankBySymbol.get(sym);
      const enteredAt = dwellState?.enteredAtMs.get(sym) ?? 0;
      const withinDwell = enteredAt > 0 && nowMs - enteredAt < minDwellMs;
      const withinHysteresis = rank !== undefined && rank < targetTrendingLimit + hysteresisBuf;
      if ((withinDwell || withinHysteresis) && retainedTrending.length < targetTrendingLimit) {
        retainedTrending.push(sym);
      }
    }

    for (const sym of retainedTrending) {
      if (out.length >= cap) break;
      pushUnique(sym, 'trending');
    }

    let trendingCount = out.filter((e) => e.sourceTag === 'trending').length;
    for (const t of rankedPool) {
      if (out.length >= cap || trendingCount >= targetTrendingLimit) break;
      if (!added.has(t.symbol)) {
        if (dwellState && !dwellState.enteredAtMs.has(t.symbol)) {
          dwellState.enteredAtMs.set(t.symbol, nowMs);
        }
        pushUnique(t.symbol, 'trending');
        trendingCount += 1;
      }
    }

    if (dwellState) {
      const activeSet = new Set(out.map((e) => e.symbol));
      for (const k of dwellState.enteredAtMs.keys()) {
        if (!activeSet.has(k)) {
          dwellState.enteredAtMs.delete(k);
        }
      }
    }

    // Offline / sandbox fallback for Dynamic mode before first ticker arrives: fall back to pinnedPairs temporarily
    if (mode === 'dynamic' && out.length === 0) {
      for (const sym of normalizeSymbolList(pinnedPairs).slice(0, topN)) {
        if (out.length >= cap) break;
        if (isTradableOnVenue(sym)) {
          pushUnique(sym, 'trending');
        }
      }
    }
  }

  return out;
}
