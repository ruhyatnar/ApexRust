import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveFillNotification,
  collectNewLiveFillNotifications,
  dispatchDesktopLiveFillNotifications,
  type DesktopNotificationConstructor,
} from './liveFillNotifications';
import type { BinanceExecutionRecord } from './types';

function makeExecRecord(
  overrides: Partial<BinanceExecutionRecord> = {}
): BinanceExecutionRecord {
  return {
    id: 'exec-entry-1-1760000000000',
    tradeId: 1,
    orderId: 9912345,
    orderListId: -1,
    clientOrderId: 'apex_entry_btcusdt_9912345',
    symbol: 'BTCUSDT',
    venue: 'Spot',
    environment: 'Testnet',
    accountMode: 'Live',
    lifecycle: 'ENTRY',
    side: 'Long',
    binanceSide: 'BUY',
    positionSide: 'LONG',
    orderType: 'MARKET',
    uiOrderType: 'MARKET',
    execType: 'TRADE',
    orderStatus: 'FILLED',
    timeInForce: 'GTC',
    price: 93500,
    entryPrice: 93500,
    origQty: 0.01,
    executedQty: 0.01,
    cummulativeQuoteQty: 935,
    commission: 0.935,
    commissionAsset: 'USDT',
    isMaker: false,
    leverage: 1,
    marginType: 'ISOLATED',
    realizedPnlUsdt: null,
    rMultiple: null,
    exitReason: null,
    strategyRationale: 'Live Spot MARKET Long BTCUSDT',
    transactTime: 1_760_000_000_000,
    ...overrides,
  };
}

test('buildLiveFillNotification includes order ID, venue, price, and exit PnL summary', () => {
  const entryNote = buildLiveFillNotification(makeExecRecord());
  assert.equal(entryNote.orderId, '9912345');
  assert.match(entryNote.title, /Live ENTRY Fill/);
  assert.match(entryNote.title, /#9912345/);
  assert.match(entryNote.body, /Order #9912345/);
  assert.match(entryNote.body, /BUY 0\.0100 BTCUSDT @ \$93500\.00 \(\$935\.00 USDT\)/);

  const exitNote = buildLiveFillNotification(
    makeExecRecord({
      id: 'exec-exit-2-1760000500000',
      orderId: 9912399,
      orderListId: 44120,
      lifecycle: 'EXIT',
      binanceSide: 'SELL',
      orderType: 'TAKE_PROFIT_LIMIT',
      price: 95200,
      realizedPnlUsdt: 17.0,
      rMultiple: 1.85,
      exitReason: 'TakeProfit2',
    })
  );
  assert.match(exitNote.title, /Live EXIT Fill/);
  assert.match(exitNote.body, /Order #9912399/);
  assert.match(exitNote.body, /PnL \+\$17\.00 \(\+1\.85R\) · TakeProfit2/);
  assert.match(exitNote.body, /OCO #44120/);
});

test('collectNewLiveFillNotifications ignores Paper records, historical syncs, and duplicates', () => {
  const notified = new Set<string>(['already-seen']);
  const records = [
    makeExecRecord({ id: 'live-newest', orderId: 202, transactTime: 2000 }),
    makeExecRecord({ id: 'live-first', orderId: 201, transactTime: 1000 }),
    makeExecRecord({ id: 'already-seen', orderId: 200 }),
    makeExecRecord({ id: 'paper-ignored', accountMode: 'Paper', orderId: 199 }),
    makeExecRecord({ id: 'binance-trade-BTCUSDT-55', orderId: 198 }),
    makeExecRecord({ id: 'live-sync-Spot-Testnet-BTCUSDT-77', orderId: 197 }),
  ];

  const firstPass = collectNewLiveFillNotifications(records, notified);
  assert.deepEqual(
    firstPass.map((n) => n.orderId),
    ['201', '202']
  );

  // Second pass with same records yields zero duplicates
  const secondPass = collectNewLiveFillNotifications(records, notified);
  assert.equal(secondPass.length, 0);
});

test('dispatchDesktopLiveFillNotifications dispatches only when Web Notification permission is granted', () => {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];

  class MockGrantedNotification {
    static readonly permission: NotificationPermission = 'granted';
    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
  }

  class MockDeniedNotification {
    static readonly permission: NotificationPermission = 'denied';
    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
  }

  const note = buildLiveFillNotification(makeExecRecord({ orderId: 778899 }));
  assert.equal(
    dispatchDesktopLiveFillNotifications(
      [note],
      MockDeniedNotification as unknown as DesktopNotificationConstructor
    ),
    0
  );
  assert.equal(calls.length, 0);

  assert.equal(
    dispatchDesktopLiveFillNotifications(
      [note],
      MockGrantedNotification as unknown as DesktopNotificationConstructor
    ),
    1
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /#778899/);
  assert.match(calls[0].options?.body ?? '', /Order #778899/);
  assert.equal(calls[0].options?.tag, 'apexrust-live-fill-exec-entry-1-1760000000000');
});
