import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PATHS } from './paths.mjs';
import { applyTomlEdits, botPortFromToml, readTomlValue, renderBotToml } from './botToml.mjs';

test('applyTomlEdits modifies section keys while preserving comments and trailing array tables', () => {
  const sample = [
    '# Top comment',
    '[exchange]',
    'environment = "testnet" # keep this comment',
    'venue = "spot"',
    '',
    '[[symbols]]',
    'pair = "BTCUSDT"',
    '',
  ].join('\n');

  const out = applyTomlEdits(sample, {
    exchange: {
      environment: 'production',
      venue: 'futures',
      extra_flag: true,
    },
  });

  assert.match(out, /^# Top comment$/m);
  assert.match(out, /^environment = "production" # keep this comment$/m);
  assert.match(out, /^venue = "futures"$/m);
  assert.match(out, /^extra_flag = true$/m);
  assert.match(out, /^\[\[symbols\]\]$/m);
  assert.equal(readTomlValue(out, 'exchange', 'environment'), 'production');
  assert.equal(readTomlValue(out, 'exchange', 'extra_flag'), true);
});

test('renderBotToml always keeps paper_trading=true, armed_for_live_orders=false, and matches endpoints', () => {
  const example = fs.readFileSync(PATHS.botExample, 'utf8');

  const futuresProd = renderBotToml(example, {
    environment: 'production',
    venue: 'futures',
    leverage: 5,
    marginType: 'CROSSED',
    authMethod: 'ed25519',
    ed25519KeyPath: '/home/user/key.pem',
    botHost: '0.0.0.0',
    botPort: 8090,
    webPort: 3001,
  });

  assert.equal(readTomlValue(futuresProd, 'exchange', 'environment'), 'production');
  assert.equal(readTomlValue(futuresProd, 'exchange', 'venue'), 'futures');
  assert.equal(readTomlValue(futuresProd, 'exchange', 'leverage'), 5);
  assert.equal(readTomlValue(futuresProd, 'exchange', 'margin_type'), 'CROSSED');
  assert.equal(readTomlValue(futuresProd, 'exchange', 'paper_trading'), true);
  assert.equal(readTomlValue(futuresProd, 'exchange', 'rest_base_url'), 'https://fapi.binance.com');
  assert.equal(readTomlValue(futuresProd, 'exchange', 'ws_stream_url'), 'wss://fstream.binance.com/stream');
  assert.equal(readTomlValue(futuresProd, 'exchange.credentials', 'auth_method'), 'ed25519');
  assert.equal(readTomlValue(futuresProd, 'exchange.credentials', 'armed_for_live_orders'), false);
  assert.equal(readTomlValue(futuresProd, 'exchange.credentials', 'ed25519_key_path'), '/home/user/key.pem');
  assert.equal(readTomlValue(futuresProd, 'web', 'bind_addr'), '0.0.0.0:8090');
  assert.equal(readTomlValue(futuresProd, 'web', 'allowed_origin'), 'http://localhost:3001');
  assert.equal(botPortFromToml(futuresProd), 8090);

  const spotTestnet = renderBotToml(example, {
    environment: 'testnet',
    venue: 'spot',
    botHost: '127.0.0.1',
    botPort: 8080,
    webPort: 3000,
  });
  assert.equal(readTomlValue(spotTestnet, 'exchange', 'rest_base_url'), 'https://testnet.binance.vision');
  assert.equal(readTomlValue(spotTestnet, 'exchange', 'paper_trading'), true);
  assert.equal(readTomlValue(spotTestnet, 'exchange.credentials', 'armed_for_live_orders'), false);
  assert.equal(readTomlValue("[web]\nbind_addr = '127.0.0.1:99999'\n", 'web', 'bind_addr'), '127.0.0.1:99999');
  assert.equal(botPortFromToml("[web]\nbind_addr = '127.0.0.1:99999'\n", 8080), 8080);
});
