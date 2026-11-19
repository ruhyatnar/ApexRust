// Shared repository paths and platform flags for the ApexRust installer CLI.
// Uses only Node built-ins so it runs before `npm install`.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export const COMPONENTS = ['web', 'bot'];

export const PATHS = {
  cli: path.join(REPO_DIR, 'scripts', 'apexrust.mjs'),
  env: path.join(REPO_DIR, '.env'),
  envExample: path.join(REPO_DIR, '.env.example'),
  envBackup: path.join(REPO_DIR, '.env.bak'),
  botToml: path.join(REPO_DIR, 'rust-bot', 'config', 'bot.toml'),
  botTomlBackup: path.join(REPO_DIR, 'rust-bot', 'config', 'bot.toml.bak'),
  botExample: path.join(REPO_DIR, 'rust-bot', 'config', 'bot.example.toml'),
  rustDir: path.join(REPO_DIR, 'rust-bot'),
  botBinary: path.join(REPO_DIR, 'rust-bot', 'target', 'release', IS_WIN ? 'bot-desktop.exe' : 'bot-desktop'),
  distIndex: path.join(REPO_DIR, 'dist', 'index.html'),
  tsxCli: path.join(REPO_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  serverEntry: path.join(REPO_DIR, 'server.ts'),
  stateDir: path.join(REPO_DIR, '.apexrust'),
  runDir: path.join(REPO_DIR, '.apexrust', 'run'),
  logDir: path.join(REPO_DIR, '.apexrust', 'logs'),
  stateFile: path.join(REPO_DIR, '.apexrust', 'state.json'),
  remoteProfileFile: path.join(REPO_DIR, '.apexrust', 'remote-profile.json'),
};

/**
 * Cross-platform detector for Cloudflare One (Zero Trust WARP 100.96.0.0/12) and CGNAT mesh IPs (100.64.0.0/10)
 * on Linux, macOS, and Windows via `os.networkInterfaces()`.
 */
export function detectZeroTrustMeshIps(interfaces = os.networkInterfaces()) {
  const results = [];
  for (const [ifaceName, addrs] of Object.entries(interfaces ?? {})) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!addr || addr.internal) continue;
      const family = String(addr.family ?? '');
      if (family !== 'IPv4' && family !== '4') continue;
      const ip = String(addr.address ?? '').trim();
      const parts = ip.split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        continue;
      }
      const [a, b] = parts;
      if (a === 100 && b >= 64 && b <= 127) {
        const isCloudflareOne =
          (b >= 96 && b <= 111) || /warp|cloudflare|cf/i.test(ifaceName);
        results.push({
          iface: ifaceName,
          ip,
          kind: isCloudflareOne ? 'Cloudflare One (Zero Trust WARP)' : 'Zero Trust Mesh (CGNAT)',
        });
      }
    }
  }
  return results;
}

export function pidFile(component) {
  return path.join(PATHS.runDir, `${component}.pid`);
}

export function logFile(component) {
  return path.join(PATHS.logDir, `${component}.log`);
}

/** Ensure user-local toolchains (rustup / fnm) are discoverable even in fresh shells or services. */
export function augmentPath(env = process.env) {
  const home = os.homedir();
  const extra = [
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, '.fnm'),
    path.dirname(process.execPath),
  ];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of extra) {
    if (!current.includes(dir)) current.push(dir);
  }
  env[key] = current.join(path.delimiter);
  return env;
}
