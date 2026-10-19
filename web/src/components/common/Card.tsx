import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/** 흰 카드 (토스식 둥근 모서리) — 휴대폰(<640)에선 화면 끝까지 닿는 흰 구획이 되고, 카드 사이는 8px 회색 띠 */
export const CARD_CLS = 'rounded-[20px] bg-card text-card-foreground max-sm:rounded-none';
export function Card({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <As className={cn(CARD_CLS, 'px-4 py-5 sm:p-5 md:p-6', className)}>{children}</As>;
}
/** 카드 제목 — 오른쪽엔 13px 회색 캡션이나 '더보기 ›' 링크 */
export function CardTitle({ children, right, className, sub }: { children: ReactNode; right?: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <div className={cn('mb-3 flex items-end justify-between gap-3 sm:mb-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[18px] font-bold tracking-[-0.02em] md:text-[20px]">{children}</h2>
        {sub ? <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0 text-[13px] text-muted-foreground">{right}</div> : null}
    </div>
  );
}
/** 페이지 제목 — 회색 바탕 위 (부제엔 상태 점을 넣을 수 있다) */
export function PageTitle({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-4 mt-5 mb-3 flex flex-wrap items-end justify-between gap-x-3 gap-y-2.5 sm:mx-1 sm:mt-2 sm:mb-4">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-8 font-bold tracking-tight md:text-[26px] md:leading-[34px]">{children}</h1>
        {sub ? <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[14px] text-muted-foreground sm:text-[15px]">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}
/** 'AI' 위첨자 표시 (보라 한 가지) */
export function AiMark({ big }: { big?: boolean }) {
  return <sup className={cn('ml-[3px] font-extrabold tracking-normal text-ai', big ? 'top-[-0.7em] text-[13px]' : 'top-[-0.6em] text-[10px]')}>AI</sup>;
}
/** 빈 상태 — 56px 회색 원 아이콘 + 17px 제목 + 14px 설명 + 보조 버튼 하나 */
export function Empty({ children, icon, title, action }: { children?: ReactNode; icon?: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon ? <div className="mb-3.5 grid size-14 place-items-center rounded-full bg-secondary text-muted-foreground [&_svg]:size-7">{icon}</div> : null}
      {title ? <p className="text-[17px] leading-6 font-bold text-foreground">{title}</p> : null}
      {children ? <div className={cn('max-w-[300px] text-[14px] leading-[1.5] text-muted-foreground', title && 'mt-1')}>{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
/** 빈 상태·오류 안의 보조 버튼 */
export const EMPTY_BTN = 'press inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-secondary px-4 text-[14px] font-semibold text-secondary-foreground hover:bg-border/60 disabled:opacity-40';
/** 목록이 오기 전 보여 줄 뼈대 (시장 행과 같은 모양) */
export function RowSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[62px] items-center gap-3 px-2 lg:h-[52px]">
          <Skeleton className="size-9 rounded-full bg-secondary" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-28 bg-secondary" /><Skeleton className="h-3 w-16 bg-secondary" /></div>
          <div className="space-y-2 text-right"><Skeleton className="ml-auto h-3.5 w-20 bg-secondary" /><Skeleton className="ml-auto h-3 w-12 bg-secondary" /></div>
        </div>
      ))}
    </div>
  );
}
