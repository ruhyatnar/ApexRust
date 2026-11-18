// Minimal semantic version helpers (no external dependencies).

/** Parse "v22.12.1", "rustc 1.86.0 (abc 2025-01-01)", "1.85" into [major, minor, patch]. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function atLeast(version, minimum) {
  const v = Array.isArray(version) ? version : parseVersion(version);
  const m = Array.isArray(minimum) ? minimum : parseVersion(minimum);
  if (!v || !m) return false;
  return compareVersions(v, m) >= 0;
}

/** Node requirement from Vite 8 / vite-plugin-pwa: ^20.19.0 || >=22.12.0 */
export const NODE_REQUIREMENT = '^20.19.0 || >=22.12.0';

export function nodeSatisfies(versionText) {
  const v = parseVersion(versionText);
  if (!v) return false;
  if (v[0] === 20) return atLeast(v, [20, 19, 0]);
  return atLeast(v, [22, 12, 0]);
}

/** Rust requirement: tokio 1.54 declares rust-version = 1.85 */
export const RUST_MINIMUM = '1.85.0';

export function rustSatisfies(versionText) {
  return atLeast(versionText, RUST_MINIMUM);
}
