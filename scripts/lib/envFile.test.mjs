import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENV_TEMPLATE,
  formatEnvValue,
  generateAccessToken,
  isPrivateOrLoopbackHost,
  maskAccessToken,
  parseEnv,
  renderEnv,
  validateAccessToken,
} from './envFile.mjs';
import { buildPlatformSpawnSpec, isWindowsBatchCommand } from './prereqs.mjs';
import { detectZeroTrustMeshIps } from './paths.mjs';

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
  const winRoundtrip = parseEnv(`WIN_PATH=${formatEnvValue('C:\\new\\folder\\temp')}`);
  assert.equal(winRoundtrip.WIN_PATH, 'C:\\new\\folder\\temp');
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

test('detectZeroTrustMeshIps recognizes Cloudflare One WARP and CGNAT interfaces across OS networkInterfaces shapes', () => {
  const detected = detectZeroTrustMeshIps({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '198.51.100.22', family: 4, internal: false }],
    CloudflareWARP: [{ address: '100.96.14.8', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.88.2.5', family: 4, internal: false }],
  });

  assert.equal(detected.length, 2);
  assert.equal(detected[0].ip, '100.96.14.8');
  assert.match(detected[0].kind, /Cloudflare One/);
  assert.equal(detected[1].ip, '100.88.2.5');
});

test('renderEnv uncomments VPS authority and vault settings from commented .env.example defaults', () => {
  const template = [
    'HOST=127.0.0.1',
    '# APEXRUST_ENGINE_AUTHORITY=browser',
    '# APEXRUST_PERSIST_VAULT=false',
    '# APEXRUST_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000',
    '',
  ].join('\n');

  const rendered = renderEnv(template, {
    HOST: '100.96.0.2',
    APEXRUST_ENGINE_AUTHORITY: 'daemon',
    APEXRUST_PERSIST_VAULT: 'true',
    APEXRUST_ALLOWED_ORIGINS: 'http://localhost:3000',
  });

  const parsed = parseEnv(rendered);
  assert.equal(parsed.HOST, '100.96.0.2');
  assert.equal(parsed.APEXRUST_ENGINE_AUTHORITY, 'daemon');
  assert.equal(parsed.APEXRUST_PERSIST_VAULT, 'true');
  assert.equal(parsed.APEXRUST_ALLOWED_ORIGINS, 'http://localhost:3000');
});

test('access token helpers generate, validate, mask, and check private bind hosts cleanly', () => {
  const tok = generateAccessToken();
  assert.equal(tok.length, 48);
  assert.match(tok, /^[0-9a-f]{48}$/);
  assert.equal(generateAccessToken(16).length, 32);
  assert.throws(() => generateAccessToken(8), /between 16/);

  assert.equal(validateAccessToken(`  ${tok}  `), tok);
  assert.throws(() => validateAccessToken('too-short'), /at least 32/);
  assert.throws(() => validateAccessToken(`${tok} extra`), /spaces/);

  assert.equal(maskAccessToken(''), '(not set)');
  assert.equal(maskAccessToken(tok), `${tok.slice(0, 4)}...${tok.slice(-4)} (48 chars)`);

  assert.equal(isPrivateOrLoopbackHost('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('100.96.0.2'), true);
  assert.equal(isPrivateOrLoopbackHost('192.168.1.50'), true);
  assert.equal(isPrivateOrLoopbackHost('0.0.0.0'), false);
  assert.equal(isPrivateOrLoopbackHost('::'), false);
});

test('DEFAULT_ENV_TEMPLATE and buildPlatformSpawnSpec handle Windows .cmd without shell=true (DEP0190)', () => {
  const rendered = renderEnv(DEFAULT_ENV_TEMPLATE, {
    PORT: '3000',
    HOST: '127.0.0.1',
    APEXRUST_PROXY_TOKEN: '0123456789abcdef0123456789abcdef',
  });
  const parsed = parseEnv(rendered);
  assert.equal(parsed.PORT, '3000');
  assert.equal(parsed.HOST, '127.0.0.1');
  assert.equal(parsed.APEXRUST_PROXY_TOKEN, '0123456789abcdef0123456789abcdef');

  assert.equal(isWindowsBatchCommand('npm'), true);
  assert.equal(isWindowsBatchCommand('npm.cmd'), true);
  assert.equal(isWindowsBatchCommand('git'), false);

  const gitSpec = buildPlatformSpawnSpec('git', ['--version'], {}, true);
  assert.equal(gitSpec.file, 'git');
  assert.deepEqual(gitSpec.args, ['--version']);
  assert.equal(gitSpec.options.shell, false);

  const npmSpec = buildPlatformSpawnSpec('npm', ['run', 'build'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, true);
  assert.equal(npmSpec.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(npmSpec.options.shell, false);
  assert.equal(npmSpec.options.windowsVerbatimArguments, true);
  assert.equal(npmSpec.args[0], '/d');
  assert.equal(npmSpec.args[2], '/c');
  assert.match(npmSpec.args[3], /^"npm\.cmd run build"$/);
});
