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
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(250);
  }
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
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
