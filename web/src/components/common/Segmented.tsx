import { useId } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface SegItem<T extends string> { value: T; label: React.ReactNode }

// 세그먼트 크기 — md 40(15px) 거래소·시장 고르기 · sm 32(14px) 상세 머리 · xs 26(12.5px) 캔들/라인
const SEG = {
  md: { track: 'rounded-xl p-1', btn: 'h-8 rounded-[9px] px-4 text-[15px]' },
  sm: { track: 'rounded-[10px] p-[3px]', btn: 'h-[26px] rounded-lg px-3 text-[14px]' },
  xs: { track: 'rounded-lg p-[2px]', btn: 'h-[22px] rounded-md px-2.5 text-[12.5px]' },
} as const;

/** 토스식 세그먼트 — 회색 홈 위에서 흰 손잡이가 미끄러진다 (다크는 한 단계 밝은 회색 손잡이, 그림자 없음) */
export function Segmented<T extends string>({ items, value, onChange, size = 'md', className, full }: {
  items: SegItem<T>[]; value: T; onChange: (v: T) => void; size?: 'xs' | 'sm' | 'md'; className?: string; full?: boolean;
}) {
  const id = useId();
  const s = SEG[size];
  return (
    <div role="tablist" className={cn('no-scrollbar inline-flex max-w-full gap-0.5 overflow-x-auto bg-secondary', s.track, full && 'flex w-full', className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(it.value)}
            className={cn(
              'press relative inline-flex items-center justify-center whitespace-nowrap transition-colors',
              s.btn,
              // full: 칸을 똑같이 나누고, 좁으면(320px 에 탭 5개) 여백을 줄여 줄어들 수 있게 — 아니면 글자 폭만큼
              full ? 'min-w-0 flex-1 shrink px-2' : 'shrink-0',
              on ? 'font-bold text-foreground' : 'font-semibold text-muted-foreground hover:text-foreground',
            )}
          >
            {on && (
              <motion.span layoutId={`seg-${id}`} className={cn('absolute inset-0 bg-[var(--seg-on)] shadow-[var(--seg-shadow)]', s.btn.split(' ').find((c) => c.startsWith('rounded')))}
                transition={{ type: 'spring', stiffness: 520, damping: 40 }} />
            )}
            <span className="relative inline-flex items-center">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 밑줄 탭 — 카드 안 탭·상단 내비 (켬: 먹색 굵게 + 2px 밑줄, 끔: 회색). 높이 48, lg 는 17px(시장 목록 머리) */
export function UnderlineTabs<T extends string>({ items, value, onChange, className, size = 'md' }: {
  items: SegItem<T>[]; value: T; onChange: (v: T) => void; className?: string; size?: 'md' | 'lg';
}) {
  const id = useId();
  return (
    <div role="tablist" className={cn('no-scrollbar flex gap-5 overflow-x-auto', size === 'lg' && 'sm:gap-6', className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button key={it.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(it.value)}
            className={cn(
              'relative inline-flex h-12 shrink-0 items-center whitespace-nowrap tracking-[-0.02em] transition-colors',
              size === 'lg' ? 'text-[16px] font-bold sm:text-[17px]' : 'text-[15px]',
              on ? 'font-bold text-foreground' : cn('text-muted-foreground hover:text-secondary-foreground', size === 'md' && 'font-semibold'),
            )}>
            {it.label}
            {on && <motion.span layoutId={`ul-${id}`} className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-foreground" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          </button>
        );
      })}
    </div>
  );
}

const GLYPH = { up: '▲', down: '▼', flat: '●' } as const;
const GLYPH_TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;

/** 알약 칩 (정렬·필터) — 켬은 짙은 회색 알약. tone 칩(신호)은 글자는 먹색 그대로, ▲▼● 글머리만 방향색.
 *  disabled(개수 0)는 흐린 글자 + 옅은 바탕 (투명도로 흐리지 않는다) */
export function Chip({ on, onClick, children, className, tone, title, disabled }: {
  on?: boolean; onClick?: () => void; children: React.ReactNode; className?: string; tone?: 'up' | 'down' | 'flat'; title?: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title} disabled={disabled && !on}
      className={cn('press inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold whitespace-nowrap transition-colors',
        on ? 'bg-secondary-foreground text-card'
          : disabled ? 'bg-hover text-faint'
            : 'bg-secondary text-secondary-foreground hover:bg-border/60',
        tone && 'pl-3',
        className)}>
      {tone ? <span aria-hidden className={cn('text-[9px]', on ? 'text-current' : disabled ? 'text-faint' : GLYPH_TONE[tone])}>{GLYPH[tone]}</span> : null}
      {children}
    </button>
  );
}
