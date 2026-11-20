import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderCountTracker } from './orderCountTracker';

function headerBag(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

test('OrderCountTracker stays unconstrained until Binance headers arrive', () => {
  const tracker = new OrderCountTracker();
  assert.deepEqual(tracker.check('Prod', 'Futures'), { constrained: false });
  assert.equal(tracker.get('Prod', 'Futures'), null);
});

test('OrderCountTracker blocks near the 10s ceiling with a 10s retry hint', () => {
  const tracker = new OrderCountTracker();
  tracker.report('Prod', 'Futures', headerBag({ 'X-MBX-ORDER-COUNT-10S': '250' }));
  const verdict = tracker.check('Prod', 'Futures');
  assert.equal(verdict.constrained, true);
  assert.equal(verdict.retryAfterSeconds, 10);
});

test('OrderCountTracker blocks near the 1m ceiling and keeps venues separate', () => {
  const tracker = new OrderCountTracker();
  tracker.report('Prod', 'Spot', headerBag({ 'X-MBX-ORDER-COUNT-1M': '1000' }));
  const spot = tracker.check('Prod', 'Spot');
  assert.equal(spot.constrained, true);
  assert.ok((spot.retryAfterSeconds ?? 0) >= 5);
  assert.equal(tracker.check('Prod', 'Futures').constrained, false);
  assert.equal(tracker.check('Testnet', 'Spot').constrained, false);
});

test('OrderCountTracker ignores zero or unparsable header values', () => {
  const tracker = new OrderCountTracker();
  tracker.report('Prod', 'Futures', headerBag({ 'X-MBX-ORDER-COUNT-10S': '0', 'X-MBX-ORDER-COUNT-1M': 'abc' }));
  assert.equal(tracker.get('Prod', 'Futures'), null);
});
