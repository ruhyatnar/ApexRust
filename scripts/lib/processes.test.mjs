import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHostPort, resolveComponentLaunchConfig } from './processes.mjs';

const BASE = { webPort: 3000, botPort: 8080, host: '127.0.0.1', botHost: '127.0.0.1' };

test('resolveComponentLaunchConfig applies --host and --lan to web while keeping bot internal on start both', () => {
  const webCfg = resolveComponentLaunchConfig({
    component: 'web',
    target: undefined,
    flags: { host: '0.0.0.0', token: 'tok-012345678901234567890123456789' },
    basePorts: BASE,
  });
  assert.equal(webCfg.bindHost, '0.0.0.0');
  assert.equal(webCfg.port, 3000);
  assert.deepEqual(webCfg.envOverrides, {
    HOST: '0.0.0.0',
    APEXRUST_PROXY_TOKEN: 'tok-012345678901234567890123456789',
  });
  assert.equal(webCfg.shouldRestart, true);

  const botCfg = resolveComponentLaunchConfig({
    component: 'bot',
    target: undefined,
    flags: { lan: true, token: 'tok-012345678901234567890123456789' },
    basePorts: BASE,
  });
  assert.equal(botCfg.bindHost, '127.0.0.1');
  assert.equal(botCfg.port, 8080);
  assert.equal(botCfg.envOverrides.BOT_WEB_BIND, undefined);
  assert.equal(botCfg.envOverrides.APEXRUST_WEB_TOKEN, 'tok-012345678901234567890123456789');
  assert.equal(botCfg.shouldRestart, false);
});

test('resolveComponentLaunchConfig applies --host and --bot-port to bot when target is bot', () => {
  const botCfg = resolveComponentLaunchConfig({
    component: 'bot',
    target: 'bot',
    flags: { host: '100.96.1.10', 'bot-port': '8180' },
    basePorts: BASE,
  });
  assert.equal(botCfg.bindHost, '100.96.1.10');
  assert.equal(botCfg.port, 8180);
  assert.equal(botCfg.envOverrides.BOT_WEB_BIND, '100.96.1.10:8180');
  assert.equal(botCfg.shouldRestart, true);

  const webCfg = resolveComponentLaunchConfig({
    component: 'web',
    target: undefined,
    flags: { 'web-port': '3100', 'bot-port': '8180' },
    basePorts: BASE,
  });
  assert.equal(webCfg.port, 3100);
  assert.equal(webCfg.envOverrides.PORT, '3100');
  assert.equal(webCfg.envOverrides.APEXRUST_ENGINE_URL, 'http://127.0.0.1:8180');
});

test('resolveComponentLaunchConfig formats IPv6 brackets and rejects invalid --host values', () => {
  assert.equal(formatHostPort('::1', 8080), '[::1]:8080');
  assert.equal(formatHostPort('0.0.0.0', 3000), '0.0.0.0:3000');
  assert.throws(
    () =>
      resolveComponentLaunchConfig({
        component: 'web',
        target: 'web',
        flags: { host: '0.0.0.0:3000' },
        basePorts: BASE,
      }),
    /--web-port/
  );
  assert.throws(
    () =>
      resolveComponentLaunchConfig({
        component: 'web',
        target: 'web',
        flags: { host: 'http://0.0.0.0' },
        basePorts: BASE,
      }),
    /Invalid --host/
  );
});
