import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type StatTone = 'blue' | 'green' | 'amber' | 'red' | 'indigo' | 'slate';

export interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  icon: ReactNode;
  tone?: StatTone;
  to?: string;
  className?: string;
}

const TONE_CLASSES: Record<
  StatTone,
  { iconBox: string; valueText: string; cardAccent: string }
> = {
  blue: {
    iconBox: 'bg-blue-50 text-blue-600 border-blue-100',
    valueText: 'text-blue-700',
    cardAccent: 'hover:border-blue-300'
  },
  green: {
    iconBox: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    valueText: 'text-slate-900',
    cardAccent: 'hover:border-emerald-300'
  },
  amber: {
    iconBox: 'bg-amber-50 text-amber-700 border-amber-200',
    valueText: 'text-amber-700',
    cardAccent: 'hover:border-amber-300'
  },
  red: {
    iconBox: 'bg-red-50 text-red-600 border-red-200',
    valueText: 'text-red-600',
    cardAccent: 'border-red-200 bg-red-50/30 hover:border-red-300'
  },
  indigo: {
    iconBox: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    valueText: 'text-indigo-700',
    cardAccent: 'hover:border-indigo-300'
  },
  slate: {
    iconBox: 'bg-slate-100 text-slate-600 border-slate-200',
    valueText: 'text-slate-900',
    cardAccent: 'hover:border-slate-300'
  }
};

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'slate',
  to,
  className = ''
}: StatCardProps) {
  const styles = TONE_CLASSES[tone];
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs leading-snug font-semibold text-slate-600 sm:text-sm">
          {label}
        </span>
        <span
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border sm:h-9 sm:w-9 ${styles.iconBox}`}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <div
        className={`mt-1.5 font-mono text-xl font-bold tracking-tight tabular-nums sm:mt-2 sm:text-3xl ${styles.valueText}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[11px] leading-snug text-slate-600 sm:mt-1 sm:text-xs">
          {hint}
        </div>
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={`group flex cursor-pointer flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 no-underline shadow-2xs transition-colors duration-150 sm:p-4 ${styles.cardAccent} ${className}`}
      >
        {inner}
      </Link>
    );
  }

  return (
    <div
      className={`flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs sm:p-4 ${className}`}
    >
      {inner}
    </div>
  );
}
