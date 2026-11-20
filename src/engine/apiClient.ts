/**
 * Client-side connection profile manager (`🖥️ This Computer` vs `☁️ Remote VPS`)
 * and `apiFetch` wrapper for the Desktop PWA / React UI.
 */

export type ConnectionProfile =
  | { kind: 'local' }
  | {
      kind: 'remote';
      name: string;
      baseUrl: string;
      token: string;
      rememberToken: boolean;
    };

export const EXPECTED_REMOTE_API_VERSION = '2.0.0';

const PROFILE_STORAGE_KEY = 'apexrust_connection_profile_v1';
const SESSION_TOKEN_STORAGE_KEY = 'apexrust_connection_token_v1';
const LOCAL_TOKEN_STORAGE_KEY = 'apexrust_local_proxy_token_v1';
const CLIENT_ID_STORAGE_KEY = 'apexrust_client_session_id_v1';

export function getLocalAccessToken(): string {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return (window.sessionStorage.getItem(LOCAL_TOKEN_STORAGE_KEY) ?? '').trim();
    }
  } catch {
    // Ignore storage access errors
  }
  return '';
}

export function setLocalAccessToken(token: string): void {
  const clean = token.trim();
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      if (clean) {
        window.sessionStorage.setItem(LOCAL_TOKEN_STORAGE_KEY, clean);
      } else {
        window.sessionStorage.removeItem(LOCAL_TOKEN_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage access errors
  }
}

interface StoredProfileRecord {
  kind: 'local' | 'remote';
  name?: string;
  baseUrl?: string;
  rememberToken?: boolean;
  persistedToken?: string;
}

export function validateRemoteBaseUrl(
  rawUrl: string
): { ok: true; normalizedUrl: string } | { ok: false; error: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter the Remote VPS Address (e.g. http://100.96.1.10:3000).' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'VPS Address must start with http:// or https://' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'Do not embed credentials in the URL; use the Access Token field.' };
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api(\/engine)?$/, '');
    if (cleanPath.includes('..')) {
      return { ok: false, error: 'Invalid URL path.' };
    }
    const normalizedUrl = `${parsed.origin}${cleanPath}`;
    return { ok: true, normalizedUrl };
  } catch {
    return {
      ok: false,
      error: 'Invalid VPS Address format. Example: http://100.96.1.10:3000',
    };
  }
}

export function buildApiUrl(profile: ConnectionProfile, apiPath: string): string {
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (profile.kind === 'local') {
    return cleanPath;
  }
  const base = profile.baseUrl.trim().replace(/\/+$/, '');
  if (!base) {
    return cleanPath;
  }
  return `${base}${cleanPath}`;
}

function getBrowserClientId(): string {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
      if (existing) return existing;
      const generated = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
      return generated;
    }
  } catch {
    // Fallback when sessionStorage is unavailable
  }
  return 'desktop-default-client';
}

export function buildAuthHeaders(
  profile: ConnectionProfile,
  clientId = getBrowserClientId()
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-ApexRust-Client-Id': clientId,
  };
  const tok =
    profile.kind === 'remote'
      ? profile.token.trim()
      : getLocalAccessToken();
  if (tok.length > 0) {
    headers.Authorization = `Bearer ${tok}`;
    headers['X-ApexRust-Token'] = tok;
  }
  return headers;
}

export function loadConnectionProfile(): ConnectionProfile {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { kind: 'local' };
    }
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return { kind: 'local' };
    const parsed = JSON.parse(raw) as StoredProfileRecord;
    if (parsed.kind !== 'remote' || !parsed.baseUrl) {
      return { kind: 'local' };
    }
    const check = validateRemoteBaseUrl(parsed.baseUrl);
    if (!check.ok) {
      return { kind: 'local' };
    }
    const rememberToken = Boolean(parsed.rememberToken);
    let token = '';
    if (rememberToken && typeof parsed.persistedToken === 'string') {
      token = parsed.persistedToken;
    } else if (window.sessionStorage) {
      token = window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? '';
    }
    return {
      kind: 'remote',
      name: (parsed.name || 'Remote VPS').trim() || 'Remote VPS',
      baseUrl: check.normalizedUrl,
      token,
      rememberToken,
    };
  } catch {
    return { kind: 'local' };
  }
}

export function saveConnectionProfile(profile: ConnectionProfile): void {
  activeProfile = profile;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (profile.kind === 'local') {
      const rec: StoredProfileRecord = { kind: 'local' };
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(rec));
      if (window.sessionStorage) {
        window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      }
      return;
    }
    const rec: StoredProfileRecord = {
      kind: 'remote',
      name: profile.name.trim() || 'Remote VPS',
      baseUrl: profile.baseUrl.trim().replace(/\/+$/, ''),
      rememberToken: profile.rememberToken,
      ...(profile.rememberToken ? { persistedToken: profile.token } : {}),
    };
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(rec));
    if (window.sessionStorage) {
      if (profile.token) {
        window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, profile.token);
      } else {
        window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage quota errors
  }
}

let activeProfile: ConnectionProfile = loadConnectionProfile();

function getActiveConnectionProfile(): ConnectionProfile {
  return activeProfile;
}

export function setActiveConnectionProfile(profile: ConnectionProfile): void {
  saveConnectionProfile(profile);
}

/**
 * Builds a WebSocket (`ws://` or `wss://`) URL for local proxy or Remote VPS endpoints,
 * appending `?token=` when an access token is configured.
 */
export function buildWebSocketUrl(
  wsPath: string,
  profile: ConnectionProfile = getActiveConnectionProfile()
): string {
  const cleanPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
  let base = '';
  if (profile.kind === 'remote' && profile.baseUrl.trim()) {
    base = profile.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/^https:/i, 'wss:')
      .replace(/^http:/i, 'ws:');
  } else if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${proto}//${window.location.host}`;
  } else {
    base = 'ws://127.0.0.1:4173';
  }
  const tok =
    profile.kind === 'remote'
      ? profile.token.trim()
      : getLocalAccessToken();
  if (!tok) {
    return `${base}${cleanPath}`;
  }
  const sep = cleanPath.includes('?') ? '&' : '?';
  return `${base}${cleanPath}${sep}token=${encodeURIComponent(tok)}`;
}

/**
 * Preferred WebSocket URL builder: exchanges the bearer token for a 30s
 * single-use ticket so the long-lived token never appears in request URLs or
 * proxy access logs. Falls back to the legacy `?token=` form when the ticket
 * endpoint is unavailable (older engine builds).
 */
export async function buildWebSocketUrlWithTicket(
  wsPath: string,
  profile: ConnectionProfile = getActiveConnectionProfile()
): Promise<string> {
  const legacyUrl = buildWebSocketUrl(wsPath, profile);
  const token = profile.kind === 'remote' ? profile.token.trim() : getLocalAccessToken();
  if (!token) return legacyUrl;
  try {
    const resp = await fetch(buildApiUrl(profile, '/api/ws-ticket'), {
      method: 'POST',
      headers: buildAuthHeaders(profile),
    });
    if (!resp.ok) return legacyUrl;
    const data = (await resp.json()) as { ticket?: unknown };
    const ticket = typeof data.ticket === 'string' ? data.ticket.trim() : '';
    if (!ticket) return legacyUrl;
    const withoutToken = legacyUrl
      .replace(/([?&])token=[^&]*&?/, '$1')
      .replace(/[?&]$/, '');
    const sep = withoutToken.includes('?') ? '&' : '?';
    return `${withoutToken}${sep}ticket=${encodeURIComponent(ticket)}`;
  } catch {
    return legacyUrl;
  }
}

/**
 * Drop-in replacement for `fetch('/api/...')` that routes to either:
 * - `🖥️ This Computer (Local)` (same-origin `/api/...`)
 * - `☁️ Remote VPS (24/7 Server)` (`<baseUrl>/api/...` with Cloudflare One / Bearer token headers)
 */
export async function apiFetch(apiPath: string, init?: RequestInit): Promise<Response> {
  const profile = getActiveConnectionProfile();
  const url = buildApiUrl(profile, apiPath);
  const authHeaders = buildAuthHeaders(profile);
  const mergedHeaders = new Headers(init?.headers ?? {});
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!mergedHeaders.has(k)) {
      mergedHeaders.set(k, v);
    }
  }
  return fetch(url, {
    ...init,
    headers: mergedHeaders,
  });
}
