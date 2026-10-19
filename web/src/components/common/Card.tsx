import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/** 흰 카드 (토스식 둥근 모서리) */
export function Card({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <As className={cn('rounded-[20px] bg-card p-5 text-card-foreground md:p-6', className)}>{children}</As>;
}
export function CardTitle({ children, right, className, sub }: { children: ReactNode; right?: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <div className={cn('mb-4 flex items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[18px] font-bold tracking-tight">{children}</h2>
        {sub ? <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
export function PageTitle({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 px-1">
      <div>
        <h1 className="text-[24px] font-bold tracking-tight md:text-[26px]">{children}</h1>
        {sub ? <p className="mt-1 text-[14px] text-muted-foreground">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}
export function Empty({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center text-[14px] text-muted-foreground">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <div>{children}</div>
      {action}
    </div>
  );
}
/** 목록이 오기 전 보여 줄 뼈대 */
export function RowSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y divide-transparent">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-16" /></div>
          <div className="space-y-2 text-right"><Skeleton className="ml-auto h-3.5 w-20" /><Skeleton className="ml-auto h-3 w-12" /></div>
        </div>
      ))}
    </div>
  );
}
