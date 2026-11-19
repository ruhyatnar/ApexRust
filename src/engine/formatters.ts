export function escapeCsvCell(raw: string | number | null | undefined): string {
  const s = raw === null || raw === undefined ? '' : String(raw);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function fmtUsdMagnitude(val: number): string {
  const safe = Number.isFinite(val) ? Math.abs(val) : 0;
  return safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function pricePrecisionDecimals(px: number): number {
  const abs = Math.abs(px);
  if (!Number.isFinite(abs) || abs === 0) return 4;
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  return 8;
}

export function fmtPx(px: number, digits?: number): string {
  if (!Number.isFinite(px)) return '0.00';
  if (digits !== undefined) return px.toFixed(digits);
  return px.toFixed(pricePrecisionDecimals(px));
}
