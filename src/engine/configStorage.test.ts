import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_CONFIG_STORAGE_KEY,
  clearPersistedBotConfig,
  loadPersistedBotConfig,
  loadPersistedWorkspaceUiState,
  mergeBotConfigWithDefaults,
  savePersistedBotConfig,
  savePersistedWorkspaceUiState,
  UI_STATE_STORAGE_KEY,
} from './configStorage';
import { DEFAULT_BOT_CONFIG } from './simulator';

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

test('savePersistedBotConfig and loadPersistedBotConfig round-trip all customized configuration sections', () => {
  const storage = createMockStorage();
  const customized = structuredClone(DEFAULT_BOT_CONFIG);
  customized.trading.mode = 'intraday';
  customized.trading.timeframe = '15m';
  customized.trading.venue = 'Futures';
  customized.trading.maxLeverage = 10;
  customized.trading.leverage = 7;
  customized.trading.positionSizingMode = 'half_kelly';
  customized.trading.baseRiskPerTradePct = 1.4;
  customized.indicators.volatilityAlertsEnabled = false;
  customized.indicators.atrSpikePctThreshold = 0.85;
  customized.indicators.atrExpansionRatioThreshold = 1.65;
  customized.indicators.volatilityAlertCooldownSec = 120;
  customized.exits.atrSlMultiplier = 2.1;
  customized.exits.breakEvenFeeBufferBps = 35;
  customized.risk.maxDailyDrawdownPct = 4.5;
  customized.automation.strategyProfile = 'ema_breakout';
  customized.automation.orderMethod = 'LIMIT_MAKER';
  customized.automation.autoOrderNotionalUsdt = 420;
  customized.features.volumeConfirmationFilter = true;
  customized.features.automatedTrading = false;

  savePersistedBotConfig(customized, storage);
  assert.ok(storage.getItem(BOT_CONFIG_STORAGE_KEY));

  const hydrated = loadPersistedBotConfig(storage);
  assert.equal(hydrated.trading.mode, 'intraday');
  assert.equal(hydrated.trading.timeframe, '15m');
  assert.equal(hydrated.trading.venue, 'Futures');
  assert.equal(hydrated.trading.maxLeverage, 10);
  assert.equal(hydrated.trading.leverage, 7);
  assert.equal(hydrated.trading.positionSizingMode, 'half_kelly');
  assert.equal(hydrated.trading.baseRiskPerTradePct, 1.4);
  assert.equal(hydrated.indicators.volatilityAlertsEnabled, false);
  assert.equal(hydrated.indicators.atrSpikePctThreshold, 0.85);
  assert.equal(hydrated.indicators.atrExpansionRatioThreshold, 1.65);
  assert.equal(hydrated.indicators.volatilityAlertCooldownSec, 120);
  assert.equal(hydrated.exits.atrSlMultiplier, 2.1);
  assert.equal(hydrated.exits.breakEvenFeeBufferBps, 35);
  assert.equal(hydrated.risk.maxDailyDrawdownPct, 4.5);
  assert.equal(hydrated.automation.strategyProfile, 'ema_breakout');
  assert.equal(hydrated.automation.orderMethod, 'LIMIT_MAKER');
  assert.equal(hydrated.automation.autoOrderNotionalUsdt, 420);
  assert.equal(hydrated.features.volumeConfirmationFilter, true);
  assert.equal(hydrated.features.automatedTrading, false);
  assert.equal(hydrated.automation.enabled, false);
});

test('mergeBotConfigWithDefaults safely backfills newly added fields onto legacy partial configs', () => {
  const legacyPartial = {
    trading: {
      mode: 'intraday',
      timeframe: '15m',
      baseRiskPerTradePct: 1.25,
    },
    indicators: {
      adxMinTrend: 30,
    },
    features: {
      trailingStop: false,
    },
  };

  const merged = mergeBotConfigWithDefaults(legacyPartial, DEFAULT_BOT_CONFIG);
  assert.equal(merged.trading.mode, 'intraday');
  assert.equal(merged.trading.timeframe, '15m');
  assert.equal(merged.trading.baseRiskPerTradePct, 1.25);
  assert.deepEqual(merged.trading.pairs, DEFAULT_BOT_CONFIG.trading.pairs);
  assert.equal(merged.indicators.adxMinTrend, 30);
  assert.equal(
    merged.indicators.atrSpikePctThreshold,
    DEFAULT_BOT_CONFIG.indicators.atrSpikePctThreshold
  );
  assert.equal(
    merged.indicators.volatilityAlertsEnabled,
    DEFAULT_BOT_CONFIG.indicators.volatilityAlertsEnabled
  );
  assert.equal(merged.features.trailingStop, false);
  assert.equal(merged.features.emaTrendFilter, DEFAULT_BOT_CONFIG.features.emaTrendFilter);
});

test('loadPersistedBotConfig falls back cleanly on corrupt JSON and clearPersistedBotConfig resets storage', () => {
  const storage = createMockStorage();
  storage.setItem(BOT_CONFIG_STORAGE_KEY, '{corrupt-json');

  const fallback = loadPersistedBotConfig(storage);
  assert.deepEqual(fallback, DEFAULT_BOT_CONFIG);

  const modified = structuredClone(DEFAULT_BOT_CONFIG);
  modified.exits.atrSlMultiplier = 2.8;
  savePersistedBotConfig(modified, storage);
  assert.equal(loadPersistedBotConfig(storage).exits.atrSlMultiplier, 2.8);

  const reset = clearPersistedBotConfig(storage);
  assert.equal(storage.getItem(BOT_CONFIG_STORAGE_KEY), null);
  assert.deepEqual(reset, DEFAULT_BOT_CONFIG);
});

test('savePersistedWorkspaceUiState and loadPersistedWorkspaceUiState persist tabs, symbol, environment, and feed source', () => {
  const storage = createMockStorage();
  savePersistedWorkspaceUiState(
    {
      accountMode: 'Live',
      section: 'bot',
      botSubTab: 'features',
      selectedSymbol: 'SOLUSDT',
      environment: 'Production',
      paperFeedSource: 'BinanceLive',
      paperRunning: false,
    },
    storage
  );

  assert.ok(storage.getItem(UI_STATE_STORAGE_KEY));
  const restored = loadPersistedWorkspaceUiState(storage);
  assert.equal(restored.accountMode, 'Live');
  assert.equal(restored.section, 'bot');
  assert.equal(restored.botSubTab, 'features');
  assert.equal(restored.selectedSymbol, 'SOLUSDT');
  assert.equal(restored.environment, 'Production');
  assert.equal(restored.paperFeedSource, 'BinanceLive');
  assert.equal(restored.paperRunning, false);
});

test('loadPersistedWorkspaceUiState defaults paperRunning to true when the field is absent', () => {
  const storage = createMockStorage();
  storage.setItem(
    UI_STATE_STORAGE_KEY,
    JSON.stringify({
      accountMode: 'Paper',
      section: 'trade',
      botSubTab: 'strategy',
      selectedSymbol: 'BTCUSDT',
      environment: 'Testnet',
      paperFeedSource: 'Simulated',
    })
  );

  assert.equal(loadPersistedWorkspaceUiState(storage).paperRunning, true);
  assert.equal(loadPersistedWorkspaceUiState(createMockStorage()).paperRunning, true);
});
