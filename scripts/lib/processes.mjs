// Background process control: PID files, detached launch, health polling, cross-platform kill.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { IS_WIN, PATHS, logFile, pidFile } from './paths.mjs';

export function ensureRuntimeDirs() {
  fs.mkdirSync(PATHS.runDir, { recursive: true });
  fs.mkdirSync(PATHS.logDir, { recursive: true });
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readPid(component) {
  try {
    const pid = Number(fs.readFileSync(pidFile(component), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(component, pid) {
  ensureRuntimeDirs();
  fs.writeFileSync(pidFile(component), `${pid}\n`);
}

export function removePid(component, expectedPid) {
  try {
    if (expectedPid !== undefined && readPid(component) !== expectedPid) return;
    fs.unlinkSync(pidFile(component));
  } catch {
    // already removed
  }
}

export function runningPid(component) {
  const pid = readPid(component);
  if (pid && isAlive(pid)) return pid;
  if (pid) removePid(component);
  return null;
}

export function formatHostPort(host, port) {
  const clean = String(host || '127.0.0.1').trim().replace(/^\[|\]$/g, '') || '127.0.0.1';
  return clean.includes(':') ? `[${clean}]:${port}` : `${clean}:${port}`;
}

function parseBindHostFlag(raw) {
  const clean = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!clean) {
    throw new Error('Invalid --host: value cannot be empty.');
  }
  if (clean.includes('://') || /\s/.test(clean) || clean.includes('/')) {
    throw new Error(
      `Invalid --host "${raw}": expected an IP address or hostname (e.g. 0.0.0.0, 127.0.0.1, or 100.96.1.10).`
    );
  }
  const colons = (clean.match(/:/g) || []).length;
  if (colons === 1) {
    throw new Error(`Invalid --host "${raw}": pass the port separately via --web-port or --bot-port.`);
  }
  return clean;
}

function validatePortFlag(raw, name) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid --${name} "${raw}": must be an integer between 1 and 65535.`);
  }
  return n;
}

/**
 * Resolves per-component bind host, port, and child env overrides for `start` / `restart`.
 * Note: `--host` / `--lan` binds the public-facing `web` proxy when starting `both` (keeping
 * `bot-web` on 127.0.0.1 behind the gateway), and binds `bot` only when `target === 'bot'`.
 */
export function resolveComponentLaunchConfig({
  component,
  target,
  flags = {},
  basePorts,
}) {
  if (flags.host === true) {
    throw new Error('Missing value for --host');
  }
  if (flags.token === true) {
    throw new Error('Missing value for --token');
  }
  const hostFlag = flags.lan
    ? '0.0.0.0'
    : flags.host !== undefined
      ? parseBindHostFlag(flags.host)
      : null;
  const hasWebPortFlag = flags['web-port'] !== undefined;
  const hasBotPortFlag = flags['bot-port'] !== undefined;
  const webPort = hasWebPortFlag ? validatePortFlag(flags['web-port'], 'web-port') : basePorts.webPort;
  const botPort = hasBotPortFlag ? validatePortFlag(flags['bot-port'], 'bot-port') : basePorts.botPort;
  const tokenFlag = flags.token !== undefined ? String(flags.token).trim() : null;

  if (component === 'web') {
    const bindHost = hostFlag ?? basePorts.host;
    const envOverrides = {};
    if (hostFlag !== null) envOverrides.HOST = bindHost;
    if (hasWebPortFlag) envOverrides.PORT = String(webPort);
    if (tokenFlag !== null) envOverrides.APEXRUST_PROXY_TOKEN = tokenFlag;
    if (hasBotPortFlag) {
      const upstreamHost =
        !basePorts.botHost || basePorts.botHost === '0.0.0.0' || basePorts.botHost === '::'
          ? '127.0.0.1'
          : basePorts.botHost;
      envOverrides.APEXRUST_ENGINE_URL = `http://${formatHostPort(upstreamHost, botPort)}`;
    }
    return {
      component: 'web',
      bindHost,
      port: webPort,
      envOverrides,
      shouldRestart: Boolean(
        flags.forceRestart ||
          hostFlag !== null ||
          hasWebPortFlag ||
          hasBotPortFlag ||
          tokenFlag !== null
      ),
    };
  }

  const appliesHostToBot = target === 'bot' && hostFlag !== null;
  const bindHost = appliesHostToBot ? hostFlag : basePorts.botHost;
  const envOverrides = {};
  if (appliesHostToBot || hasBotPortFlag) {
    envOverrides.BOT_WEB_BIND = formatHostPort(bindHost, botPort);
  }
  if (tokenFlag !== null) {
    envOverrides.APEXRUST_WEB_TOKEN = tokenFlag;
  }
  return {
    component: 'bot',
    bindHost,
    port: botPort,
    envOverrides,
    shouldRestart: Boolean(
      flags.forceRestart ||
        appliesHostToBot ||
        hasBotPortFlag ||
        (target === 'bot' && tokenFlag !== null)
    ),
  };
}

/** Launch `node scripts/apexrust.mjs run <component>` detached, logging to .apexrust/logs. */
export function startDetached(component, env = process.env) {
  ensureRuntimeDirs();
  const fd = fs.openSync(logFile(component), 'a');
  const child = spawn(process.execPath, [PATHS.cli, 'run', component], {
    cwd: PATHS.stateDir.replace(/[\\/]\.apexrust$/, ''),
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Gracefully stop a process tree; escalates to a forced kill after `timeoutMs`. */
export async function killTree(pid, timeoutMs = 15000) {
  if (!isAlive(pid)) return true;
  if (IS_WIN) {
    // Console/hidden Node & Rust child processes ignore WM_CLOSE; terminate tree directly with /T /F
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    await sleep(300);
    return !isAlive(pid);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let groupAlive = isAlive(pid);
    if (!groupAlive) {
      try {
        process.kill(-pid, 0);
        groupAlive = true;
      } catch (err) {
        groupAlive = err.code === 'EPERM';
      }
    }
    if (!groupAlive) return true;
    await sleep(250);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  await sleep(300);
  return !isAlive(pid);
}

export async function fetchHealth(url, timeoutMs = 2500) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { ok: false, status: resp.status };
    return { ok: true, status: resp.status, body: await resp.json().catch(() => null) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function waitForHealth(url, timeoutMs = 60000, isStillRunning = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchHealth(url);
    if (res.ok) return res;
    if (!isStillRunning()) return { ok: false, error: 'process exited' };
    await sleep(1000);
  }
  return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
}

/** Print the last `lines` lines of a file. */
export function tailFile(file, lines = 80) {
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/).slice(-lines - 1).join('\n');
}

/** Follow one or more files (like `tail -f`) until Ctrl+C. */
export function followFiles(files) {
  const offsets = new Map(files.map(({ file }) => [file, fs.existsSync(file) ? fs.statSync(file).size : 0]));
  const timer = setInterval(() => {
    for (const { component, file } of files) {
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      let pos = offsets.get(file) ?? 0;
      if (size < pos) pos = 0;
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        let chunk = '';
        try {
          const buf = Buffer.alloc(size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          chunk = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
        const prefix = files.length > 1 ? `[${component}] ` : '';
        process.stdout.write(prefix ? chunk.replace(/(^|\n)(?=.)/g, `$1${prefix}`) : chunk);
        offsets.set(file, size);
      }
    }
  }, 500);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}
