import { AlertTriangle, Check, Loader2 } from 'lucide-react';

export type StepState = 'done' | 'active' | 'pending' | 'error';

export interface StepItem {
  label: string;
  state: StepState;
}

export function StatusStepper({ steps }: { steps: [StepItem, StepItem, StepItem] }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:gap-2" aria-label="Các bước gửi video">
      {steps.map((step, idx) => {
        const isDone = step.state === 'done';
        const isActive = step.state === 'active';
        const isError = step.state === 'error';

        const pillStyle = isDone
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : isError
            ? 'border-red-200 bg-red-50 text-red-800'
            : isActive
              ? 'border-blue-200 bg-blue-50 text-blue-800'
              : 'border-slate-200 bg-slate-50 text-slate-600';

        return (
          <div
            key={step.label}
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center text-[11px] leading-tight font-semibold sm:flex-row sm:justify-start sm:gap-1.5 sm:px-2.5 sm:py-1.5 sm:text-left sm:text-xs ${pillStyle}`}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full">
              {isDone ? (
                <Check className="h-3.5 w-3.5 text-emerald-700" />
              ) : isError ? (
                <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
              ) : isActive ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
              ) : (
                <span className="font-mono text-[11px] text-slate-500">{idx + 1}</span>
              )}
            </span>
            <span className="line-clamp-2 sm:truncate">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}
