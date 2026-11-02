import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, badge, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="m-0 text-lg font-bold tracking-tight text-slate-900 sm:text-2xl">
            {title}
          </h1>
          {badge}
        </div>
        {subtitle && (
          <p className="mt-1 mb-0 text-xs leading-relaxed text-slate-600 sm:text-sm">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end [&>*]:flex-1 sm:[&>*]:flex-initial">
          {actions}
        </div>
      )}
    </div>
  );
}
