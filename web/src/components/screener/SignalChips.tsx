// 조건 칩 15개 — 두 줄 격자(위: 상승 쪽 · 아래: 하락 쪽), 좁은 화면에선 옆으로 밀어서 본다
import { cn } from '@/lib/utils';
import { Chip } from '@/components/common/Segmented';
import { SIGNAL_INFO, SIGNALS } from '@/lib/indicators';
import { CHIP_GRID } from './model';

/** 고른 조건의 뜻 — 칩 아래에 한 줄씩 (안 골랐으면 안내 한 줄) */
export function SignalHelp({ selected }: { selected: string[] }) {
  if (!selected.length) return <p className="mt-2.5 text-[12.5px] text-subtle">조건을 누르면 뜻이 여기에 나와요</p>;
  return (
    <ul className="mt-2.5 space-y-1">
      {selected.map((k) => {
        const info = SIGNAL_INFO[k];
        if (!info) return null;
        return (
          <li key={k} className="text-[13px] leading-snug break-keep text-secondary-foreground">
            <b className="font-semibold text-foreground">{SIGNALS[k]?.[0]}</b> — {info[0]} <span className="text-subtle">({info[1]})</span>
          </li>
        );
      })}
    </ul>
  );
}

export function SignalChips({ selected, counts, onToggle }: {
  selected: string[]; counts: Record<string, number> | null; onToggle: (k: string) => void;
}) {
  return (
    // relative: 안쪽 sr-only(절대 위치) 글자가 스크롤 상자 밖으로 새어 페이지를 가로로 늘리지 않게
    <div className="no-scrollbar relative -mx-5 overflow-x-auto px-5 md:-mx-6 md:px-6">
      <div role="group" aria-label="조건 고르기" className="grid w-max auto-cols-max grid-flow-col grid-rows-2 gap-2">
        {CHIP_GRID.map((k, i) => {
          if (!k) return <span key={`gap-${i}`} aria-hidden />;
          const [label, tone] = SIGNALS[k];
          const on = selected.includes(k);
          const n = counts ? counts[k] || 0 : null;
          return (
            <Chip key={k} on={on} tone={tone} onClick={() => onToggle(k)} title={SIGNAL_INFO[k] ? `${SIGNAL_INFO[k][0]} (${SIGNAL_INFO[k][1]})` : undefined} className={cn('justify-center', !on && n === 0 && 'opacity-55')}>
              {tone !== 'flat' && <span aria-hidden className="text-[10px]">{tone === 'up' ? '▲' : '▼'}</span>}
              {label}
              {n != null && (
                <span className={cn('ml-0.5 text-[12px] font-medium tabular', on ? 'opacity-70' : 'text-muted-foreground')}>
                  {n}<span className="sr-only">종목</span>
                </span>
              )}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
