import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 py-10 text-center">
      <div
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-500 shadow-2xs ring-1 ring-slate-200"
        aria-hidden="true"
      >
        {icon}
      </div>
      <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
      {description && (
        <p className="mt-1 mb-0 max-w-md text-sm text-slate-600">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

