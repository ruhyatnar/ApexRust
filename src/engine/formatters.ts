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

export function fmtSignedUsd(val: number): string {
  const safe = Number.isFinite(val) ? val : 0;
  return `${safe >= 0 ? '+' : '-'}$${fmtUsdMagnitude(safe)}`;
}

export function fmtPx(px: number, digits?: number): string {
  if (!Number.isFinite(px)) return '0.00';
  if (digits !== undefined) return px.toFixed(digits);
  return px >= 100 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toFixed(6);
}
