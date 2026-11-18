import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atLeast,
  compareVersions,
  nodeSatisfies,
  parseVersion,
  rustSatisfies,
} from './semver.mjs';

test('parseVersion extracts major.minor.patch from tool outputs', () => {
  assert.deepEqual(parseVersion('v22.22.1'), [22, 22, 1]);
  assert.deepEqual(parseVersion('rustc 1.86.0 (05f9846f8 2025-03-31)'), [1, 86, 0]);
  assert.deepEqual(parseVersion('1.85'), [1, 85, 0]);
  assert.equal(parseVersion('unknown'), null);
});

test('compareVersions and atLeast order versions accurately', () => {
  assert.equal(compareVersions([22, 12, 0], [22, 12, 0]), 0);
  assert.equal(compareVersions([22, 11, 9], [22, 12, 0]), -1);
  assert.equal(atLeast('1.85.1', '1.85.0'), true);
  assert.equal(atLeast('1.84.9', '1.85.0'), false);
});

test('nodeSatisfies enforces ^20.19.0 || >=22.12.0', () => {
  assert.equal(nodeSatisfies('v20.19.0'), true);
  assert.equal(nodeSatisfies('v20.18.9'), false);
  assert.equal(nodeSatisfies('v21.7.3'), false);
  assert.equal(nodeSatisfies('v22.11.0'), false);
  assert.equal(nodeSatisfies('v22.12.0'), true);
  assert.equal(nodeSatisfies('v24.0.0'), true);
});

test('rustSatisfies enforces >= 1.85.0', () => {
  assert.equal(rustSatisfies('rustc 1.84.1'), false);
  assert.equal(rustSatisfies('rustc 1.85.0'), true);
  assert.equal(rustSatisfies('rustc 1.90.0-nightly'), true);
});
