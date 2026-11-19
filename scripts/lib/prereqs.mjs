// Prerequisite and environment checks shared by `setup` and `doctor`.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { IS_LINUX, IS_MAC, IS_WIN } from './paths.mjs';
import { NODE_REQUIREMENT, RUST_MINIMUM, nodeSatisfies, rustSatisfies } from './semver.mjs';

export function runCapture(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell: IS_WIN, windowsHide: true, ...opts });
  return {
    ok: !res.error && res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function fixFor(item) {
  if (IS_WIN) {
    return {
      git: 'winget install --id Git.Git -e',
      node: 'winget install --id OpenJS.NodeJS.LTS -e',
      npm: 'winget install --id OpenJS.NodeJS.LTS -e',
      rust: 'winget install --id Rustlang.Rustup -e  (then: rustup default stable)',
      buildtools:
        'winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
    }[item];
  }
  if (IS_MAC) {
    return {
      git: 'xcode-select --install',
      node: 'brew install node   (or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts)',
      npm: 'brew install node',
      rust: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
      buildtools: 'xcode-select --install',
    }[item];
  }
  return {
    git: 'sudo apt-get install -y git   (Fedora: sudo dnf install -y git)',
    node: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts',
    npm: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts',
    rust: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
    buildtools:
      'sudo apt-get install -y build-essential pkg-config libssl-dev   (Fedora: sudo dnf install -y gcc pkgconf-pkg-config openssl-devel; Arch: sudo pacman -S base-devel pkgconf openssl)',
  }[item];
}

/** Returns [{ id, name, ok, detail, fix, required }] */
export function checkPrerequisites({ needRust = true } = {}) {
  const results = [];

  const git = runCapture('git', ['--version']);
  results.push({ id: 'git', name: 'Git', ok: git.ok, detail: git.ok ? git.stdout : 'not found', fix: fixFor('git'), required: true });

  results.push({
    id: 'node',
    name: `Node.js (${NODE_REQUIREMENT})`,
    ok: nodeSatisfies(process.version),
    detail: process.version,
    fix: fixFor('node'),
    required: true,
  });

  const npm = runCapture('npm', ['--version']);
  results.push({ id: 'npm', name: 'npm', ok: npm.ok, detail: npm.ok ? npm.stdout : 'not found', fix: fixFor('npm'), required: true });

  if (needRust) {
    const rustc = runCapture('rustc', ['--version']);
    const cargo = runCapture('cargo', ['--version']);
    const rustOk = rustc.ok && cargo.ok && rustSatisfies(rustc.stdout);
    results.push({
      id: 'rust',
      name: `Rust toolchain (>= ${RUST_MINIMUM})`,
      ok: rustOk,
      detail: rustc.ok ? rustc.stdout : 'not found',
      fix: rustc.ok && !rustSatisfies(rustc.stdout) ? 'rustup update stable' : fixFor('rust'),
      required: true,
    });

    if (IS_LINUX) {
      const cc = runCapture('cc', ['--version']);
      const pkg = runCapture('pkg-config', ['--exists', 'openssl']);
      results.push({
        id: 'buildtools',
        name: 'C compiler, pkg-config & OpenSSL headers',
        ok: cc.ok && pkg.ok,
        detail: !cc.ok ? 'C compiler (cc) missing' : !pkg.ok ? 'pkg-config or libssl-dev/openssl-devel missing' : 'ok',
        fix: fixFor('buildtools'),
        required: true,
      });
    } else if (IS_MAC) {
      const clt = runCapture('xcode-select', ['-p']);
      results.push({
        id: 'buildtools',
        name: 'Xcode Command Line Tools',
        ok: clt.ok,
        detail: clt.ok ? clt.stdout : 'not installed',
        fix: fixFor('buildtools'),
        required: true,
      });
    } else if (IS_WIN) {
      const cl = runCapture('cl.exe', []);
      const vswhere = runCapture(
        '"%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe"',
        ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']
      );
      const msvcOk = cl.ok || (vswhere.ok && vswhere.stdout.length > 0);
      results.push({
        id: 'buildtools',
        name: 'MSVC C++ Build Tools',
        ok: msvcOk,
        detail: cl.ok ? 'cl.exe in PATH' : vswhere.ok && vswhere.stdout ? vswhere.stdout : 'not found',
        fix: fixFor('buildtools'),
        required: true,
      });
    }
  }
  return results;
}

/** True when nothing is listening on host:port. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export async function nextFreePort(start, host = '127.0.0.1', exclude = []) {
  for (let p = start; p < start + 100 && p <= 65535; p += 1) {
    if (exclude.includes(p)) continue;
    if (await isPortFree(p, host)) return p;
  }
  return start;
}
