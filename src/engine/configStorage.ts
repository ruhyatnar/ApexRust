import { DEFAULT_BOT_CONFIG } from './simulator';
import type { BotConfig, ExecutionAccountMode, UtcTimeWindow } from './types';

export const BOT_CONFIG_STORAGE_KEY = 'apexrust_bot_config_v1';
export const UI_STATE_STORAGE_KEY = 'apexrust_ui_state_v1';

export interface PersistedWorkspaceUiState {
  accountMode: ExecutionAccountMode;
  section: 'trade' | 'markets' | 'orders' | 'bot' | 'signal' | 'rust';
  botSubTab: 'strategy' | 'features' | 'risk' | 'credentials' | 'git' | 'vps';
  selectedSymbol: string;
  environment?: 'Testnet' | 'Production';
  paperFeedSource?: 'Simulated' | 'BinanceLive';
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

  const merged: BotConfig = {
    trading: {
      ...base.trading,
      ...(tradingRaw as Partial<BotConfig['trading']>),
      pairs:
        Array.isArray(tradingRaw.pairs) &&
        tradingRaw.pairs.length > 0 &&
        tradingRaw.pairs.every((p) => typeof p === 'string')
          ? (tradingRaw.pairs as string[])
          : base.trading.pairs,
    },
    indicators: {
      ...base.indicators,
      ...(indicatorsRaw as Partial<BotConfig['indicators']>),
    },
    exits: {
      ...base.exits,
      ...(exitsRaw as Partial<BotConfig['exits']>),
    },
    risk: {
      ...base.risk,
      ...(riskRaw as Partial<BotConfig['risk']>),
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
