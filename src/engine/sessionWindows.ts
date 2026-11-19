import type { UtcTimeWindow } from './types';

export const DEFAULT_UTC_SESSION_WINDOWS: UtcTimeWindow[] = [
  {
    id: 'london-open',
    label: 'London Open',
    startUtc: '07:00',
    endUtc: '11:00',
    enabled: true,
  },
  {
    id: 'london-ny-overlap',
    label: 'London / NY Overlap',
    startUtc: '12:30',
    endUtc: '16:30',
    enabled: true,
  },
  {
    id: 'us-close-auction',
    label: 'US Equities Close',
    startUtc: '19:00',
    endUtc: '21:00',
    enabled: false,
  },
];

interface SessionWindowPreset {
  id: string;
  label: string;
  startUtc: string;
  endUtc: string;
}

export const UTC_SESSION_PRESETS: SessionWindowPreset[] = [
  {
    id: 'tokyo-open',
    label: 'Tokyo / Asia Open',
    startUtc: '00:00',
    endUtc: '04:00',
  },
  {
    id: 'london-open',
    label: 'London Open',
    startUtc: '07:00',
    endUtc: '11:00',
  },
  {
    id: 'london-ny-overlap',
    label: 'London / NY Overlap',
    startUtc: '12:30',
    endUtc: '16:30',
  },
  {
    id: 'ny-open-drive',
    label: 'NY Cash Open',
    startUtc: '13:30',
    endUtc: '17:00',
  },
  {
    id: 'us-close-auction',
    label: 'US Equities Close',
    startUtc: '19:00',
    endUtc: '21:00',
  },
];

interface SessionWindowEvaluation {
  allowed: boolean;
  filterEnabled: boolean;
  currentUtcHHMM: string;
  currentMinuteOfDay: number;
  activeWindow: UtcTimeWindow | null;
  enabledWindowCount: number;
  reason: string;
}

/**
 * Parses a "HH:MM" UTC clock string into integer minutes since 00:00 UTC (0..1439).
 * Returns null if the format or bounds are invalid.
 */
export function parseUtcTimeToMinutes(hhmm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Formats integer minutes since midnight (0..1439) as "HH:MM".
 */
function formatUtcMinutes(minuteOfDay: number): string {
  const normalized = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(normalized / 60)).padStart(2, '0');
  const mm = String(normalized % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Returns current UTC "HH:MM" and minute-of-day (0..1439) for an epoch timestamp.
 */
function getUtcClockInfo(nowMs: number): { hhmm: string; minuteOfDay: number } {
  const d = new Date(nowMs);
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return {
    hhmm: formatUtcMinutes(minuteOfDay),
    minuteOfDay,
  };
}

/**
 * Checks whether `minuteOfDay` falls within `[startMin, endMin)`.
 * Supports overnight wrap windows where `startMin > endMin` (e.g. 22:00 -> 02:00 UTC).
 * When `startMin === endMin`, covers the full 24-hour cycle.
 */
export function isMinuteInUtcWindow(
  minuteOfDay: number,
  startMin: number,
  endMin: number
): boolean {
  if (startMin === endMin) {
    return true;
  }
  if (startMin < endMin) {
    return minuteOfDay >= startMin && minuteOfDay < endMin;
  }
  // Overnight wrap (e.g. 22:00..02:00)
  return minuteOfDay >= startMin || minuteOfDay < endMin;
}

/**
 * Evaluates whether automated trading execution is permitted at `nowMs` given
 * the configured daily UTC time windows and the `sessionWindowFilter` toggle.
 */
export function evaluateUtcSessionWindows(
  nowMs: number,
  windows: UtcTimeWindow[] | undefined,
  filterEnabled: boolean
): SessionWindowEvaluation {
  const { hhmm, minuteOfDay } = getUtcClockInfo(nowMs);
  const list = Array.isArray(windows) ? windows : DEFAULT_UTC_SESSION_WINDOWS;
  const enabledWindows = list.filter((w) => w.enabled);

  if (!filterEnabled) {
    return {
      allowed: true,
      filterEnabled: false,
      currentUtcHHMM: hhmm,
      currentMinuteOfDay: minuteOfDay,
      activeWindow: null,
      enabledWindowCount: enabledWindows.length,
      reason: '24/7 execution active (UTC session window filter OFF)',
    };
  }

  if (enabledWindows.length === 0) {
    return {
      allowed: false,
      filterEnabled: true,
      currentUtcHHMM: hhmm,
      currentMinuteOfDay: minuteOfDay,
      activeWindow: null,
      enabledWindowCount: 0,
      reason: `Blocked at ${hhmm} UTC — no active daily UTC liquidity windows enabled`,
    };
  }

  for (const win of enabledWindows) {
    const startMin = parseUtcTimeToMinutes(win.startUtc);
    const endMin = parseUtcTimeToMinutes(win.endUtc);
    if (startMin === null || endMin === null) continue;
    if (isMinuteInUtcWindow(minuteOfDay, startMin, endMin)) {
      return {
        allowed: true,
        filterEnabled: true,
        currentUtcHHMM: hhmm,
        currentMinuteOfDay: minuteOfDay,
        activeWindow: win,
        enabledWindowCount: enabledWindows.length,
        reason: `Active in ${win.label} (${win.startUtc}–${win.endUtc} UTC)`,
      };
    }
  }

  const summary = enabledWindows.map((w) => `${w.startUtc}–${w.endUtc}`).join(', ');
  return {
    allowed: false,
    filterEnabled: true,
    currentUtcHHMM: hhmm,
    currentMinuteOfDay: minuteOfDay,
    activeWindow: null,
    enabledWindowCount: enabledWindows.length,
    reason: `Blocked at ${hhmm} UTC — outside allowed liquidity windows (${summary} UTC)`,
  };
}
