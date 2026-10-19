import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { signedPct } from './Change';

const DIR = (x: number) => (x > 0 ? 'text-up-text' : x < 0 ? 'text-down-text' : 'text-muted-foreground');

/** AI 예측 범위 — 8px 회색 트랙에 10~90% 구간 보라 띠, 0 눈금, 중앙값 보라 점. 위엔 제목 · 중앙값, 아래엔 양 끝 값(방향색)
 *  (값은 분수: 0.034 = 3.4%) */
export function AiRange({ q10, q50, q90, label, className }: { q10: number; q50: number; q90: number; label: ReactNode; className?: string }) {
  const lo = Math.min(q10, -0.02), hi = Math.max(q90, 0.02), span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 text-[13px] text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 whitespace-nowrap">중앙 <b className={cn('font-semibold tabular', DIR(q50))}>{signedPct(q50 * 100, 1)}</b></span>
      </div>
      <div className="relative mt-2.5 mb-1.5 h-2 rounded-full bg-border" role="img" aria-label={`예상 범위 ${signedPct(q10 * 100, 1)} ~ ${signedPct(q90 * 100, 1)}, 중앙 ${signedPct(q50 * 100, 1)}`}>
        <span className="absolute inset-y-0 rounded-full bg-[color-mix(in_srgb,var(--ai)_30%,var(--border))]" style={{ left: `${x(q10)}%`, width: `${x(q90) - x(q10)}%` }} />
        <span className="absolute -inset-y-[3px] w-[1.5px] -translate-x-1/2 bg-muted-foreground" style={{ left: `${x(0)}%` }} />
        <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ai shadow-[0_0_0_2px_var(--card)]" style={{ left: `${x(q50)}%` }} />
      </div>
      <div className="flex justify-between text-[12px] font-semibold tabular">
        <span className={DIR(q10)}>{signedPct(q10 * 100, 1)}</span>
        <span className={DIR(q90)}>{signedPct(q90 * 100, 1)}</span>
      </div>
    </div>
  );
}

/** 가격 범위 막대 — 4px 회색 트랙에 지금 위치를 10px 먹색 점으로. 위: 이름 · 오른쪽 값, 아래: 저가(파랑) · 고가(빨강) */
export function PriceRange({ lo, hi, cur, label, right, loText, hiText, className }: {
  lo: number; hi: number; cur: number; label: ReactNode; right?: ReactNode; loText: ReactNode; hiText: ReactNode; className?: string;
}) {
  const p = hi > lo ? Math.min(100, Math.max(0, ((cur - lo) / (hi - lo)) * 100)) : 50;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 text-[13px] text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        {right ? <span className="shrink-0 whitespace-nowrap">{right}</span> : null}
      </div>
      <div className="relative mx-[5px] my-2 h-1 rounded-full bg-border">
        <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card" style={{ left: `${p}%` }} />
      </div>
      <div className="flex justify-between gap-3 text-[13px] text-muted-foreground tabular">
        <span>{loText}</span>
        <span>{hiText}</span>
      </div>
    </div>
  );
}
