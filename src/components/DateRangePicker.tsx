import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { computeUtcDatePresetRange } from '../engine/orderHistoryAnalytics';

export interface DateRangeValue {
  startDate: string; // YYYY-MM-DD (UTC) or ''
  endDate: string; // YYYY-MM-DD (UTC) or ''
}

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  referenceNowMs?: number;
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function getUtcYearMonth(isoDate: string | undefined, fallbackMs: number): { year: number; month: number } {
  if (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return {
      year: Number(isoDate.slice(0, 4)),
      month: Number(isoDate.slice(5, 7)) - 1,
    };
  }
  const d = new Date(fallbackMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function toUtcIsoDate(year: number, monthZeroIdx: number, day: number): string {
  return new Date(Date.UTC(year, monthZeroIdx, day)).toISOString().slice(0, 10);
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value,
  onChange,
  referenceNowMs,
}) => {
  const [open, setOpen] = useState<boolean>(false);
  const [openUpward, setOpenUpward] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const effectiveNowMs = useMemo(() => referenceNowMs ?? Date.now(), [referenceNowMs, open]);
  const todayUtcIso = new Date(effectiveNowMs).toISOString().slice(0, 10);

  const [viewCursor, setViewCursor] = useState<{ year: number; month: number }>(() =>
    getUtcYearMonth(value.startDate || value.endDate, effectiveNowMs)
  );

  // Sync calendar month view and viewport placement whenever popover opens
  useEffect(() => {
    if (open) {
      setViewCursor(getUtcYearMonth(value.startDate || value.endDate, effectiveNowMs));
      if (rootRef.current) {
        const rect = rootRef.current.getBoundingClientRect();
        const needsUpwardFlip =
          rect.bottom + 390 > window.innerHeight && rect.top >= 390;
        setOpenUpward(needsUpwardFlip);
      }
    }
  }, [open, value.startDate, value.endDate, effectiveNowMs]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const hasRange = Boolean(value.startDate || value.endDate);

  const activePreset = useMemo(() => {
    if (!value.startDate && !value.endDate) return 'all' as const;
    for (const preset of ['today', '1d', '3d', '7d', '30d'] as const) {
      const p = computeUtcDatePresetRange(preset, effectiveNowMs);
      if (p.startDate === value.startDate && p.endDate === value.endDate) {
        return preset;
      }
    }
    return null;
  }, [value.startDate, value.endDate, effectiveNowMs]);

  const triggerLabel = useMemo(() => {
    if (!value.startDate && !value.endDate) return 'All Dates';
    if (activePreset === 'today') return `Today · ${value.startDate}`;
    if (value.startDate && value.endDate) {
      if (value.startDate === value.endDate) return `${value.startDate} UTC`;
      return `${value.startDate} → ${value.endDate}`;
    }
    if (value.startDate) return `From ${value.startDate}`;
    return `Until ${value.endDate}`;
  }, [value.startDate, value.endDate, activePreset]);

  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(Date.UTC(viewCursor.year, viewCursor.month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(viewCursor.year, viewCursor.month + 1, 0)).getUTCDate();
    const daysInPrevMonth = new Date(Date.UTC(viewCursor.year, viewCursor.month, 0)).getUTCDate();

    const cells: Array<{ iso: string; day: number; inMonth: boolean }> = [];
    for (let i = firstWeekday - 1; i >= 0; i -= 1) {
      const day = daysInPrevMonth - i;
      cells.push({
        iso: toUtcIsoDate(viewCursor.year, viewCursor.month - 1, day),
        day,
        inMonth: false,
      });
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push({
        iso: toUtcIsoDate(viewCursor.year, viewCursor.month, d),
        day: d,
        inMonth: true,
      });
    }
    const trailing = (7 - (cells.length % 7)) % 7;
    for (let t = 1; t <= trailing; t += 1) {
      cells.push({
        iso: toUtcIsoDate(viewCursor.year, viewCursor.month + 1, t),
        day: t,
        inMonth: false,
      });
    }
    return cells;
  }, [viewCursor.year, viewCursor.month]);

  const stepMonth = (delta: number) => {
    setViewCursor((prev) => {
      const shifted = new Date(Date.UTC(prev.year, prev.month + delta, 1));
      return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
    });
  };

  const handleDayClick = (iso: string) => {
    if (!value.startDate || (value.startDate && value.endDate)) {
      onChange({ startDate: iso, endDate: '' });
      return;
    }
    if (iso < value.startDate) {
      onChange({ startDate: iso, endDate: value.startDate });
    } else {
      onChange({ startDate: value.startDate, endDate: iso });
    }
  };

  const handleStartInput = (nextStart: string) => {
    if (nextStart && value.endDate && nextStart > value.endDate) {
      onChange({ startDate: value.endDate, endDate: nextStart });
      return;
    }
    onChange({ startDate: nextStart, endDate: value.endDate });
  };

  const handleEndInput = (nextEnd: string) => {
    if (nextEnd && value.startDate && nextEnd < value.startDate) {
      onChange({ startDate: nextEnd, endDate: value.startDate });
      return;
    }
    onChange({ startDate: value.startDate, endDate: nextEnd });
  };

  const applyPreset = (preset: 'all' | 'today' | '1d' | '3d' | '7d' | '30d') => {
    if (preset === 'all') {
      onChange({ startDate: '', endDate: '' });
      return;
    }
    const range = computeUtcDatePresetRange(preset, effectiveNowMs);
    onChange(range);
  };

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`flex items-center rounded-lg border bg-[#0B0F17] transition ${
          open || hasRange
            ? 'border-[#7DF2AD]/60 text-slate-100'
            : 'border-white/[0.08] text-slate-200 hover:border-white/[0.18]'
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Filter order logs by date range"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono tabular-nums whitespace-nowrap shrink-0 focus:outline-none"
        >
          <Calendar
            className={`h-3.5 w-3.5 ${hasRange ? 'text-[#7DF2AD]' : 'text-slate-400'}`}
            aria-hidden="true"
          />
          <span>{triggerLabel}</span>
        </button>

        {hasRange && (
          <button
            type="button"
            onClick={() => onChange({ startDate: '', endDate: '' })}
            aria-label="Clear date range"
            className="mr-1 rounded p-0.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="UTC date range picker"
          className={`absolute left-0 md:left-auto md:right-0 z-40 w-[312px] rounded-xl border border-white/[0.12] bg-[#10141B] p-3.5 shadow-2xl ${
            openUpward ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-white/[0.06]">
            <span className="text-xs font-semibold text-slate-100">Date Range (UTC)</span>
            <span className="font-mono text-[11px] text-slate-400">Inclusive bounds</span>
          </div>

          {/* Quick Time Period Presets */}
          <div className="mt-2.5 grid grid-cols-3 gap-1.5" role="group" aria-label="Date range presets">
            {(
              [
                { id: 'all', label: 'All Dates' },
                { id: 'today', label: 'Today' },
                { id: '1d', label: '1D' },
                { id: '3d', label: '3D' },
                { id: '7d', label: '7D' },
                { id: '30d', label: '1M (30D)' },
              ] as const
            ).map((preset) => {
              const isSelected = activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset.id)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition whitespace-nowrap ${
                    isSelected
                      ? 'bg-[#7DF2AD] text-[#0B0F17] font-semibold'
                      : 'border border-white/[0.08] bg-[#0B0F17] text-slate-300 hover:border-white/[0.2] hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Explicit Start / End Date Inputs */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400">
                From (UTC)
              </span>
              <input
                type="date"
                aria-label="Start date (UTC)"
                value={value.startDate}
                max={value.endDate || undefined}
                onChange={(e) => handleStartInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0B0F17] px-2 py-1 text-[11px] font-mono tabular-nums text-slate-100 [color-scheme:dark] focus:border-[#7DF2AD] focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400">
                To (UTC)
              </span>
              <input
                type="date"
                aria-label="End date (UTC)"
                value={value.endDate}
                min={value.startDate || undefined}
                onChange={(e) => handleEndInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#0B0F17] px-2 py-1 text-[11px] font-mono tabular-nums text-slate-100 [color-scheme:dark] focus:border-[#7DF2AD] focus:outline-none"
              />
            </label>
          </div>

          {/* Interactive UTC Month Calendar */}
          <div className="mt-3 rounded-lg border border-white/[0.06] bg-[#0B0F17] p-2.5">
            <div className="flex items-center justify-between pb-2">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                aria-label="Previous month"
                className="rounded p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="text-xs font-semibold text-slate-200 tabular-nums">
                {MONTH_NAMES[viewCursor.month]} {viewCursor.year}
              </span>
              <button
                type="button"
                onClick={() => stepMonth(1)}
                aria-label="Next month"
                className="rounded p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-mono text-slate-500">
              {WEEKDAY_LABELS.map((wd) => (
                <div key={wd} className="py-1">
                  {wd}
                </div>
              ))}
            </div>

            <div className="mt-0.5 grid grid-cols-7 gap-0.5">
              {calendarCells.map((cell) => {
                const isStart = Boolean(value.startDate && cell.iso === value.startDate);
                const isEnd = Boolean(value.endDate && cell.iso === value.endDate);
                const isEndpoint = isStart || isEnd;
                const isInBetween = Boolean(
                  value.startDate &&
                    value.endDate &&
                    cell.iso > value.startDate &&
                    cell.iso < value.endDate
                );
                const isToday = cell.iso === todayUtcIso;

                return (
                  <button
                    key={cell.iso}
                    type="button"
                    onClick={() => handleDayClick(cell.iso)}
                    aria-label={`Select ${cell.iso} UTC`}
                    aria-pressed={isEndpoint}
                    className={`h-7 rounded text-[11px] font-mono tabular-nums transition ${
                      isEndpoint
                        ? 'bg-[#7DF2AD] font-bold text-[#0B0F17]'
                        : isInBetween
                          ? 'bg-[#7DF2AD]/15 text-[#7DF2AD]'
                          : cell.inMonth
                            ? 'text-slate-200 hover:bg-white/[0.08]'
                            : 'text-slate-600 hover:bg-white/[0.04]'
                    } ${isToday && !isEndpoint ? 'border border-white/25' : ''}`}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => onChange({ startDate: '', endDate: '' })}
              disabled={!hasRange}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-400 transition hover:text-slate-100 disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-[#7DF2AD] px-3 py-1 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD]"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
