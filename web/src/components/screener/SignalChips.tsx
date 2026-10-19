// 조건 칩 15개 — 세 묶음(오를 때 나오는 신호 · 내릴 때 나오는 신호 · 그 밖). PC 는 왼쪽 이름 + 칩 줄바꿈, 휴대폰은 이름 아래 한 줄로 옆으로 밀기
import { cn } from '@/lib/utils';
import { Chip } from '@/components/common/Segmented';
import { SIGNAL_INFO, SIGNALS } from '@/lib/indicators';
import { CHIP_GRID } from './model';

/** 고른 조건의 뜻 — 회색 칸 안에 한 줄씩 (안 골랐으면 안내 한 줄) */
export function SignalHelp({ selected, onClear }: { selected: string[]; onClear?: () => void }) {
  return (
    <div className="mt-3 rounded-xl bg-tile px-3.5 py-3 text-[14px] leading-[21px] text-secondary-foreground">
      {!selected.length ? (
        <p>
          조건을 누르면 뜻이 여기에 나와요. 여러 개 고르면 모두 맞는 종목만 보여요.
          <span className="hidden sm:inline"> 예) <b className="font-bold text-foreground">낙폭 과대</b> — 짧은 기간에 너무 많이 떨어져 반등할 수 있어요 <span className="text-muted-foreground">(RSI 30 이하)</span></span>
        </p>
      ) : (
        <div className="flex items-start gap-3">
          <ul className="min-w-0 flex-1 space-y-1">
            {selected.map((k) => {
              const info = SIGNAL_INFO[k];
              if (!info) return null;
              return (
                <li key={k}>
                  <b className="font-bold text-foreground">{SIGNALS[k]?.[0]}</b> — {info[0]} <span className="text-muted-foreground">({info[1]})</span>
                </li>
              );
            })}
          </ul>
          {onClear && (
            <button type="button" onClick={onClear} className="press -my-1 -mr-1.5 shrink-0 rounded-lg px-1.5 py-1 text-[13px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground">
              선택 해제
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const GROUPS: { tone: 'up' | 'down' | 'flat'; label: string }[] = [
  { tone: 'up', label: '오를 때 나오는 신호' },
  { tone: 'down', label: '내릴 때 나오는 신호' },
  { tone: 'flat', label: '그 밖' },
];
const ORDER = CHIP_GRID.filter((k): k is string => !!k);

export function SignalChips({ selected, counts, onToggle }: {
  selected: string[]; counts: Record<string, number> | null; onToggle: (k: string) => void;
}) {
  return (
    <div role="group" aria-label="조건 고르기" className="mt-4 grid gap-3 md:mt-[18px] md:gap-2.5">
      {GROUPS.map((g) => {
        const keys = ORDER.filter((k) => SIGNALS[k]?.[1] === g.tone);
        if (!keys.length) return null;
        return (
          <div key={g.tone} className="grid min-w-0 gap-1.5 md:grid-cols-[132px_minmax(0,1fr)] md:items-start md:gap-2">
            <p className="text-[13px] font-semibold whitespace-nowrap text-text-3 md:pt-[7px] md:text-[13.5px]">{g.label}</p>
            {/* 휴대폰: 한 줄로 옆으로 밀기 (오른쪽 흐림) · relative: 안쪽 sr-only 글자가 스크롤 상자 밖으로 새어 페이지를 넓히지 않게 */}
            <div className="no-scrollbar relative -mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 [mask-image:linear-gradient(90deg,#000_88%,transparent)] sm:-mx-5 sm:px-5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:[mask-image:none]">
              {keys.map((k) => {
                const label = SIGNALS[k][0];
                const on = selected.includes(k);
                const n = counts ? counts[k] || 0 : null;
                return (
                  <Chip key={k} on={on} tone={g.tone} disabled={n === 0} onClick={() => onToggle(k)} className="gap-[5px] pr-3"
                    title={SIGNAL_INFO[k] ? `${SIGNAL_INFO[k][0]} (${SIGNAL_INFO[k][1]})` : undefined}>
                    {label}
                    {n != null && (
                      <span className={cn('relative text-[13px] font-semibold tabular', on ? 'text-current' : n === 0 ? 'text-faint' : 'text-muted-foreground')}>
                        {n}<span className="sr-only">종목</span>
                      </span>
                    )}
                  </Chip>
                );
              })}
              <span className="w-4 shrink-0 md:hidden" aria-hidden />
            </div>
          </div>
        );
      })}
    </div>
  );
}
