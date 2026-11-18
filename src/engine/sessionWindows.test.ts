import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPersistedBotConfig,
  mergeBotConfigWithDefaults,
  savePersistedBotConfig,
} from './configStorage';
import {
  DEFAULT_UTC_SESSION_WINDOWS,
  evaluateUtcSessionWindows,
  isMinuteInUtcWindow,
  parseUtcTimeToMinutes,
} from './sessionWindows';
import { DEFAULT_BOT_CONFIG, SimulationRuntime } from './simulator';

test('parseUtcTimeToMinutes validates 24h HH:MM strings accurately', () => {
  assert.equal(parseUtcTimeToMinutes('00:00'), 0);
  assert.equal(parseUtcTimeToMinutes('07:30'), 450);
  assert.equal(parseUtcTimeToMinutes('23:59'), 1439);
  assert.equal(parseUtcTimeToMinutes('24:00'), null);
  assert.equal(parseUtcTimeToMinutes('12:60'), null);
  assert.equal(parseUtcTimeToMinutes('invalid'), null);
});

test('isMinuteInUtcWindow supports standard and overnight wrap UTC intervals', () => {
  // 07:00 (420) .. 11:00 (660)
  assert.equal(isMinuteInUtcWindow(420, 420, 660), true);
  assert.equal(isMinuteInUtcWindow(540, 420, 660), true);
  assert.equal(isMinuteInUtcWindow(660, 420, 660), false);
  assert.equal(isMinuteInUtcWindow(419, 420, 660), false);

  // Overnight wrap: 22:00 (1320) .. 02:00 (120)
  assert.equal(isMinuteInUtcWindow(1350, 1320, 120), true); // 22:30 UTC
  assert.equal(isMinuteInUtcWindow(60, 1320, 120), true); // 01:00 UTC
  assert.equal(isMinuteInUtcWindow(120, 1320, 120), false); // 02:00 UTC exclusive
  assert.equal(isMinuteInUtcWindow(720, 1320, 120), false); // 12:00 UTC
});

test('evaluateUtcSessionWindows allows 24/7 when filter disabled and restricts outside UTC windows when enabled', () => {
  const outsideMs = Date.UTC(2026, 10, 17, 5, 15, 0); // 05:15 UTC (between Asia & London)
  const insideMs = Date.UTC(2026, 10, 17, 13, 30, 0); // 13:30 UTC (inside London/NY Overlap 12:30-16:30)

  const bypass = evaluateUtcSessionWindows(outsideMs, DEFAULT_UTC_SESSION_WINDOWS, false);
  assert.equal(bypass.allowed, true);
  assert.equal(bypass.filterEnabled, false);

  const blocked = evaluateUtcSessionWindows(outsideMs, DEFAULT_UTC_SESSION_WINDOWS, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.currentUtcHHMM, '05:15');
  assert.match(blocked.reason, /Blocked at 05:15 UTC/);

  const active = evaluateUtcSessionWindows(insideMs, DEFAULT_UTC_SESSION_WINDOWS, true);
  assert.equal(active.allowed, true);
  assert.equal(active.activeWindow?.id, 'london-ny-overlap');

  const noEnabled = evaluateUtcSessionWindows(
    insideMs,
    DEFAULT_UTC_SESSION_WINDOWS.map((w) => ({ ...w, enabled: false })),
    true
  );
  assert.equal(noEnabled.allowed, false);
  assert.match(noEnabled.reason, /no active daily UTC liquidity windows enabled/);
});

test('SimulationRuntime restricts automated entry scans outside UTC windows while managing open exits 24/7', () => {
  const cfg = structuredClone(DEFAULT_BOT_CONFIG);
  cfg.features.sessionWindowFilter = true;
  cfg.automation.sessionWindows = [
    {
      id: 'london-open',
      label: 'London Open',
      startUtc: '07:00',
      endUtc: '11:00',
      enabled: true,
    },
  ];

  // Boot at 05:00 UTC (outside 07:00-11:00 UTC window)
  const outsideMs = Date.UTC(2026, 10, 17, 5, 0, 0);
  const rt = new SimulationRuntime(cfg, outsideMs, {
    accountMode: 'Paper',
    seedDemoData: true,
  });

  // 1. Automated scan outside UTC window must be blocked cleanly
  const scanBlocked = rt.runAutoScanNow(outsideMs);
  assert.equal(scanBlocked.scannedPairs, 0);
  assert.equal(scanBlocked.dispatched, 0);
  assert.match(rt.snapshot.autoStats.lastActionSummary ?? '', /Blocked at 05:00 UTC/);

  // 2. Existing open position (BTCUSDT from seedDemoData) still closes when TP2 hits outside UTC window
  const btc = rt.snapshot.pairs.find((p) => p.symbol === 'BTCUSDT')!;
  assert.ok(btc.openPosition);
  const tp2 = btc.openPosition.exitPlan.takeProfit2;
  const tradesBefore = rt.snapshot.recentTrades.length;

  rt.stepBar(outsideMs + 300_000, {
    symbol: 'BTCUSDT',
    candle: {
      openTimeMs: btc.candles[btc.candles.length - 1].openTimeMs + 300_000,
      open: btc.lastPrice,
      high: tp2 + 50,
      low: btc.lastPrice,
      close: tp2 + 25,
      volume: 1000,
      isClosed: true,
    },
  });

  assert.equal(btc.openPosition, null);
  assert.equal(rt.snapshot.recentTrades.length, tradesBefore + 1);

  // 3. Automated scan at 08:30 UTC (inside 07:00-11:00 UTC) runs normally
  const insideMs = Date.UTC(2026, 10, 17, 8, 30, 0);
  const scanAllowed = rt.runAutoScanNow(insideMs);
  assert.ok(scanAllowed.scannedPairs > 0);
});

test('configStorage persists sessionWindowFilter toggle and custom sessionWindows across reload', () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const customized = structuredClone(DEFAULT_BOT_CONFIG);
  customized.features.sessionWindowFilter = true;
  customized.automation.sessionWindows = [
    {
      id: 'overnight-asia',
      label: 'Tokyo Overnight',
      startUtc: '23:00',
      endUtc: '03:00',
      enabled: true,
    },
  ];

  savePersistedBotConfig(customized, mockStorage);
  const loaded = loadPersistedBotConfig(mockStorage);
  assert.equal(loaded.features.sessionWindowFilter, true);
  assert.equal(loaded.automation.sessionWindows?.length, 1);
  assert.equal(loaded.automation.sessionWindows?.[0].startUtc, '23:00');
  assert.equal(loaded.automation.sessionWindows?.[0].endUtc, '03:00');

  // Legacy config without sessionWindows safely receives defaults
  const legacy = mergeBotConfigWithDefaults({ features: { manualTrading: true } });
  assert.equal(legacy.features.sessionWindowFilter, false);
  assert.ok((legacy.automation.sessionWindows?.length ?? 0) >= 3);
});
