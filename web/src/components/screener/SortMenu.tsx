// 정렬 — 휴대폰은 드롭다운, PC 는 표 머리글을 눌러서
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SORT_OPTIONS, sortLabel, WIDE_GRID, type Sort, type SortKey } from './model';

export function SortMenu({ sort, onChange }: { sort: Sort; onChange: (s: Sort) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="press inline-flex h-[34px] shrink-0 items-center gap-0.5 rounded-full bg-secondary pr-2.5 pl-3.5 text-[14px] font-semibold text-secondary-foreground hover:bg-border/60">
          {sortLabel(sort)}<ChevronDown className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 rounded-2xl p-1.5">
        <DropdownMenuRadioGroup value={`${sort.k}:${sort.d}`} onValueChange={(v) => { const [k, d] = v.split(':'); onChange({ k: k as SortKey, d: d === '1' ? 1 : -1 }); }}>
          {SORT_OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={`${o.k}:${o.d}`} value={`${o.k}:${o.d}`} className="rounded-xl py-2.5 pr-9 pl-3 text-[14px]">{o.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const COLS: { k: SortKey | null; label: string; right?: boolean; hint?: string }[] = [
  { k: 'name', label: '종목' },
  { k: null, label: '신호' },
  { k: 'price', label: '현재가', right: true },
  { k: 'chg', label: '등락률', right: true },
  { k: 'vol', label: '거래대금', right: true },
  { k: 'rsi', label: 'RSI', right: true, hint: '일봉 RSI(14)' },
  { k: 'volRatio', label: '거래량', right: true, hint: '오늘 거래량 ÷ 최근 20일 평균' },
  { k: 'op', label: '의견', right: true, hint: '이동평균·RSI·MACD·볼린저 9개 지표 종합' },
];

/** PC 표 머리글 — 누르면 그 열로 정렬, 한 번 더 누르면 방향을 바꾼다. 내려도 사이트 머리글 아래에 붙어 있다 */
export function SortHeader({ sort, onChange, top }: { sort: Sort; onChange: (s: Sort) => void; top: number }) {
  return (
    <div style={{ top }} className={cn(WIDE_GRID, 'sticky z-10 -mx-3 h-[34px] bg-card px-3 text-[13px] font-semibold whitespace-nowrap text-muted-foreground')}>
      {COLS.map((c) => {
        if (!c.k) return <span key={c.label}>{c.label}</span>;
        const k = c.k;
        const on = sort.k === k;
        const Icon = sort.d > 0 ? ArrowUp : ArrowDown;
        return (
          <button
            key={k} title={c.hint}
            aria-label={`${c.label}${on ? (sort.d > 0 ? ', 오름차순 정렬됨' : ', 내림차순 정렬됨') : '로 정렬'}`}
            onClick={() => onChange({ k, d: on ? (sort.d > 0 ? -1 : 1) : k === 'name' ? 1 : -1 })}
            className={cn('inline-flex items-center gap-0.5 whitespace-nowrap transition-colors hover:text-foreground', c.right && 'justify-self-end', k === 'name' && 'col-span-2', on && 'text-foreground')}
          >
            {c.label}{on && <Icon className="size-3" strokeWidth={2.4} />}
          </button>
        );
      })}
    </div>
  );
}
