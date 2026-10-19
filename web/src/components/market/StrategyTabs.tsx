// 시장 목록 '전략' — 칩 줄(지금 걸린 종목 수) + 고른 전략의 머리(설명 · 과거 성적 한 줄 · 펼치면 숫자)
// 과거 성적은 '이 탭을 믿어도 되나'가 먼저 보이게: 판정 문장 한 줄, 숫자는 펼침(넓은 화면은 마우스를 올려도)
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BadgeCheck, ChevronDown, CircleHelp, CircleMinus, Hourglass, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Chip } from '@/components/common/Segmented';
import { timeAgo } from '@/lib/format';
import { MARKETS, type Market, type SetupHorizon, type SetupStat, type SetupsStats } from '@/lib/market';
import { popThreshold, signedP, statsMeta, verdictOf, type SetupDef, type Tone } from './strategy';

/** 과거 검증에서 효과가 뚜렷했던 전략 (경고 전략이면 '경고가 맞았던') */
const verified = (st: SetupStat | undefined) => st?.grade === 'good' && !st.opp;

export function StrategyChips({ defs, counts, stats, value, onChange }: {
  defs: SetupDef[];
  /** 전략별 지금 걸린 종목 수 — 아직 모르면 null (숫자를 감춘다) */
  counts: Map<string, number> | null;
  /** 이 시장의 과거 성적 (없으면 표시 없음) */
  stats: Record<string, SetupStat> | undefined;
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  const firstWarn = defs.findIndex((d) => d.dir < 0);
  // 고른 칩이 옆으로 밀려 안 보이면 그 줄만 옆으로 굴려 보여 준다 (주소로 들어왔을 때 · 휴대폰)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const chip = value ? el?.querySelector<HTMLElement>('button[aria-pressed="true"]') : null;
    if (!el || !chip || el.scrollWidth <= el.clientWidth) return;
    const l = chip.offsetLeft, r = l + chip.offsetWidth; // offsetParent = 이 상자(relative)
    if (l < el.scrollLeft || r > el.scrollLeft + el.clientWidth - 24) el.scrollTo({ left: Math.max(0, l - 48) });
    // 숫자·검증 표시가 늦게 붙으면 칩 폭이 바뀌므로 그때 한 번 더
  }, [value, !!counts, !!stats]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // 휴대폰: 한 줄로 옆으로 밀린다 — 오른쪽 끝을 흐리게 해서 더 있다는 걸 보여 준다 (정렬 칩 줄과 같은 규칙)
    // 태블릿·PC: 마우스로는 옆으로 밀기 어려우니 줄을 바꿔 다 보여 준다 ('전략' 글자 오른쪽에서)
    // relative: 칩 속 sr-only(절대 위치) 글자가 스크롤 상자 밖으로 새어 문서 폭을 늘리지 않게
    <div ref={box} role="group" aria-label="차트 전략"
      className="no-scrollbar relative -my-1 mt-2 flex min-w-0 items-center gap-2 py-1 max-md:-mr-4 max-md:overflow-x-auto max-md:pr-6 max-md:[mask-image:linear-gradient(to_right,black_85%,transparent)] md:items-start">
      <span className="mr-0.5 shrink-0 text-[13px] font-semibold text-muted-foreground md:mt-[8px]">전략</span>
      <div className="contents md:flex md:min-w-0 md:flex-1 md:flex-wrap md:items-center md:gap-2">
      {defs.map((d, i) => {
        const on = value === d.key;
        const n = counts ? counts.get(d.key) ?? 0 : null;
        const ok = verified(stats?.[d.key]);
        return (
          <span key={d.key} className="contents">
            {/* 경고 전략은 뒤쪽에 따로 — 색이 아니라 글자(주의·경고)와 칸막이로 나눈다 */}
            {i === firstWarn && i > 0 && <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />}
            <Chip on={on} onClick={() => onChange(on ? null : d.key)} title={d.desc} className="gap-1 pl-3">
              <span aria-hidden className="text-[15px] leading-none">{d.emoji}</span>
              {d.name}
              {ok && <BadgeCheck aria-label="과거 검증에서 효과가 뚜렷했어요" className={cn('size-[15px] shrink-0', on ? 'text-current' : 'text-good')} strokeWidth={2.2} />}
              {n != null && (
                <span className={cn('ml-0.5 text-[13px] font-semibold tabular', on ? 'text-current opacity-75' : n ? 'text-muted-foreground' : 'text-faint')}>
                  {n}<span className="sr-only">종목</span>
                </span>
              )}
            </Chip>
          </span>
        );
      })}
      </div>
    </div>
  );
}

const TONE: Record<Tone, { icon: typeof ShieldCheck; cls: string }> = {
  good: { icon: ShieldCheck, cls: 'text-good' },
  weak: { icon: CircleHelp, cls: 'text-muted-foreground' },
  none: { icon: CircleMinus, cls: 'text-muted-foreground' },
  opp: { icon: TriangleAlert, cls: 'text-warn' },
  pending: { icon: Hourglass, cls: 'text-muted-foreground' },
};

const dirCls = (x: number) => (Math.round(x * 10) > 0 ? 'text-up-text' : Math.round(x * 10) < 0 ? 'text-down-text' : 'text-foreground');
const pct = (x: number) => `${Math.round(x)}%`;
const ym = (s: string) => s.slice(0, 7).replace('-', '.');

function Row({ label, sub, h5, h20, cell }: {
  label: ReactNode; sub?: ReactNode; h5?: SetupHorizon; h20?: SetupHorizon; cell: (h: SetupHorizon) => ReactNode;
}) {
  return (
    <tr className="border-t border-border/70 align-top">
      <th scope="row" className="py-[7px] pr-2 text-left font-medium text-muted-foreground">
        {label}
        {sub && <span className="block text-[11.5px] leading-4 font-normal">{sub}</span>}
      </th>
      {[h5, h20].map((h, i) => (
        <td key={i} className="py-[7px] pl-2 text-right whitespace-nowrap">{h && h.n > 0 ? cell(h) : <span className="text-muted-foreground">–</span>}</td>
      ))}
    </tr>
  );
}

/** 마우스를 올리면 보일 숫자 요약 (펼치지 않아도) */
function tipOf(stat: SetupStat | undefined, unit: string): string | undefined {
  if (!stat) return undefined;
  const one = (h: SetupHorizon | undefined, d: number) => (h && h.n > 0
    ? `${d}${unit}: 시장 대비 ${signedP(h.avgEx)}%p${h.ci ? ` (95% 범위 ${signedP(h.ci[0])}~${signedP(h.ci[1])})` : ''}, 시장보다 더 오른 비율 ${pct(h.win)}, 표본 ${h.n.toLocaleString('ko-KR')}번`
    : null);
  return [one(stat.h5, 5), one(stat.h20, 20)].filter(Boolean).join('\n') || undefined;
}

/** 고른 전략의 머리 — 이름·설명, 과거 성적 한 줄(판정), 펼치면 5·20봉 뒤 시장 대비 수익·오른 비율·표본 */
export function StrategyBox({ def, stat, stats, market, count, updatedAt }: {
  def: SetupDef;
  /** 이 시장의 이 전략 과거 성적 (없으면 '아직 검증 전') */
  stat: SetupStat | undefined;
  stats: SetupsStats | null | undefined;
  market: Market;
  /** 지금 걸린 종목 수 (모르면 null) */
  count: number | null;
  /** 판정 시각 (스크리너 파일) */
  updatedAt: number | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const stock = !MARKETS[market].coin;
  const v = verdictOf(stat, def.dir, stock);
  const { icon: Icon, cls } = TONE[v.tone];
  const unit = stock ? '거래일' : '일';
  const pop = popThreshold(stats, stock);
  const meta = statsMeta(stats, market);
  const showNums = !!stat && ((stat.h5?.n ?? 0) > 0 || (stat.h20?.n ?? 0) > 0);
  const method = stats?.method;

  return (
    <section data-strategy-box aria-label={`${def.name} 전략`} className="mt-3 rounded-2xl bg-tile px-4 pt-3.5 pb-3 md:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 text-[16px] font-bold tracking-[-0.01em]">
          <span aria-hidden className="mr-1">{def.emoji}</span>{def.name}
        </h3>
        {count != null && <span className="shrink-0 text-[13px] text-muted-foreground tabular">지금 <b className="font-semibold text-foreground">{count}</b>종목</span>}
      </div>
      <p className="mt-0.5 text-[13px] leading-[1.5] break-keep text-muted-foreground">{def.desc}</p>

      {/* 과거 성적 한 줄 — 아이콘 모양·색·문장으로 함께 말한다 (숫자는 펼침 · 넓은 화면은 마우스를 올려도) */}
      <div className="mt-2.5 flex items-start gap-2 border-t border-border/70 pt-2.5">
        <Icon aria-hidden className={cn('mt-[2px] size-[18px] shrink-0', cls)} strokeWidth={2.1} />
        <p className="min-w-0 flex-1 text-[14px] leading-[1.5] break-keep" title={tipOf(stat, unit)}>
          <span className="mr-1.5 text-[13px] font-semibold text-muted-foreground">과거 성적</span>
          <b className="font-bold">{v.title}</b>
          {v.nums && <span className="text-text-3"> · {v.nums}</span>}
        </p>
        {showNums && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId}
            className="press -my-1 -mr-1.5 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[13px] font-semibold text-text-3 hover:bg-hover">
            {open ? '접기' : '자세히'}<ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>

      {open && showNums && stat && (
        <div id={panelId} className="mt-2 md:pl-[26px]">
          <p className="text-[13px] leading-[1.55] break-keep text-text-3">{v.detail}</p>
          <table className="mt-2 w-full text-[13px] tabular md:max-w-[420px]">
            <caption className="sr-only">과거 신호 뒤 성적 (같은 날 시장 평균과 비교)</caption>
            <thead>
              <tr className="text-[12px] text-muted-foreground">
                <th scope="col" className="pb-1 text-left font-medium">과거 신호 뒤</th>
                <th scope="col" className="pb-1 pl-2 text-right font-medium">5{unit}</th>
                <th scope="col" className="pb-1 pl-2 text-right font-medium">20{unit}</th>
              </tr>
            </thead>
            <tbody>
              <Row label="시장 대비 수익" sub="평균 · 95% 범위" h5={stat.h5} h20={stat.h20} cell={(h) => (
                <>
                  <b className={cn('font-semibold', dirCls(h.avgEx))}>{signedP(h.avgEx)}%p</b>
                  {h.ci && <span className="block text-[11.5px] leading-4 text-muted-foreground">{signedP(h.ci[0])} ~ {signedP(h.ci[1])}</span>}
                </>
              )} />
              <Row label="시장보다 더 오른 비율" sub="그냥 고르면 50%" h5={stat.h5} h20={stat.h20} cell={(h) => <>{pct(h.win)}</>} />
              <Row label="실제로 오른 비율" h5={stat.h5} h20={stat.h20} cell={(h) => (
                <>{pct(h.up)}<span className="text-muted-foreground"> · 시장 {pct(h.mktUp)}</span></>
              )} />
              {def.dir > 0 && (
                <Row label="크게 치솟음" sub={`고가 +${pop.h5}% · +${pop.h20}% 넘게`} h5={stat.h5} h20={stat.h20} cell={(h) => (
                  <>{pct(h.pop)}<span className="text-muted-foreground"> · 시장 {pct(h.popMkt)}</span></>
                )} />
              )}
              <Row label="표본" h5={stat.h5} h20={stat.h20} cell={(h) => <>{h.n.toLocaleString('ko-KR')}번</>} />
            </tbody>
          </table>
          {(meta || method) && (
            <p className="mt-2 text-[12px] leading-[1.6] break-keep text-muted-foreground">
              {meta && <>{ym(meta.from)}~{ym(meta.to)} {MARKETS[market].name}{meta.symbols ? ` ${meta.symbols}종목` : ''} 일봉으로 검증했어요. </>}
              {method}
            </p>
          )}
        </div>
      )}

      <p className="mt-2.5 text-[12px] leading-[1.6] break-keep text-muted-foreground">
        일봉 기준으로 10분마다 다시 판정해요{updatedAt ? ` (${timeAgo(updatedAt)})` : ''}. 과거 통계일 뿐 앞으로도 그렇다는 보장은 없고, 투자 권유가 아니에요.
      </p>
    </section>
  );
}
