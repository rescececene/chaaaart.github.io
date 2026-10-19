import { cn } from '@/lib/utils';

export type LiveState = 'live' | 'closed' | 'delayed' | 'loading';
const TEXT: Record<LiveState, string> = { live: '실시간', closed: '장 마감', delayed: '지연 시세', loading: '불러오는 중' };

/** 시세 상태 — 초록 점(2초 숨쉬기)은 정말 실시간일 때만. 장 마감·지연·불러오는 중은 회색 점
 *  label 로 '장 마감 · 15:30 기준', '프리마켓' 같은 글을 바꿔 쓸 수 있다 */
export function LiveBadge({ state, label, className, title }: { state: LiveState; label?: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap text-muted-foreground', className)}>
      <i aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', state === 'live' ? 'live-dot bg-good' : 'bg-faint')} />
      {label ?? TEXT[state]}
    </span>
  );
}
