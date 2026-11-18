import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEnvValue, parseEnv, renderEnv } from './envFile.mjs';

test('parseEnv handles quotes, exports, comments, and roundtrips formatEnvValue', () => {
  const parsed = parseEnv(`
# header comment
PORT=3000
HOST=127.0.0.1
export BINANCE_API_KEY="abc#123=xyz" # trailing note
SINGLE='keep literal \\n' # single inline note
INLINE=val # comment
  `);
  assert.equal(parsed.PORT, '3000');
  assert.equal(parsed.HOST, '127.0.0.1');
  assert.equal(parsed.BINANCE_API_KEY, 'abc#123=xyz');
  assert.equal(parsed.SINGLE, 'keep literal \\n');
  assert.equal(parsed.INLINE, 'val');

  assert.equal(formatEnvValue('plain'), 'plain');
  assert.equal(formatEnvValue('has space'), '"has space"');
  assert.equal(formatEnvValue('has#hash'), '"has#hash"');
  assert.equal(formatEnvValue('a\rb'), '"a\\rb"');
});

test('renderEnv preserves template comments and only uncomments non-empty commented keys', () => {
  const template = [
    '# Comment',
    'PORT=3000',
    'HOST=127.0.0.1',
    'BINANCE_API_KEY=',
    '# APEXRUST_PROXY_TOKEN=',
    '',
  ].join('\n');

  const rendered = renderEnv(template, {
    PORT: '3100',
    HOST: '0.0.0.0',
    BINANCE_API_KEY: 'my key',
    APEXRUST_PROXY_TOKEN: '',
    EXTRA_VAR: '1',
  });

  assert.match(rendered, /^# Comment$/m);
  assert.match(rendered, /^PORT=3100$/m);
  assert.match(rendered, /^HOST=0\.0\.0\.0$/m);
  assert.match(rendered, /^BINANCE_API_KEY="my key"$/m);
  assert.match(rendered, /^# APEXRUST_PROXY_TOKEN=$/m);
  assert.match(rendered, /^EXTRA_VAR=1$/m);

  const reParsed = parseEnv(rendered);
  assert.equal(reParsed.PORT, '3100');
  assert.equal(reParsed.BINANCE_API_KEY, 'my key');
  assert.equal(reParsed.APEXRUST_PROXY_TOKEN, undefined);
});
