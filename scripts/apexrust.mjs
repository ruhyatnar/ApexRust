#!/usr/bin/env node
// ApexRust Quant cross-platform setup, lifecycle, service, and diagnostics CLI.
// Uses only Node.js built-ins + local scripts/lib/*.mjs so it runs cleanly on fresh clones.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { botPortFromToml, readTomlValue, renderBotToml } from './lib/botToml.mjs';
import { parseEnv, renderEnv } from './lib/envFile.mjs';
import {
  COMPONENTS,
  IS_LINUX,
  IS_MAC,
  IS_WIN,
  PATHS,
  REPO_DIR,
  augmentPath,
  logFile,
} from './lib/paths.mjs';
import { checkPrerequisites, isPortFree, nextFreePort, runCapture } from './lib/prereqs.mjs';
import {
  ensureRuntimeDirs,
  fetchHealth,
  followFiles,
  isAlive,
  killTree,
  removePid,
  runningPid,
  startDetached,
  tailFile,
  waitForHealth,
  writePid,
} from './lib/processes.mjs';
import { closePrompts, confirm, input, isInteractive, secret, select, setNonInteractive } from './lib/prompt.mjs';
import {
  launchdLabel,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskScript,
  systemdUnitName,
  windowsTaskName,
} from './lib/services.mjs';

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
};

const info = (msg) => console.log(`${C.cyan}==>${C.reset} ${msg}`);
const ok = (msg) => console.log(`${C.green}[OK]${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}[WARN]${C.reset} ${msg}`);
const fail = (msg) => console.error(`${C.red}[FAIL]${C.reset} ${msg}`);

function printBanner() {
  console.log(`${C.bold}ApexRust Quant — Setup & Operations CLI${C.reset}`);
  console.log(`${C.dim}Repository: ${REPO_DIR}${C.reset}\n`);
}

function printHelp() {
  console.log(`Usage: ${IS_WIN ? 'apexrust.cmd' : './apexrust'} <command> [options]

Commands:
  setup                 Interactive (or flag-driven) wizard to check prereqs, build, and configure
  start [target]        Start web, bot, or both in the background (.apexrust/logs/)
  stop [target]         Stop running component(s) gracefully
  restart [target]      Restart component(s)
  status                Show running PIDs, health checks, URLs, and OS services
  logs [target]         Print or follow logs (-n <lines>, -f / --follow)
  doctor                Verify toolchains, configs, binaries, ports, and services
  update                git pull --ff-only, rebuild, and restart previously running services
  service <action>      Manage OS auto-start services: install | uninstall
  uninstall             Stop processes and remove OS services / runtime state (--purge deletes build/config)
  run <component>       Internal foreground supervisor used by detached runner and OS services

Targets: web | bot | both (default uses saved state from setup)

Setup / Service Flags:
  -y, --yes, --non-interactive   Accept defaults without prompting (required flags/env override)
  --components <web|bot|both>    Which components to build & configure
  --env <testnet|production>     Binance environment (bot.toml always starts with paper_trading=true)
  --venue <spot|futures>         Trading venue
  --auth <hmac|ed25519>          Credential auth method
  --api-key <key>                Binance API key (optional)
  --api-secret <secret>          Binance API secret (for HMAC)
  --key-path <path>              PKCS#8 PEM path (for Ed25519)
  --leverage <1-20>              Futures default leverage (default: 3)
  --margin <ISOLATED|CROSSED>    Futures margin type (default: ISOLATED)
  --web-port <port>              Express/UI port (default: 3000)
  --bot-port <port>              Rust daemon port (default: 8080)
  --host <ip> / --lan            Bind host (default: 127.0.0.1; --lan sets 0.0.0.0)
  --no-build                     Skip npm/cargo build steps during setup
  --no-start                     Do not start services after setup
  --service / --no-service       Install OS auto-start service during setup
  --system                       Linux only: install system-wide /etc/systemd/system unit (asks sudo)
  --linger / --no-linger         Linux only: enable/skip loginctl enable-linger for systemd --user
  --purge                        For uninstall: also delete .env, bot.toml, node_modules, dist, rust-bot/target
  -n, --lines <n>                Log tail line count (default: 80)
  -f, --follow                   Stream logs until Ctrl+C
`);
}

function parseCliArgs(argv) {
  const flags = {};
  const positionals = [];
  const valueFlags = new Set([
    'components', 'env', 'venue', 'auth', 'api-key', 'api-secret', 'key-path',
    'leverage', 'margin', 'web-port', 'bot-port', 'host', 'lines', 'n', 'log',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg === '-y') { flags.yes = true; continue; }
    if (arg === '-f') { flags.follow = true; continue; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg.startsWith('-n') && arg.length > 2 && !arg.startsWith('--')) {
      flags.lines = arg.startsWith('-n=') ? arg.slice(3) : arg.slice(2);
      continue;
    }
    if (arg === '-n') {
      if (i + 1 >= argv.length) throw new Error('Missing value for -n');
      flags.lines = argv[++i];
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg.startsWith('--no-')) {
      flags[arg.slice(5)] = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.has(name)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for --${name}`);
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  fs.mkdirSync(PATHS.stateDir, { recursive: true });
  const merged = { ...readState(), ...next };
  fs.writeFileSync(PATHS.stateFile, `${JSON.stringify(merged, null, 2)}\n`);
}

function readCurrentEnv() {
  try {
    return parseEnv(fs.readFileSync(PATHS.env, 'utf8'));
  } catch {
    return {};
  }
}

function readCurrentTomlText() {
  try {
    return fs.readFileSync(PATHS.botToml, 'utf8');
  } catch {
    return '';
  }
}

function resolvePorts() {
  const envMap = readCurrentEnv();
  const state = readState();
  const tomlText = readCurrentTomlText();
  const webPort = Number(envMap.PORT || state.webPort || 3000) || 3000;
  const host = envMap.HOST || state.host || '127.0.0.1';
  const botPort = tomlText ? botPortFromToml(tomlText, state.botPort || 8080) : Number(state.botPort || 8080) || 8080;
  return { webPort, botPort, host };
}

function resolveTargetComponents(target) {
  if (target === 'web' || target === 'bot') return [target];
  if (target === 'both' || target === 'all') return [...COMPONENTS];
  if (target) {
    throw new Error(`Unknown component target "${target}". Expected: web, bot, or both.`);
  }
  const state = readState();
  if (state.components === 'web') return ['web'];
  if (state.components === 'bot') return ['bot'];
  if (state.components === 'both') return [...COMPONENTS];
  return fs.existsSync(PATHS.botBinary) || fs.existsSync(PATHS.botToml) ? [...COMPONENTS] : ['web'];
}

function runStreaming(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_DIR,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? 'inherit',
    shell: IS_WIN && !cmd.endsWith('.exe'),
    windowsHide: true,
  });
  if (res.error) return { ok: false, status: 1, error: res.error.message };
  return { ok: res.status === 0, status: res.status ?? 1 };
}

function npmCommand() {
  return IS_WIN ? 'npm.cmd' : 'npm';
}

function chmodOwnerOnly(filePath) {
  if (IS_WIN) return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore on filesystems without POSIX modes
  }
}

async function confirmSudoAndRun(cmdArgs) {
  const rendered = `sudo ${cmdArgs.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const res = spawnSync(cmdArgs[0], cmdArgs.slice(1), { encoding: 'utf8', stdio: 'inherit' });
    if (res.error || res.status !== 0) {
      throw new Error(`Command failed: ${cmdArgs.join(' ')}`);
    }
    return res;
  }
  console.log(`\n${C.yellow}Administrator approval required for:${C.reset}\n  ${rendered}`);
  if (!isInteractive()) {
    throw new Error(`Refusing to run sudo in non-interactive mode. Run manually:\n  ${rendered}`);
  }
  const approved = await confirm('Run this command with sudo?', false);
  if (!approved) {
    throw new Error('Cancelled by user.');
  }
  const res = spawnSync('sudo', cmdArgs, { encoding: 'utf8', stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    throw new Error(`Command failed: ${rendered}`);
  }
  return res;
}

function parseBooleanFlag(val, fallback) {
  if (typeof val === 'boolean') return val;
  return fallback;
}

function normalizeComponentsFlag(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === 'web' || v === 'bot' || v === 'both') return v;
  throw new Error(`Invalid --components "${raw}". Choose web, bot, or both.`);
}

function validatePortNumber(raw, exclude = []) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`Invalid port "${raw}". Enter an integer between 1024 and 65535.`);
  }
  if (exclude.includes(n)) {
    throw new Error(`Port ${n} conflicts with the other service.`);
  }
  return n;
}

async function resolvePortChoice(label, preferred, host, exclude = [], ignoreBusy = false) {
  let candidate = preferred;
  const probeHost = host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const free = await isPortFree(candidate, probeHost);
  if (!free && !ignoreBusy) {
    const suggested = await nextFreePort(candidate + 1, probeHost, exclude);
    warn(`${label} port ${candidate} is already in use (suggested free port: ${suggested}).`);
    candidate = suggested;
  }
  if (!isInteractive()) return candidate;
  const chosen = await input(`${label} port`, String(candidate), (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return 'Enter a port between 1024 and 65535';
    if (exclude.includes(n)) return `Port ${n} conflicts with the other service`;
    return null;
  });
  return Number(chosen);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
async function cmdSetup(flags) {
  printBanner();
  augmentPath();

  const existingEnv = readCurrentEnv();
  const existingToml = readCurrentTomlText();
  const state = readState();

  const rustQuick = checkPrerequisites({ needRust: true });
  const rustReady = rustQuick.find((r) => r.id === 'rust')?.ok && rustQuick.find((r) => r.id === 'buildtools')?.ok;

  let components = normalizeComponentsFlag(flags.components);
  if (!components) {
    const defaultComp = state.components ?? (rustReady ? 'both' : 'web');
    components = await select(
      'Which components do you want to set up?',
      [
        { value: 'both', label: 'Web UI + Rust Trading Engine (full local stack)' },
        { value: 'web', label: 'Web UI & Express Proxy only (fastest — no Rust build)' },
        { value: 'bot', label: 'Rust Trading Engine Daemon only' },
      ],
      defaultComp
    );
  }
  const needRust = components !== 'web';
  const needWeb = components !== 'bot';

  info('Checking system prerequisites...');
  const checks = checkPrerequisites({ needRust });
  let failed = 0;
  for (const item of checks) {
    if (item.ok) {
      ok(`${item.name}: ${item.detail}`);
    } else {
      failed += 1;
      fail(`${item.name}: ${item.detail}`);
      console.log(`       Fix: ${item.fix}`);
    }
  }
  if (failed > 0) {
    throw new Error('Missing required prerequisites. Install the missing item(s) above and re-run setup.');
  }
  console.log('');

  // Configuration choices
  const existingEnvName = (readTomlValue(existingToml, 'exchange', 'environment') || existingEnv.BINANCE_ENVIRONMENT || 'testnet').toLowerCase();
  const envFlag = flags.env ? String(flags.env).toLowerCase() : null;
  if (envFlag && envFlag !== 'production' && envFlag !== 'testnet') {
    throw new Error(`Invalid --env "${flags.env}". Choose testnet or production.`);
  }
  const environment = envFlag
    ?? (await select(
        'Binance API environment (Paper Trading stays ON in bot.toml for safety):',
        [
          { value: 'testnet', label: 'Testnet (Recommended for safe testing)' },
          { value: 'production', label: 'Production market data / paper mode' },
        ],
        existingEnvName === 'production' ? 'production' : 'testnet'
      ));

  const existingVenue = (readTomlValue(existingToml, 'exchange', 'venue') || existingEnv.BINANCE_VENUE || 'spot').toLowerCase();
  const venueFlag = flags.venue ? String(flags.venue).toLowerCase() : null;
  if (venueFlag && venueFlag !== 'spot' && venueFlag !== 'futures') {
    throw new Error(`Invalid --venue "${flags.venue}". Choose spot or futures.`);
  }
  const venue = venueFlag
    ?? (await select(
        'Trading venue:',
        [
          { value: 'spot', label: 'Spot' },
          { value: 'futures', label: 'USD-M Futures' },
        ],
        existingVenue === 'futures' ? 'futures' : 'spot'
      ));

  let leverage = Number(flags.leverage || readTomlValue(existingToml, 'exchange', 'leverage') || 3) || 3;
  const marginRaw = flags.margin ? String(flags.margin).toUpperCase() : null;
  if (marginRaw && marginRaw !== 'ISOLATED' && marginRaw !== 'CROSSED') {
    throw new Error(`Invalid --margin "${flags.margin}". Choose ISOLATED or CROSSED.`);
  }
  let marginType = marginRaw || String(readTomlValue(existingToml, 'exchange', 'margin_type') || 'ISOLATED').toUpperCase();
  if (venue === 'futures') {
    if (!flags.leverage && isInteractive()) {
      const levStr = await input('Default Futures leverage (1-20)', String(leverage), (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 20 ? null : 'Enter an integer from 1 to 20';
      });
      leverage = Number(levStr);
    } else if (!Number.isInteger(leverage) || leverage < 1 || leverage > 20) {
      throw new Error(`Invalid --leverage "${flags.leverage}". Enter an integer between 1 and 20.`);
    }
    if (!flags.margin) {
      marginType = await select(
        'Default Futures margin type:',
        [
          { value: 'ISOLATED', label: 'ISOLATED (Recommended — limits risk per position)' },
          { value: 'CROSSED', label: 'CROSSED' },
        ],
        marginType === 'CROSSED' ? 'CROSSED' : 'ISOLATED'
      );
    }
  }

  // Credentials (optional)
  const hadKey = Boolean(existingEnv.BINANCE_API_KEY);
  const hadSecret = Boolean(existingEnv.BINANCE_API_SECRET);
  const hadKeyPath = Boolean(existingEnv.BINANCE_PRIVATE_KEY_PATH);
  const existingAuth = (existingEnv.BINANCE_AUTH_METHOD || readTomlValue(existingToml, 'exchange.credentials', 'auth_method') || 'hmac-sha256').toLowerCase();

  let credMode;
  if (flags.auth) {
    const a = String(flags.auth).toLowerCase();
    if (a === 'ed25519') credMode = 'ed25519';
    else if (a === 'hmac' || a === 'hmac-sha256') credMode = 'hmac';
    else if (a === 'paper' || a === 'none') credMode = 'paper';
    else throw new Error(`Invalid --auth "${flags.auth}". Choose hmac, ed25519, or paper.`);
  } else if (flags['api-key'] !== undefined) {
    credMode = flags['key-path'] ? 'ed25519' : 'hmac';
  } else if (!isInteractive()) {
    credMode = hadKey ? (existingAuth.includes('ed25519') ? 'ed25519' : 'hmac') : 'paper';
  } else {
    credMode = await select(
      'Binance API credentials (you can leave empty and configure later in .env):',
      [
        { value: 'paper', label: 'Paper Sandbox only (no API keys needed now)' },
        { value: 'hmac', label: 'HMAC-SHA256 API Key & Secret' },
        { value: 'ed25519', label: 'Ed25519 API Key & PKCS#8 PEM file' },
      ],
      hadKey ? (existingAuth.includes('ed25519') ? 'ed25519' : 'hmac') : 'paper'
    );
  }

  let authMethod = 'hmac-sha256';
  let apiKey = existingEnv.BINANCE_API_KEY ?? '';
  let apiSecret = existingEnv.BINANCE_API_SECRET ?? '';
  let ed25519KeyPath = existingEnv.BINANCE_PRIVATE_KEY_PATH ?? '';

  if (credMode === 'paper') {
    apiKey = '';
    apiSecret = '';
    ed25519KeyPath = '';
  } else if (credMode === 'hmac') {
    authMethod = 'hmac-sha256';
    ed25519KeyPath = '';
    apiKey = flags['api-key'] !== undefined
      ? String(flags['api-key'])
      : (isInteractive() ? (await secret('Binance API Key', hadKey)) || apiKey : apiKey);
    apiSecret = flags['api-secret'] !== undefined
      ? String(flags['api-secret'])
      : (isInteractive() ? (await secret('Binance API Secret', hadSecret)) || apiSecret : apiSecret);
  } else if (credMode === 'ed25519') {
    authMethod = 'ed25519';
    apiSecret = '';
    apiKey = flags['api-key'] !== undefined
      ? String(flags['api-key'])
      : (isInteractive() ? (await secret('Binance API Key', hadKey)) || apiKey : apiKey);
    ed25519KeyPath = flags['key-path'] !== undefined
      ? String(flags['key-path'])
      : (isInteractive()
          ? await input('Path to Ed25519 PKCS#8 PEM private key', ed25519KeyPath || (hadKeyPath ? existingEnv.BINANCE_PRIVATE_KEY_PATH : ''))
          : ed25519KeyPath);
  }

  // Host & ports
  let host = flags.lan ? '0.0.0.0' : flags.host ? String(flags.host) : null;
  if (!host) {
    const defaultHost = existingEnv.HOST === '0.0.0.0' || state.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    host = isInteractive()
      ? await select(
          'Network bind address:',
          [
            { value: '127.0.0.1', label: '127.0.0.1 — This computer only (Recommended)' },
            { value: '0.0.0.0', label: '0.0.0.0 — Allow LAN / remote browser access' },
          ],
          defaultHost
        )
      : defaultHost;
  }

  const webRunning = Boolean(runningPid('web'));
  const botRunning = Boolean(runningPid('bot'));
  const defaultWebPort = Number(flags['web-port'] || existingEnv.PORT || state.webPort || 3000) || 3000;
  const webPort = flags['web-port'] !== undefined
    ? validatePortNumber(flags['web-port'])
    : needWeb
      ? await resolvePortChoice('Web Command Center', defaultWebPort, host, [], webRunning)
      : defaultWebPort;

  const existingBotPort = botPortFromToml(existingToml, state.botPort || 8080);
  const defaultBotPort = Number(flags['bot-port'] || existingBotPort || 8080) || 8080;
  const botPort = flags['bot-port'] !== undefined
    ? validatePortNumber(flags['bot-port'], needWeb ? [webPort] : [])
    : needRust
      ? await resolvePortChoice('Rust Bot API', defaultBotPort, host, needWeb ? [webPort] : [], botRunning)
      : defaultBotPort;

  // Build steps
  if (flags.build !== false) {
    if (needWeb) {
      info('Installing Node.js dependencies...');
      const hasLock = fs.existsSync(path.join(REPO_DIR, 'package-lock.json'));
      const installArgs = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
      const npmRes = runStreaming(npmCommand(), installArgs);
      if (!npmRes.ok) throw new Error('npm dependency installation failed.');

      info('Building WebApp production bundle (vite build)...');
      const buildRes = runStreaming(npmCommand(), ['run', 'build']);
      if (!buildRes.ok) throw new Error('WebApp production build failed.');
      ok('WebApp built at dist/index.html');
    }

    if (needRust) {
      info('Compiling Rust trading engine in release mode (cargo build --release --bin bot-desktop)...');
      if (botRunning) {
        info('Stopping running bot daemon before rebuilding binary...');
        await stopComponent('bot');
      }
      const cargoRes = runStreaming('cargo', ['build', '--release', '--bin', 'bot-desktop'], { cwd: PATHS.rustDir });
      if (!cargoRes.ok) throw new Error('Cargo release build failed.');
      ok(`Rust binary built at ${path.relative(REPO_DIR, PATHS.botBinary)}`);
    }
  } else {
    warn('Skipping build steps (--no-build).');
  }

  // Render .env (backing up any existing one)
  if (!fs.existsSync(PATHS.envExample)) {
    throw new Error(`Missing template file: ${PATHS.envExample}`);
  }
  if (fs.existsSync(PATHS.env)) {
    fs.copyFileSync(PATHS.env, PATHS.envBackup);
    chmodOwnerOnly(PATHS.envBackup);
    ok(`Backed up existing .env -> ${path.relative(REPO_DIR, PATHS.envBackup)}`);
  }
  const envTemplate = fs.readFileSync(PATHS.envExample, 'utf8');
  const nextEnvContent = renderEnv(envTemplate, {
    PORT: String(webPort),
    HOST: host,
    BINANCE_ENVIRONMENT: environment === 'production' ? 'Production' : 'Testnet',
    BINANCE_VENUE: venue === 'futures' ? 'Futures' : 'Spot',
    BINANCE_AUTH_METHOD: authMethod === 'ed25519' ? 'Ed25519' : 'HMAC-SHA256',
    BINANCE_API_KEY: apiKey,
    BINANCE_API_SECRET: apiSecret,
    BINANCE_PRIVATE_KEY_PATH: ed25519KeyPath,
    ...(existingEnv.APEXRUST_PROXY_TOKEN ? { APEXRUST_PROXY_TOKEN: existingEnv.APEXRUST_PROXY_TOKEN } : {}),
  });
  fs.writeFileSync(PATHS.env, nextEnvContent, 'utf8');
  chmodOwnerOnly(PATHS.env);
  ok(`Wrote ${path.relative(REPO_DIR, PATHS.env)} (safe permissions)`);

  // Render bot.toml (backing up any existing one; paper_trading = true, armed_for_live_orders = false)
  if (fs.existsSync(PATHS.botExample)) {
    if (fs.existsSync(PATHS.botToml)) {
      fs.copyFileSync(PATHS.botToml, PATHS.botTomlBackup);
      chmodOwnerOnly(PATHS.botTomlBackup);
      ok(`Backed up existing bot.toml -> ${path.relative(REPO_DIR, PATHS.botTomlBackup)}`);
    }
    const botTemplate = fs.readFileSync(PATHS.botExample, 'utf8');
    const nextToml = renderBotToml(botTemplate, {
      environment,
      venue,
      leverage,
      marginType,
      authMethod,
      ed25519KeyPath,
      botHost: host,
      botPort,
      webPort,
    });
    fs.writeFileSync(PATHS.botToml, nextToml, 'utf8');
    chmodOwnerOnly(PATHS.botToml);
    ok(`Wrote ${path.relative(REPO_DIR, PATHS.botToml)} (paper_trading = true, armed_for_live_orders = false)`);
  }

  writeState({
    components,
    webPort,
    botPort,
    host,
    environment,
    venue,
    installedAt: new Date().toISOString(),
  });

  // Optional auto-start OS service
  let installSvc = parseBooleanFlag(flags.service, undefined);
  if (installSvc === undefined && isInteractive()) {
    installSvc = await confirm('Register background auto-start service at login/boot?', false);
  }
  let startedByService = false;
  if (installSvc) {
    await cmdServiceInstall(components === 'both' ? 'both' : components, flags);
    startedByService = true;
  }

  // Optional immediate start when not already started as OS service
  if (!startedByService && flags.start !== false) {
    const startNow = flags.start === true || (!isInteractive() ? true : await confirm('Start ApexRust now?', true));
    if (startNow) {
      await cmdStart(components, { ...flags, forceRestart: true });
    }
  }

  console.log(`\n${C.bold}${C.green}Setup complete!${C.reset}`);
  const cliHint = IS_WIN ? 'apexrust.cmd' : './apexrust';
  if (needWeb) {
    const urlHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`  Web UI:     http://${urlHost}:${webPort}`);
  }
  if (needRust) {
    const urlHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`  Rust API:   http://${urlHost}:${botPort}/api/health`);
  }
  console.log(`  Useful commands: ${cliHint} status | logs -f | doctor | stop | uninstall\n`);
}

// ---------------------------------------------------------------------------
// run (internal supervisor used by detached starter and OS service managers)
// ---------------------------------------------------------------------------
function loadDotEnvInto(targetEnv) {
  for (const [k, v] of Object.entries(readCurrentEnv())) {
    if (targetEnv[k] === undefined || targetEnv[k] === '') {
      targetEnv[k] = v;
    }
  }
}

async function cmdRun(component, flags) {
  if (!COMPONENTS.includes(component)) {
    throw new Error(`Usage: apexrust run <web|bot>`);
  }
  augmentPath();
  ensureRuntimeDirs();

  const childEnv = { ...process.env };
  loadDotEnvInto(childEnv);

  let cmd;
  let args;
  if (component === 'web') {
    if (!fs.existsSync(PATHS.tsxCli)) {
      throw new Error(`Missing ${PATHS.tsxCli}. Run \`npm install\` or \`./apexrust setup\` first.`);
    }
    childEnv.NODE_ENV = childEnv.NODE_ENV || 'production';
    cmd = process.execPath;
    args = [PATHS.tsxCli, PATHS.serverEntry];
  } else {
    if (!fs.existsSync(PATHS.botBinary)) {
      throw new Error(`Missing Rust binary at ${PATHS.botBinary}. Run \`./apexrust setup\` first.`);
    }
    if (!fs.existsSync(PATHS.botToml)) {
      throw new Error(`Missing ${PATHS.botToml}. Run \`./apexrust setup\` first.`);
    }
    cmd = PATHS.botBinary;
    args = ['--config', PATHS.botToml];
  }

  let logFd = null;
  let stdio = 'inherit';
  if (flags.log) {
    const resolvedLog = path.resolve(String(flags.log));
    fs.mkdirSync(path.dirname(resolvedLog), { recursive: true });
    logFd = fs.openSync(resolvedLog, 'a');
    stdio = ['ignore', logFd, logFd];
  }

  writePid(component, process.pid);

  await new Promise((resolve) => {
    let intentionalStop = false;
    const child = spawn(cmd, args, {
      cwd: REPO_DIR,
      env: childEnv,
      stdio,
      windowsHide: true,
    });

    const forwardStop = (signal) => {
      if (intentionalStop) return;
      intentionalStop = true;
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 10000).unref();
    };

    process.on('SIGTERM', () => forwardStop('SIGTERM'));
    process.on('SIGINT', () => forwardStop('SIGINT'));
    if (!IS_WIN) process.on('SIGHUP', () => forwardStop('SIGTERM'));

    child.on('error', (err) => {
      console.error(`[${component}] Failed to spawn process: ${err.message}`);
      removePid(component, process.pid);
      if (logFd !== null) fs.closeSync(logFd);
      process.exitCode = 1;
      resolve();
    });

    child.on('exit', (code, signal) => {
      removePid(component, process.pid);
      if (logFd !== null) fs.closeSync(logFd);
      if (intentionalStop) {
        process.exitCode = 0;
      } else if (typeof code === 'number') {
        process.exitCode = code;
      } else {
        console.error(`[${component}] Exited on signal ${signal}`);
        process.exitCode = 1;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// start / stop / restart
// ---------------------------------------------------------------------------
async function startComponent(component, forceRestart = false) {
  const existing = runningPid(component);
  if (existing) {
    if (forceRestart) {
      await stopComponent(component);
    } else {
      ok(`${component} is already running (pid ${existing}).`);
      return;
    }
  }

  const { webPort, botPort } = resolvePorts();
  const port = component === 'web' ? webPort : botPort;

  if (component === 'web') {
    if (!fs.existsSync(PATHS.tsxCli)) {
      throw new Error(`Web dependencies missing (${PATHS.tsxCli}). Run setup first.`);
    }
    if (!fs.existsSync(PATHS.distIndex)) {
      warn('dist/index.html not found — run `npm run build` for production UI assets.');
    }
  } else {
    if (!fs.existsSync(PATHS.botBinary)) {
      throw new Error(`Rust binary not found (${PATHS.botBinary}). Run setup first.`);
    }
    if (!fs.existsSync(PATHS.botToml)) {
      throw new Error(`Missing ${PATHS.botToml}. Run setup first.`);
    }
  }

  if (!(await isPortFree(port, '127.0.0.1'))) {
    throw new Error(`Port ${port} for ${component} is already in use by another process.`);
  }

  info(`Starting ${component}...`);
  const pid = startDetached(component, process.env);
  writePid(component, pid);

  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const health = await waitForHealth(healthUrl, 45000, () => isAlive(pid));
  if (!health.ok) {
    const tail = tailFile(logFile(component), 25);
    await killTree(pid, 3000);
    removePid(component, pid);
    throw new Error(
      `${component} failed health check at ${healthUrl} (${health.error ?? `HTTP ${health.status}`}).\n` +
        (tail ? `Recent log output:\n${tail}` : `See ${logFile(component)}`)
    );
  }
  ok(`${component} started (pid ${pid}) -> ${healthUrl}`);
}

async function stopComponent(component) {
  const pid = runningPid(component);
  if (!pid) {
    removePid(component);
    info(`${component} is not running.`);
    return false;
  }
  info(`Stopping ${component} (pid ${pid})...`);
  const stopped = await killTree(pid, 15000);
  removePid(component);
  if (stopped) {
    ok(`${component} stopped.`);
  } else {
    warn(`${component} (pid ${pid}) may still be exiting.`);
  }
  return true;
}

async function cmdStart(target, flags = {}) {
  augmentPath();
  for (const c of resolveTargetComponents(target)) {
    await startComponent(c, Boolean(flags.forceRestart));
  }
}

async function cmdStop(target) {
  for (const c of resolveTargetComponents(target)) {
    await stopComponent(c);
  }
}

async function cmdRestart(target) {
  const list = resolveTargetComponents(target);
  for (const c of list) await stopComponent(c);
  for (const c of list) await startComponent(c);
}

// ---------------------------------------------------------------------------
// status & logs
// ---------------------------------------------------------------------------
function systemdUserSupported() {
  return IS_LINUX && runCapture('systemctl', ['--user', 'show-environment']).ok;
}

function getServiceStatus(component) {
  if (IS_LINUX) {
    const unit = systemdUnitName(component);
    if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', unit))) {
      const enabled = runCapture('systemctl', ['--user', 'is-enabled', unit]);
      const active = runCapture('systemctl', ['--user', 'is-active', unit]);
      return `systemd --user (${enabled.stdout || 'installed'}, ${active.stdout || 'unknown'})`;
    }
    if (fs.existsSync(path.join('/etc/systemd/system', unit))) {
      const enabled = runCapture('systemctl', ['is-enabled', unit]);
      const active = runCapture('systemctl', ['is-active', unit]);
      return `systemd system (${enabled.stdout || 'installed'}, ${active.stdout || 'unknown'})`;
    }
    return 'not installed';
  }
  if (IS_MAC) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(component)}.plist`);
    if (!fs.existsSync(plist)) return 'not installed';
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    const loaded = runCapture('launchctl', ['print', `gui/${uid}/${launchdLabel(component)}`]).ok;
    return loaded ? 'launchd (loaded)' : 'launchd (plist present, not loaded)';
  }
  if (IS_WIN) {
    const query = runCapture('schtasks', ['/Query', '/TN', windowsTaskName(component)]);
    return query.ok ? `Scheduled Task (${windowsTaskName(component)})` : 'not installed';
  }
  return 'unsupported';
}

async function cmdStatus() {
  const { webPort, botPort, host } = resolvePorts();
  const tomlText = readCurrentTomlText();
  const envName = tomlText ? readTomlValue(tomlText, 'exchange', 'environment') : undefined;
  const venue = tomlText ? readTomlValue(tomlText, 'exchange', 'venue') : undefined;
  const paper = tomlText ? readTomlValue(tomlText, 'exchange', 'paper_trading') : undefined;
  const armed = tomlText ? readTomlValue(tomlText, 'exchange.credentials', 'armed_for_live_orders') : undefined;

  console.log(`${C.bold}ApexRust Status${C.reset}`);
  if (tomlText) {
    console.log(`  Profile: ${envName ?? 'unknown'} / ${venue ?? 'unknown'} | paper_trading=${paper} | armed_for_live_orders=${armed}`);
  } else {
    console.log('  Profile: bot.toml not yet created (run setup if using Rust daemon)');
  }
  console.log('');

  for (const c of COMPONENTS) {
    const port = c === 'web' ? webPort : botPort;
    const pid = runningPid(c);
    const health = await fetchHealth(`http://127.0.0.1:${port}/api/health`, 1500);
    const stateLabel = health.ok
      ? `${C.green}HEALTHY${C.reset}`
      : pid
        ? `${C.yellow}STARTING/UNHEALTHY${C.reset}`
        : `${C.dim}STOPPED${C.reset}`;
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`  [${c}] ${stateLabel} | pid: ${pid ?? '-'} | url: ${url} | service: ${getServiceStatus(c)}`);
  }
  console.log('');
}

function cmdLogs(target, flags) {
  const list = resolveTargetComponents(target);
  const rawLines = flags.lines !== undefined ? Number(flags.lines) : 80;
  const lines = Number.isInteger(rawLines) && rawLines >= 0 ? rawLines : 80;
  for (const c of list) {
    const file = logFile(c);
    console.log(`${C.bold}=== ${c} (${path.relative(REPO_DIR, file)}) ===${C.reset}`);
    if (!fs.existsSync(file)) {
      console.log('(no log file yet)\n');
      continue;
    }
    const content = tailFile(file, lines);
    console.log(content || '(empty)');
    console.log('');
  }
  if (flags.follow) {
    const files = list.map((c) => ({ component: c, file: logFile(c) }));
    info(`Following logs (${list.join(', ')})... Press Ctrl+C to exit.`);
    followFiles(files);
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor() {
  printBanner();
  augmentPath();
  const state = readState();
  const needRust = state.components !== 'web';
  const needWeb = state.components !== 'bot';
  let issues = 0;

  info('Toolchain & Build Checks');
  for (const item of checkPrerequisites({ needRust: true })) {
    if (item.ok) {
      ok(`${item.name}: ${item.detail}`);
    } else if (!needRust && (item.id === 'rust' || item.id === 'buildtools')) {
      warn(`${item.name}: ${item.detail} (optional because components=${state.components})`);
    } else {
      issues += 1;
      fail(`${item.name}: ${item.detail} -> ${item.fix}`);
    }
  }

  console.log('');
  info('Configuration & Build Artifacts');
  if (fs.existsSync(PATHS.env)) {
    let permNote = '';
    if (!IS_WIN) {
      const mode = fs.statSync(PATHS.env).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        warn(`.env permissions are ${mode.toString(8)}; recommended 600 (chmod 600 .env)`);
      } else {
        permNote = ' (mode 600)';
      }
    }
    ok(`.env present${permNote}`);
  } else {
    issues += 1;
    fail(`.env missing (run ./apexrust setup)`);
  }

  if (fs.existsSync(PATHS.botToml)) {
    const toml = readCurrentTomlText();
    const paper = readTomlValue(toml, 'exchange', 'paper_trading');
    const armed = readTomlValue(toml, 'exchange.credentials', 'armed_for_live_orders');
    ok(`rust-bot/config/bot.toml present (paper_trading=${paper}, armed_for_live_orders=${armed})`);
  } else if (needRust) {
    issues += 1;
    fail('rust-bot/config/bot.toml missing (run ./apexrust setup)');
  } else {
    info('rust-bot/config/bot.toml not present (web-only setup)');
  }

  if (fs.existsSync(PATHS.tsxCli) && fs.existsSync(PATHS.distIndex)) {
    ok('WebApp built (node_modules + dist/index.html)');
  } else if (needWeb) {
    issues += 1;
    fail('WebApp build incomplete (run npm install && npm run build)');
  } else {
    info('WebApp bundle not built (bot-only setup)');
  }

  if (fs.existsSync(PATHS.botBinary)) {
    ok(`Rust release binary built (${path.relative(REPO_DIR, PATHS.botBinary)})`);
  } else if (needRust) {
    issues += 1;
    fail(`Rust binary missing (${path.relative(REPO_DIR, PATHS.botBinary)})`);
  }

  console.log('');
  info('Ports, Runtime & Services');
  const { webPort, botPort } = resolvePorts();
  for (const [c, port] of [['web', webPort], ['bot', botPort]]) {
    const pid = runningPid(c);
    const health = await fetchHealth(`http://127.0.0.1:${port}/api/health`, 1500);
    const free = await isPortFree(port, '127.0.0.1');
    if (health.ok) {
      ok(`${c} responding on 127.0.0.1:${port} (pid ${pid ?? 'external'})`);
    } else if (!free) {
      warn(`Port ${port} (${c}) is occupied by a process not answering /api/health`);
    } else {
      info(`${c} stopped (port ${port} is free)`);
    }
    info(`${c} service: ${getServiceStatus(c)}`);
  }

  if (IS_LINUX && systemdUserSupported()) {
    const user = os.userInfo().username;
    const linger = runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
    if (linger.ok) {
      info(`Linux systemd --user linger (${user}): ${linger.stdout || 'no'}`);
    }
  }

  console.log('');
  if (issues > 0) {
    throw new Error(`Doctor found ${issues} blocking issue(s).`);
  }
  ok('Doctor passed with no blocking issues.');
}

// ---------------------------------------------------------------------------
// service install / uninstall
// ---------------------------------------------------------------------------
async function installLinuxSystemd(components, flags) {
  const pathEnv = process.env.PATH;
  const user = os.userInfo().username;
  if (flags.system) {
    ensureRuntimeDirs();
    for (const c of components) {
      const unit = systemdUnitName(c);
      const dest = `/etc/systemd/system/${unit}`;
      const content = renderSystemdUnit({
        component: c,
        repoDir: REPO_DIR,
        nodePath: process.execPath,
        system: true,
        user,
        pathEnv,
      });
      const tmpUnit = path.join(PATHS.runDir, unit);
      fs.writeFileSync(tmpUnit, content, { mode: 0o600 });
      try {
        await confirmSudoAndRun(['install', '-m', '0644', tmpUnit, dest]);
        ok(`Wrote ${dest}`);
      } finally {
        try { fs.unlinkSync(tmpUnit); } catch { /* ignore */ }
      }
    }
    await confirmSudoAndRun(['systemctl', 'daemon-reload']);
    await confirmSudoAndRun(['systemctl', 'enable', '--now', ...components.map(systemdUnitName)]);
    ok(`Enabled and started system service(s): ${components.map(systemdUnitName).join(', ')}`);
    return;
  }

  if (!systemdUserSupported()) {
    throw new Error('systemd --user session bus is unavailable here. Use `--system` for a system-wide unit or manage processes with `./apexrust start`.');
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  for (const c of components) {
    const unit = systemdUnitName(c);
    const dest = path.join(unitDir, unit);
    fs.writeFileSync(
      dest,
      renderSystemdUnit({
        component: c,
        repoDir: REPO_DIR,
        nodePath: process.execPath,
        system: false,
        pathEnv,
      }),
      'utf8'
    );
    ok(`Wrote ${dest}`);
  }
  const reload = runStreaming('systemctl', ['--user', 'daemon-reload']);
  if (!reload.ok) throw new Error('systemctl --user daemon-reload failed.');
  const enable = runStreaming('systemctl', ['--user', 'enable', '--now', ...components.map(systemdUnitName)]);
  if (!enable.ok) throw new Error('systemctl --user enable --now failed.');
  ok(`Enabled and started systemd user service(s): ${components.map(systemdUnitName).join(', ')}`);

  // Optional loginctl enable-linger
  const lingerRes = runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
  const alreadyLinger = lingerRes.ok && lingerRes.stdout === 'yes';
  if (!alreadyLinger) {
    let wantLinger = parseBooleanFlag(flags.linger, undefined);
    if (wantLinger === undefined && isInteractive()) {
      wantLinger = await confirm(
        `Enable user linger (loginctl enable-linger ${user}) so services survive SSH logout?`,
        false
      );
    }
    if (wantLinger) {
      const direct = runCapture('loginctl', ['enable-linger', user]);
      if (direct.ok) {
        ok(`Enabled linger for ${user}.`);
      } else {
        await confirmSudoAndRun(['loginctl', 'enable-linger', user]);
        ok(`Enabled linger for ${user} via sudo.`);
      }
    }
  }
}

async function uninstallLinuxSystemd(components) {
  const userDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  for (const c of components) {
    const unit = systemdUnitName(c);
    const userPath = path.join(userDir, unit);
    if (fs.existsSync(userPath)) {
      runCapture('systemctl', ['--user', 'disable', '--now', unit]);
      fs.unlinkSync(userPath);
      ok(`Removed ${userPath}`);
    }
    const sysPath = path.join('/etc/systemd/system', unit);
    if (fs.existsSync(sysPath)) {
      await confirmSudoAndRun(['systemctl', 'disable', '--now', unit]);
      await confirmSudoAndRun(['rm', '-f', sysPath]);
      await confirmSudoAndRun(['systemctl', 'daemon-reload']);
      ok(`Removed ${sysPath}`);
    }
  }
  if (systemdUserSupported()) runCapture('systemctl', ['--user', 'daemon-reload']);
}

function installMacLaunchd(components) {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  ensureRuntimeDirs();
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  for (const c of components) {
    const label = launchdLabel(c);
    const plist = path.join(dir, `${label}.plist`);
    fs.writeFileSync(
      plist,
      renderLaunchdPlist({
        component: c,
        repoDir: REPO_DIR,
        nodePath: process.execPath,
        logPath: logFile(c),
        pathEnv: process.env.PATH,
      }),
      'utf8'
    );
    runCapture('launchctl', ['bootout', `gui/${uid}`, plist]);
    const res = runStreaming('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (!res.ok) throw new Error(`launchctl bootstrap failed for ${plist}`);
    ok(`Installed and started LaunchAgent ${label}`);
  }
}

function uninstallMacLaunchd(components) {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  for (const c of components) {
    const plist = path.join(dir, `${launchdLabel(c)}.plist`);
    if (fs.existsSync(plist)) {
      runCapture('launchctl', ['bootout', `gui/${uid}`, plist]);
      fs.unlinkSync(plist);
      ok(`Removed ${plist}`);
    }
  }
}

function installWindowsTasks(components) {
  ensureRuntimeDirs();
  for (const c of components) {
    const ps1 = renderWindowsTaskScript({
      component: c,
      repoDir: REPO_DIR,
      nodePath: process.execPath,
      logPath: logFile(c),
    });
    const tmpFile = path.join(PATHS.runDir, `register-${c}.ps1`);
    fs.writeFileSync(tmpFile, ps1, 'utf8');
    try {
      const reg = runStreaming('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
      if (!reg.ok) throw new Error(`Failed to register Windows Scheduled Task ${windowsTaskName(c)}`);
      const runRes = runCapture('schtasks', ['/Run', '/TN', windowsTaskName(c)]);
      if (!runRes.ok) {
        warn(`Scheduled Task ${windowsTaskName(c)} registered, but failed immediate start: ${runRes.stderr || 'unknown error'}`);
      }
      ok(`Registered Windows Scheduled Task ${windowsTaskName(c)}`);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  }
}

function uninstallWindowsTasks(components) {
  for (const c of components) {
    const name = windowsTaskName(c);
    const exists = runCapture('schtasks', ['/Query', '/TN', name]);
    if (exists.ok) {
      runCapture('schtasks', ['/End', '/TN', name]);
      runCapture('schtasks', ['/Delete', '/TN', name, '/F']);
      ok(`Removed Scheduled Task ${name}`);
    }
  }
}

async function cmdServiceInstall(target, flags) {
  const components = resolveTargetComponents(target);
  // Stop manual detached PIDs before handing over to OS service manager
  for (const c of components) {
    if (runningPid(c)) await stopComponent(c);
  }
  if (IS_LINUX) {
    await installLinuxSystemd(components, flags);
  } else if (IS_MAC) {
    installMacLaunchd(components);
  } else if (IS_WIN) {
    installWindowsTasks(components);
  } else {
    throw new Error(`OS auto-start services are not supported on ${process.platform}.`);
  }

  const { webPort, botPort } = resolvePorts();
  for (const c of components) {
    const port = c === 'web' ? webPort : botPort;
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    info(`Waiting for ${c} service health at ${healthUrl}...`);
    const health = await waitForHealth(healthUrl, 45000);
    if (!health.ok) {
      throw new Error(`${c} service did not respond at ${healthUrl} (${health.error ?? `HTTP ${health.status}`}). Check OS service logs.`);
    }
    ok(`${c} service is healthy (${healthUrl})`);
  }
}

async function cmdServiceUninstall(target) {
  const components = resolveTargetComponents(target ?? 'both');
  if (IS_LINUX) return uninstallLinuxSystemd(components);
  if (IS_MAC) return uninstallMacLaunchd(components);
  if (IS_WIN) return uninstallWindowsTasks(components);
  throw new Error(`OS auto-start services are not supported on ${process.platform}.`);
}

async function cmdService(args, flags) {
  const action = args[0];
  const target = args[1];
  if (action === 'install') return cmdServiceInstall(target, flags);
  if (action === 'uninstall' || action === 'remove') return cmdServiceUninstall(target);
  throw new Error('Usage: ./apexrust service <install|uninstall> [web|bot|both] [--system] [--linger]');
}

// ---------------------------------------------------------------------------
// update & uninstall
// ---------------------------------------------------------------------------
async function cmdUpdate(flags) {
  printBanner();
  augmentPath();

  const components = resolveTargetComponents(flags.components);
  const needWeb = components.includes('web');
  const needRust = components.includes('bot');
  const wasRunning = components.filter((c) => Boolean(runningPid(c)));

  if (wasRunning.length > 0) {
    info(`Stopping running component(s) before update: ${wasRunning.join(', ')}`);
    for (const c of wasRunning) await stopComponent(c);
  }

  info('Pulling latest commits (git pull --ff-only)...');
  const pull = runStreaming('git', ['pull', '--ff-only']);
  if (!pull.ok) throw new Error('git pull --ff-only failed. Resolve local changes first.');

  if (needWeb) {
    info('Updating Node.js dependencies & rebuilding WebApp...');
    const hasLock = fs.existsSync(path.join(REPO_DIR, 'package-lock.json'));
    const npmRes = runStreaming(npmCommand(), [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund']);
    if (!npmRes.ok) throw new Error('npm install failed.');

    const buildRes = runStreaming(npmCommand(), ['run', 'build']);
    if (!buildRes.ok) throw new Error('WebApp build failed.');
  }

  if (needRust) {
    info('Rebuilding Rust release binary...');
    const cargoRes = runStreaming('cargo', ['build', '--release', '--bin', 'bot-desktop'], { cwd: PATHS.rustDir });
    if (!cargoRes.ok) throw new Error('Cargo build failed.');
  }

  if (wasRunning.length > 0 && flags.restart !== false) {
    for (const c of wasRunning) await startComponent(c);
  }
  ok('Update complete.');
}

async function cmdUninstall(flags) {
  printBanner();
  for (const c of COMPONENTS) await stopComponent(c);
  try {
    await cmdServiceUninstall('both');
  } catch (err) {
    warn(`Service cleanup incomplete: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (fs.existsSync(PATHS.stateDir)) {
    fs.rmSync(PATHS.stateDir, { recursive: true, force: true });
    ok('Removed .apexrust/ runtime state, PIDs, and logs.');
  }

  let purge = Boolean(flags.purge);
  if (!purge && isInteractive()) {
    purge = await confirm('Also delete local configs (.env, bot.toml) and build caches (dist, node_modules, rust-bot/target)?', false);
  }

  if (purge) {
    const targets = [
      PATHS.env,
      PATHS.envBackup,
      PATHS.botToml,
      PATHS.botTomlBackup,
      path.join(REPO_DIR, '.apexrust-order-logs.json'),
      path.join(REPO_DIR, 'dist'),
      path.join(REPO_DIR, 'node_modules'),
      path.join(PATHS.rustDir, 'target'),
    ];
    for (const t of targets) {
      if (fs.existsSync(t)) {
        fs.rmSync(t, { recursive: true, force: true });
        ok(`Removed ${path.relative(REPO_DIR, t)}`);
      }
    }
    ok('Full purge complete. Only git-tracked repository files remain.');
  } else {
    info('Preserved .env and rust-bot/config/bot.toml (pass --purge to remove everything).');
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function main() {
  const { command, positionals, flags } = parseCliArgs(process.argv.slice(2));
  if (flags.yes || flags['non-interactive']) {
    setNonInteractive(true);
  }
  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'setup':
      await cmdSetup(flags);
      break;
    case 'run':
      await cmdRun(positionals[0], flags);
      break;
    case 'start':
      await cmdStart(positionals[0], flags);
      break;
    case 'stop':
      await cmdStop(positionals[0]);
      break;
    case 'restart':
      await cmdRestart(positionals[0]);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      cmdLogs(positionals[0], flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'update':
      await cmdUpdate(flags);
      break;
    case 'service':
      await cmdService(positionals, flags);
      break;
    case 'uninstall':
      await cmdUninstall(flags);
      break;
    default:
      fail(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closePrompts();
}
