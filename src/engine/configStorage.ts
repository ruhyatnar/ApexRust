import { DEFAULT_BOT_CONFIG } from './simulator';
import type {
  BotConfig,
  ExecutionAccountMode,
  PairSelectionMode,
  TrendingCategory,
  TrendingRankingSource,
  UtcTimeWindow,
} from './types';
import { normalizeSymbolList } from './watchlist';

export const BOT_CONFIG_STORAGE_KEY = 'apexrust_bot_config_v1';
export const UI_STATE_STORAGE_KEY = 'apexrust_ui_state_v1';

export interface PersistedWorkspaceUiState {
  accountMode: ExecutionAccountMode;
  section: 'trade' | 'markets' | 'orders' | 'bot' | 'signal' | 'rust';
  botSubTab: 'strategy' | 'features' | 'risk' | 'credentials' | 'git' | 'vps';
  selectedSymbol: string;
  environment?: 'Testnet' | 'Production';
  paperFeedSource?: 'Simulated' | 'BinanceLive';
  /** Last Paper sandbox run state; Live is intentionally never auto-resumed on reload. */
  paperRunning?: boolean;
}

function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Deep-merges a candidate partial BotConfig object onto DEFAULT_BOT_CONFIG,
 * preserving all user customizations while guaranteeing every required field exists.
 */
export function mergeBotConfigWithDefaults(
  raw: unknown,
  defaults: BotConfig = DEFAULT_BOT_CONFIG
): BotConfig {
  const base = structuredClone(defaults);
  if (!isObjectRecord(raw)) {
    return base;
  }

  const tradingRaw = isObjectRecord(raw.trading) ? raw.trading : {};
  const indicatorsRaw = isObjectRecord(raw.indicators) ? raw.indicators : {};
  const exitsRaw = isObjectRecord(raw.exits) ? raw.exits : {};
  const riskRaw = isObjectRecord(raw.risk) ? raw.risk : {};
  const automationRaw = isObjectRecord(raw.automation) ? raw.automation : {};
  const featuresRaw = isObjectRecord(raw.features) ? raw.features : {};

  const rawSessionWindows = Array.isArray(automationRaw.sessionWindows)
    ? automationRaw.sessionWindows
        .filter(
          (w): w is UtcTimeWindow =>
            isObjectRecord(w) &&
            typeof w.id === 'string' &&
            typeof w.label === 'string' &&
            typeof w.startUtc === 'string' &&
            typeof w.endUtc === 'string' &&
            typeof w.enabled === 'boolean'
        )
        .map((w) => ({
          id: w.id,
          label: w.label,
          startUtc: w.startUtc,
          endUtc: w.endUtc,
          enabled: w.enabled,
        }))
    : null;

  const rawSelectionMode = tradingRaw.pairSelectionMode;
  const pairSelectionMode: PairSelectionMode =
    rawSelectionMode === 'static' || rawSelectionMode === 'hybrid' || rawSelectionMode === 'dynamic'
      ? rawSelectionMode
      : (base.trading.pairSelectionMode ?? 'hybrid');

  const rawCategory = tradingRaw.trendingCategory;
  const trendingCategory: TrendingCategory =
    rawCategory === 'hot_volume' ||
    rawCategory === 'top_gainers' ||
    rawCategory === 'top_losers' ||
    rawCategory === 'volatility_leaders' ||
    rawCategory === 'cts_momentum'
      ? rawCategory
      : (base.trading.trendingCategory ?? 'hot_volume');

  const rawRankingSource = tradingRaw.rankingSource;
  const rankingSource: TrendingRankingSource =
    rawRankingSource === 'auto' ||
    rawRankingSource === 'production' ||
    rawRankingSource === 'environment'
      ? rawRankingSource
      : (base.trading.rankingSource ?? 'auto');

  const maxLeverage = Math.max(
    1,
    Math.min(20, Math.round(Number(tradingRaw.maxLeverage ?? base.trading.maxLeverage ?? 3)))
  );

  const merged: BotConfig = {
    trading: {
      ...base.trading,
      ...(tradingRaw as Partial<BotConfig['trading']>),
      maxLeverage,
      leverage: Math.min(
        maxLeverage,
        Math.max(1, Math.round(Number(tradingRaw.leverage ?? base.trading.leverage ?? 3)))
      ),
      ctsRvolWeight: Math.max(0, Number(tradingRaw.ctsRvolWeight ?? base.trading.ctsRvolWeight ?? 0.4)),
      ctsMomentumWeight: Math.max(
        0,
        Number(tradingRaw.ctsMomentumWeight ?? base.trading.ctsMomentumWeight ?? 0.4)
      ),
      ctsVolumeWeight: Math.max(
        0,
        Number(tradingRaw.ctsVolumeWeight ?? base.trading.ctsVolumeWeight ?? 0.2)
      ),
      ctsMinRvol: Math.max(0, Number(tradingRaw.ctsMinRvol ?? base.trading.ctsMinRvol ?? 1.2)),
      pairs: normalizeSymbolList(tradingRaw.pairs, base.trading.pairs),
      pairSelectionMode,
      trendingCategory,
      rankingSource,
      maxWatchlistPairs: Math.min(
        40,
        Math.max(1, Math.round(Number(tradingRaw.maxWatchlistPairs ?? base.trading.maxWatchlistPairs ?? 20)))
      ),
      trendingTopN: Math.min(
        20,
        Math.max(1, Math.round(Number(tradingRaw.trendingTopN ?? base.trading.trendingTopN ?? 5)))
      ),
      trendingMinQuoteVolumeUsdt: Math.max(
        0,
        Number(tradingRaw.trendingMinQuoteVolumeUsdt ?? base.trading.trendingMinQuoteVolumeUsdt ?? 10_000_000)
      ),
      trendingMinDwellMinutes: Math.max(
        0,
        Math.round(Number(tradingRaw.trendingMinDwellMinutes ?? base.trading.trendingMinDwellMinutes ?? 15))
      ),
      trendingHysteresisRankBuffer: Math.max(
        0,
        Math.round(Number(tradingRaw.trendingHysteresisRankBuffer ?? base.trading.trendingHysteresisRankBuffer ?? 3))
      ),
      maxSameDirectionPositions: Math.max(
        0,
        Math.round(Number(tradingRaw.maxSameDirectionPositions ?? base.trading.maxSameDirectionPositions ?? 2))
      ),
    },
    indicators: {
      ...base.indicators,
      ...(indicatorsRaw as Partial<BotConfig['indicators']>),
      donchianLookback: Math.max(
        3,
        Math.min(200, Math.round(Number(indicatorsRaw.donchianLookback ?? base.indicators.donchianLookback ?? 20)))
      ),
      atrExpansionMinRatio: Math.max(
        0.5,
        Number(indicatorsRaw.atrExpansionMinRatio ?? base.indicators.atrExpansionMinRatio ?? 1.15)
      ),
      htfEmaPeriod: Math.max(
        20,
        Math.min(500, Math.round(Number(indicatorsRaw.htfEmaPeriod ?? base.indicators.htfEmaPeriod ?? 200)))
      ),
      obiLevels: Math.max(1, Math.min(50, Math.round(Number(indicatorsRaw.obiLevels ?? base.indicators.obiLevels ?? 10)))),
      obiMinImbalance: Math.min(
        1,
        Math.max(0, Number(indicatorsRaw.obiMinImbalance ?? base.indicators.obiMinImbalance ?? 0.35))
      ),
    },
    exits: {
      ...base.exits,
      ...(exitsRaw as Partial<BotConfig['exits']>),
    },
    risk: {
      ...base.risk,
      ...(riskRaw as Partial<BotConfig['risk']>),
      btcCrashThresholdPct: Math.max(
        0.1,
        Number(riskRaw.btcCrashThresholdPct ?? base.risk.btcCrashThresholdPct ?? 1.5)
      ),
      btcCrashWindowMinutes: Math.max(
        1,
        Math.min(240, Math.round(Number(riskRaw.btcCrashWindowMinutes ?? base.risk.btcCrashWindowMinutes ?? 15)))
      ),
      btcCrashMaxStalenessSec: Math.max(
        5,
        Math.min(
          3600,
          Math.round(Number(riskRaw.btcCrashMaxStalenessSec ?? base.risk.btcCrashMaxStalenessSec ?? 120))
        )
      ),
    },
    automation: {
      ...base.automation,
      ...(automationRaw as Partial<BotConfig['automation']>),
      sessionWindows:
        rawSessionWindows !== null
          ? rawSessionWindows
          : structuredClone(base.automation.sessionWindows),
    },
    features: {
      ...base.features,
      ...(featuresRaw as Partial<BotConfig['features']>),
    },
  };

  if (merged.trading.venue === 'Spot') {
    merged.automation.directionPolicy = 'long_only';
    merged.automation.autoFlipOnReversal = false;
  }

  // Keep automatedTrading feature flag and automation.enabled aligned
  if (typeof featuresRaw.automatedTrading === 'boolean') {
    merged.automation.enabled = featuresRaw.automatedTrading;
  } else if (typeof automationRaw.enabled === 'boolean') {
    merged.features.automatedTrading = automationRaw.enabled;
  }

  return merged;
}

export function loadPersistedBotConfig(
  storage?: Pick<Storage, 'getItem'> | null
): BotConfig {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;

  if (!targetStorage) {
    return structuredClone(DEFAULT_BOT_CONFIG);
  }

  try {
    const rawStr = targetStorage.getItem(BOT_CONFIG_STORAGE_KEY);
    if (!rawStr) {
      return structuredClone(DEFAULT_BOT_CONFIG);
    }
    const parsed = JSON.parse(rawStr) as unknown;
    return mergeBotConfigWithDefaults(parsed, DEFAULT_BOT_CONFIG);
  } catch {
    return structuredClone(DEFAULT_BOT_CONFIG);
  }
}

export function savePersistedBotConfig(
  config: BotConfig,
  storage?: Pick<Storage, 'setItem'> | null
): void {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;

  if (!targetStorage) return;

  try {
    targetStorage.setItem(BOT_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function clearPersistedBotConfig(
  storage?: Pick<Storage, 'removeItem'> | null
): BotConfig {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;

  if (targetStorage) {
    try {
      targetStorage.removeItem(BOT_CONFIG_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
  return structuredClone(DEFAULT_BOT_CONFIG);
}

export function loadPersistedWorkspaceUiState(
  storage?: Pick<Storage, 'getItem'> | null
): PersistedWorkspaceUiState {
  const fallback: PersistedWorkspaceUiState = {
    accountMode: 'Paper',
    section: 'trade',
    botSubTab: 'strategy',
    selectedSymbol: 'BTCUSDT',
    environment: 'Testnet',
    paperFeedSource: 'Simulated',
    paperRunning: true,
  };

  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;

  if (!targetStorage) return fallback;

  try {
    const rawStr = targetStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!rawStr) return fallback;
    const parsed = JSON.parse(rawStr) as Partial<PersistedWorkspaceUiState>;
    return {
      accountMode: parsed.accountMode === 'Live' ? 'Live' : 'Paper',
      section:
        parsed.section === 'markets' ||
        parsed.section === 'orders' ||
        parsed.section === 'bot' ||
        parsed.section === 'signal' ||
        parsed.section === 'rust'
          ? parsed.section
          : 'trade',
      botSubTab:
        parsed.botSubTab === 'features' ||
        parsed.botSubTab === 'risk' ||
        parsed.botSubTab === 'credentials' ||
        parsed.botSubTab === 'git' ||
        parsed.botSubTab === 'vps'
          ? parsed.botSubTab
          : 'strategy',
      selectedSymbol:
        typeof parsed.selectedSymbol === 'string' && parsed.selectedSymbol.length > 0
          ? parsed.selectedSymbol
          : 'BTCUSDT',
      environment: parsed.environment === 'Production' ? 'Production' : 'Testnet',
      paperFeedSource: parsed.paperFeedSource === 'BinanceLive' ? 'BinanceLive' : 'Simulated',
      paperRunning: parsed.paperRunning !== false,
    };
  } catch {
    return fallback;
  }
}

export function savePersistedWorkspaceUiState(
  state: PersistedWorkspaceUiState,
  storage?: Pick<Storage, 'setItem'> | null
): void {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;

  if (!targetStorage) return;

  try {
    targetStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}
