import { useId } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface SegItem<T extends string> { value: T; label: React.ReactNode }

/** 토스식 세그먼트 — 회색 바탕 위에서 흰 손잡이가 미끄러진다 */
export function Segmented<T extends string>({ items, value, onChange, size = 'md', className, full }: {
  items: SegItem<T>[]; value: T; onChange: (v: T) => void; size?: 'sm' | 'md'; className?: string; full?: boolean;
}) {
  const id = useId();
  return (
    <div role="tablist" className={cn('no-scrollbar inline-flex max-w-full overflow-x-auto rounded-xl bg-secondary p-1', full && 'flex w-full', className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value} role="tab" aria-selected={on} onClick={() => onChange(it.value)}
            className={cn(
              'press relative shrink-0 rounded-[10px] font-semibold whitespace-nowrap transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-[13px]' : 'px-3.5 py-1.5 text-[14px]',
              full && 'flex-1',
              on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {on && (
              <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-[10px] bg-background shadow-[0_1px_3px_rgba(0,0,0,0.12)] dark:bg-popover"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }} />
            )}
            <span className="relative">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 밑줄 탭 — 상단 내비·카드 안 탭용 */
export function UnderlineTabs<T extends string>({ items, value, onChange, className }: {
  items: SegItem<T>[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  const id = useId();
  return (
    <div role="tablist" className={cn('no-scrollbar flex gap-5 overflow-x-auto', className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button key={it.value} role="tab" aria-selected={on} onClick={() => onChange(it.value)}
            className={cn('relative shrink-0 py-2.5 text-[15px] font-semibold whitespace-nowrap transition-colors', on ? 'text-foreground' : 'text-subtle hover:text-foreground')}>
            {it.label}
            {on && <motion.span layoutId={`ul-${id}`} className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-foreground" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          </button>
        );
      })}
    </div>
  );
}

/** 알약 칩 (정렬·필터) */
export function Chip({ on, onClick, children, className, tone, title }: { on?: boolean; onClick?: () => void; children: React.ReactNode; className?: string; tone?: 'up' | 'down' | 'flat'; title?: string }) {
  return (
    <button onClick={onClick} aria-pressed={on} title={title}
      className={cn('press inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap transition-colors',
        on ? 'bg-foreground text-background' : 'bg-secondary text-secondary-foreground hover:bg-border/60',
        !on && tone === 'up' && 'text-up-text', !on && tone === 'down' && 'text-down-text', className)}>
      {children}
    </button>
  );
}
