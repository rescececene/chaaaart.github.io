// 추천 — 업비트 옆에 두고 보는 예측 한 화면: 비트코인 다음 24시간 · 펌핑 후보 · 오늘 강할 코인 · 주식(국내·미국)
// 숫자 원칙: '시장 이길 확률' 대신 'H 뒤 예상 +X% · 10번 중 8번은 A ~ B'. 예상은 모두 학습에 안 쓴 과거로 검증했고, 실제 결과로 채점한다.
// 검증이 약하면 숨기지 않고 먼저 알린다. 묶음마다 자기 데이터 파일만 읽는다(첫 화면을 가볍게 — 실시간 구독은 화면에 보이는 종목만).
import { memo, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Info, ShieldAlert, ShieldOff, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AiMark, Card, CARD_CLS, Empty, PageTitle } from '@/components/common/Card';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText, signedPct } from '@/components/common/Change';
import { Sparkline } from '@/components/common/Sparkline';
import { AiRange } from '@/components/common/RangeBar';
import { Skeleton } from '@/components/ui/skeleton';
import { ReasonText } from '@/components/chart/ForecastPanel';
import { BtcCard } from '@/components/btc/BtcCard';
import { LiveSurge } from '@/components/pump/LiveSurge';
import { PumpTop } from '@/components/pump/PumpTop';
import { RankTop } from '@/components/picks/RankTop';
import { CautionChips, expDigits, fcWarn, fpct, fpp, toneOf } from '@/components/picks/rank';
import { dayUnit, GradeBadge, topText } from '@/components/picks/score';
import { useQuote, useWant } from '@/hooks/market';
import { tickerOf } from '@/lib/coins';
import { fmtPrice, timeAgo } from '@/lib/format';
import { MARKETS, recommend, remember, type Market, type RecBacktest, type RecGroupKey, type RecItem, type RecStats } from '@/lib/market';
import { href } from '@/lib/router';

/** 주식 묶음 — 코인은 위의 '오늘 강할 코인'(rank_top.json)이 맡는다 */
const STOCK_GROUPS: { key: RecGroupKey; label: string; markets: Market[] }[] = [
  { key: 'krx', label: '국내주식', markets: ['krx'] },
  { key: 'us', label: '미국주식', markets: ['us'] },
];
/** notes 의 시장 이름 머리 ('국내: …') */
const NOTE_NAME: Record<Market, string> = { upbit: '업비트', binance: '바이낸스', krx: '국내', us: '미국' };
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (iso: string | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(+d) ? `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
};
/** 분수 → '+0.34%p' (U+2212) */
const pp = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '–' : signedPct(x * 100, d) + 'p');
const pct = (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? '–' : signedPct(x * 100, d));
const pct0 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
const DIR = (x: number | null | undefined) => (x == null ? '' : x > 0 ? 'text-up-text' : x < 0 ? 'text-down-text' : '');
/** 보유 기간 이름 → '24시간 뒤' · '20거래일 뒤' · '다음 거래일 마감' */
const horizon = (label: string | undefined) => (!label ? '' : label === '다음 거래일' ? '다음 거래일 마감' : `${label} 뒤`);

/** 시장 전체 20일 수익률 — 위험 문장에서 꺼낸다 ('시장 전체 20일 수익률 -15.3% — 하락 국면…') */
function downRegime(items: RecItem[]): number | null {
  for (const it of items) for (const r of it.risks) {
    const m = r.match(/시장 전체 20일 수익률\s*([-−+]?\d+(?:\.\d+)?)%/);
    if (m && /하락 국면/.test(r)) return parseFloat(m[1].replace('−', '-')) / 100;
  }
  return null;
}
/** 시장별 '추천하지 않아요' 설명 (notes 중 '국내: …') — 시장 이름 머리는 뗀다 */
function skipNote(notes: string[], m: Market): string | null {
  const head = `${NOTE_NAME[m]}:`;
  const n = notes.find((x) => x.startsWith(head) && /추천하지 않아요/.test(x));
  return n ? n.slice(head.length).trim() : null;
}

/** 근거 한 줄 — + 는 점수를 올린 쪽(빨강), − 는 내린 쪽(파랑), · 는 방향 없음 */
function Reason({ text, tone }: { text: string; tone: 'up' | 'down' | 'flat' }) {
  const g = tone === 'up' ? { c: '+', cls: 'text-up-text', sr: '유리한 근거: ' } : tone === 'down' ? { c: '−', cls: 'text-down-text', sr: '불리한 근거: ' } : { c: '·', cls: 'text-muted-foreground', sr: '' };
  return (
    <li className="flex gap-2 py-[3px] text-[13.5px] leading-5 text-secondary-foreground">
      <span aria-hidden className={cn('w-2.5 shrink-0 text-center text-[15px] leading-5 font-bold', g.cls)}>{g.c}</span>
      <span className="min-w-0 break-keep"><span className="sr-only">{g.sr}</span><ReasonText text={text} /></span>
    </li>
  );
}

const LowTag = ({ className }: { className?: string }) => (
  <span title="과거로 되돌려 보니 '0%'라고 하는 것보다 잘 맞지 않았어요"
    className={cn('inline-flex h-[20px] shrink-0 items-center rounded-[5px] bg-secondary px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-muted-foreground', className)}>
    참고 낮음
  </span>
);

const RecCard = memo(function RecCard({ it }: { it: RecItem }) {
  const q = useQuote(it.sym);
  const price = q?.price ?? it.price;
  const er = it.expRet;
  const poor = er?.grade === 'poor';
  const unit = it.expEx.unit || dayUnit(it.market);
  // 첫 이유('과거 같은 점수 구간 종목의 59%가…')는 위 숫자와 같은 말이라 빼고, 지표 근거 2~3줄
  const reasons = it.reasons.filter((r) => !r.text.startsWith('과거 같은 점수 구간')).slice(0, 3);
  const risk = it.risks.find((r) => !/하락 국면/.test(r)) ?? it.risks[0];
  const top = topText(it.pctRank);
  return (
    <a href={href('chart', it.sym, '1d')} className={cn(CARD_CLS, 'press group flex min-w-0 flex-col px-4 pt-5 pb-4 transition-colors hover:bg-hover sm:p-5 sm:pb-4')}>
      <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-2.5">
        <SymbolLogo sym={it.sym} size={40} />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-[16px] leading-[22px] font-bold">{it.name}</b>
          <span className="truncate text-[13px] text-muted-foreground">{tickerOf(it.market, it.sub)} · {MARKETS[it.market].name}</span>
        </div>
        <div className="flex flex-col items-end">
          <b className="text-[16px] leading-[22px] font-bold tabular">{fmtPrice(price, it.market)}</b>
          <ChangeText value={q?.chg} className="text-[13px] font-semibold" />
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        {er ? (
          <div className="min-w-0">
            <div className="text-[13px] text-muted-foreground">{horizon(er.label)} 예상</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <b className={cn('text-[26px] leading-8 font-bold tracking-[-0.02em] tabular', poor ? 'text-muted-foreground' : toneOf(er.mid, expDigits(er.mid)))}>{fpct(er.mid, expDigits(er.mid))}</b>
              {poor ? <LowTag /> : null}
            </div>
            <div className="text-[12.5px] text-muted-foreground tabular">
              {top ? <>{top}</> : null}
              {er.edge != null ? <>{top ? ' · ' : ''}다른 종목보다 <span className={cn('font-semibold', poor ? '' : toneOf(er.edge, 2))}>{fpp(er.edge)}</span></> : null}
            </div>
          </div>
        ) : (
          // 엔진이 새 형식으로 다시 돌기 전(배포 직후)에는 예전 숫자
          <div className="min-w-0">
            <div className="text-[13px] text-muted-foreground" title={`${it.expEx.h}${unit} 동안 같은 시장 종목들의 중앙값보다 더 오를 확률 — 가격이 오를 확률이 아니에요`}>시장 이길 확률</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <b className="text-[26px] leading-8 font-bold tracking-[-0.02em] tabular">{Math.round(it.probBeat * 100)}%</b>
              <GradeBadge grade={it.grade} label={it.gradeLabel} />
            </div>
            {top ? <div className="text-[12.5px] text-muted-foreground tabular">{top} · {it.expEx.h}{unit} 기준</div> : null}
          </div>
        )}
        <Sparkline data={it.spark} width={96} height={40} area={false} className="shrink-0" />
      </div>

      {er ? (
        <AiRange className="mt-3.5" q10={er.lo} q50={er.mid} q90={er.hi} label={<span>{horizon(er.label)} 가격 변화 (10번 중 8번)</span>} />
      ) : (
        <AiRange className="mt-3.5" q10={it.expEx.q10} q50={it.expEx.q50} q90={it.expEx.q90}
          label={<span title={`과거 같은 점수 구간 ${it.expEx.n.toLocaleString('ko-KR')}건의 시장 대비 초과수익 (10~90%)`}>{it.expEx.h}{unit} 동안 시장 대비 예상 (10번 중 8번)</span>} />
      )}

      <CautionChips cau={it.cautions} className="mt-2.5" />
      {reasons.length > 0 && <ul className="mt-2.5">{reasons.map((r, i) => <Reason key={i} text={r.text} tone={r.tone} />)}</ul>}

      {risk ? (
        <p className="mt-2 flex gap-2 text-[13px] leading-5 text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="min-w-0 break-keep"><span className="sr-only">위험: </span><ReasonText text={risk} /></span>
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3.5">
        {it.stop != null ? (
          <span className="min-w-0 truncate rounded-lg bg-tile px-2.5 py-1.5 text-[12.5px] text-muted-foreground" title="하루 평균 변동폭(ATR)과 최근 저점으로 잡은 참고 가격이에요">
            손절 참고가 <b className="font-semibold text-secondary-foreground tabular">{fmtPrice(it.stop, it.market)}</b>
            {it.stopPct != null ? <span className="tabular"> ({pct(it.stopPct, 1)})</span> : null}
          </span>
        ) : <span />}
        <span className="inline-flex shrink-0 items-center text-[13.5px] font-semibold text-muted-foreground group-hover:text-foreground">차트 보기<ChevronRight aria-hidden className="size-4" /></span>
      </div>
    </a>
  );
});

/** 규칙 성적 표 한 줄 — 값 아래 회색으로 같은 기간 시장 값 */
function StatRow({ label, all, hold, fmt, tone, mAll, mHold }: {
  label: string; all: number | undefined; hold: number | undefined; fmt: (x: number | undefined) => string; tone?: boolean; mAll?: number; mHold?: number;
}) {
  const cell = (v: number | undefined, mv: number | undefined) => (
    <>
      <span className={cn(tone && DIR(v))}>{fmt(v)}</span>
      {mv !== undefined ? <span className="block text-[11.5px] font-normal text-muted-foreground">시장 {fmt(mv)}</span> : null}
    </>
  );
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">{label}</th>
      <td className="py-2 text-right font-semibold tabular">{cell(all, mAll)}</td>
      <td className="py-2 pl-3 text-right font-semibold tabular">{cell(hold, mHold)}</td>
    </tr>
  );
}

function RuleRecord({ m, bt, excluded }: { m: Market; bt: RecBacktest; excluded?: { sym: string; why: string }[] }) {
  const unit = dayUnit(m), a = bt.all, h = bt.hold;
  const beat = (s: RecStats | null) => !!s && (s.exAfterCost ?? s.ex) > 0;
  const ok = beat(a) && beat(h);
  const x = (s: number) => `${s.toFixed(2)}배`;
  return (
    <div className="rounded-[14px] bg-tile p-3.5 text-[13px] leading-[1.55] sm:p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="text-[14.5px] font-bold">{MARKETS[m].name}</b>
        <span className="text-muted-foreground tabular">{bt.h}{unit} 보유 · {bt.from} ~ {bt.to} · {a.periods.toLocaleString('ko-KR')}회</span>
        <span className={cn('ml-auto inline-flex h-[22px] items-center rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap', ok ? 'bg-up-soft text-up-text' : 'bg-secondary text-muted-foreground')}>
          {ok ? '비용 빼고도 시장보다 나았어요' : '시장을 못 이겼어요'}
        </span>
      </div>
      {bt.desc ? <p className="mt-1 break-keep text-muted-foreground">규칙: {bt.desc}</p> : null}
      <table className="mt-2 w-full text-[13px]">
        <thead>
          <tr className="text-[12px] text-muted-foreground">
            <th className="pb-1 text-left font-normal"><span className="sr-only">항목</span></th>
            <th className="pb-1 text-right font-normal">전체</th>
            <th className="pb-1 pl-3 text-right font-normal">최근 보류 구간<span className="block tabular">{bt.holdFrom} ~</span></th>
          </tr>
        </thead>
        <tbody>
          <StatRow label="회당 초과수익" all={a.ex} hold={h?.ex} fmt={(v) => pp(v)} tone />
          <StatRow label="왕복 비용 뺀 뒤" all={a.exAfterCost} hold={h?.exAfterCost} fmt={(v) => pp(v)} tone />
          <StatRow label="시장을 이긴 회차" all={a.win} hold={h?.win} fmt={(v) => pct0(v)} />
          <StatRow label="최대 낙폭" all={a.mdd} hold={h?.mdd} mAll={a.uniMdd} mHold={h?.uniMdd} fmt={(v) => pct(v)} />
          <StatRow label="누적" all={a.growth} hold={h?.growth} mAll={a.uniGrowth} mHold={h?.uniGrowth} fmt={(v) => (v == null ? '–' : x(v))} />
        </tbody>
      </table>
      {a.downEx != null && a.upEx != null ? (
        <p className="mt-2 break-keep text-muted-foreground">
          시장이 내린 구간 회당 <b className={cn('font-semibold tabular', DIR(a.downEx))}>{pp(a.downEx)}</b> · 오른 구간 <b className={cn('font-semibold tabular', DIR(a.upEx))}>{pp(a.upEx)}</b>
        </p>
      ) : null}
      {excluded?.length ? (
        <p className="mt-2 break-keep text-muted-foreground">
          이번에 점수는 높았지만 뺀 종목: {excluded.slice(0, 6).map((e) => `${e.sym.split(':')[1].replace(/^KRW-/, '')}(${e.why})`).join(', ')}{excluded.length > 6 ? ` 외 ${excluded.length - 6}개` : ''}
        </p>
      ) : null}
    </div>
  );
}

function GroupSection({ g, items, notes, bts, excluded }: {
  g: (typeof STOCK_GROUPS)[number]; items: RecItem[]; notes: string[];
  bts: Partial<Record<Market, RecBacktest>>; excluded?: Partial<Record<Market, { sym: string; why: string }[]>>;
}) {
  const mkts = g.markets.filter((m) => bts[m]);
  const used = new Set(items.map((it) => it.market));
  const skipped = g.markets.flatMap((m) => { const n = !used.has(m) ? skipNote(notes, m) : null; return n ? [{ m, n }] : []; });
  const down = downRegime(items);
  const downEx = items[0] ? bts[items[0].market]?.all.downEx : undefined;
  const er = items.find((it) => it.expRet)?.expRet;
  const h = items[0]?.expEx;
  const warn = er ? fcWarn(er.grade, er.label) : null;
  return (
    <section aria-labelledby={`rec-${g.key}`} className="space-y-2 sm:space-y-3">
      <div className="mx-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 sm:mx-1">
        <h2 id={`rec-${g.key}`} className="text-[20px] font-bold tracking-[-0.02em]">{g.label}</h2>
        <span className="text-[13.5px] text-muted-foreground tabular">
          {items.length
            ? `${items.length}개 · ${er ? `${horizon(er.label)} 예상` : h ? `${h.h}${h.unit} 보유 기준` : ''}`
            : '이번엔 없어요'}
        </span>
      </div>

      {warn ? (
        <p className="mx-4 flex gap-1.5 text-[12.5px] leading-[1.55] break-keep text-secondary-foreground sm:mx-1">
          <ShieldAlert aria-hidden className="mt-[3px] size-3.5 shrink-0 text-warn" />{warn}
        </p>
      ) : null}

      {down != null && (
        <div role="note" className={cn(CARD_CLS, 'flex gap-3 border-l-4 border-warn px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <p className="break-keep text-secondary-foreground">
            <b className="font-bold text-foreground">하락 국면이에요.</b> 시장 전체가 최근 20일 <b className="font-semibold text-down-text tabular">{signedPct(down * 100, 1)}</b> 움직였어요.
            고른 종목이 시장보다 나아도 손실일 수 있어요{downEx != null ? <> — 과거 시장이 내린 구간에서 이 규칙은 회당 <b className={cn('font-semibold tabular', DIR(downEx))}>{pp(downEx)}</b>였어요</> : null}.
          </p>
        </div>
      )}

      {items.length ? (
        <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4">
          {items.map((it) => <RecCard key={it.sym} it={it} />)}
        </div>
      ) : (
        // 비었을 땐 한 줄로 — 큰 빈 상자가 화면을 차지하지 않게
        <div className={cn(CARD_CLS, 'flex gap-3 px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
          <ShieldOff aria-hidden className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" />
          <div className="min-w-0 break-keep">
            <b className="font-semibold">이번엔 고르지 않았어요.</b>{' '}
            <span className="text-muted-foreground">과거 검증에서 이 규칙이 시장을 못 이겨서 비워 뒀어요. 억지로 채우지 않았어요.</span>
            {skipped.map(({ m, n }) => <p key={m} className="mt-1 text-[12.5px] text-muted-foreground">{n}</p>)}
          </div>
        </div>
      )}
      {items.length > 0 && skipped.length > 0 && (
        <p className="mx-4 flex gap-1.5 text-[12.5px] leading-[1.55] break-keep text-muted-foreground sm:mx-1">
          <Info aria-hidden className="mt-[3px] size-3.5 shrink-0" />
          <span>{skipped.map(({ m, n }) => <span key={m}><b className="font-semibold">{MARKETS[m].name}</b>는 넣지 않았어요 — {n} </span>)}</span>
        </p>
      )}

      {mkts.length > 0 && (
        <details className={cn(CARD_CLS, 'group px-4 py-1 sm:px-5')}>
          <summary className="press flex h-12 cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
            이 규칙의 과거 성적
            <span className="inline-flex items-center gap-1 text-[13px] font-normal text-muted-foreground">
              {mkts.map((m) => MARKETS[m].name).join('·')}<ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="space-y-2 pb-4">
            <p className="text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
              학습에 안 쓴 날짜마다 같은 규칙으로 최대 5개를 골라 정해진 기간 들고 있었다면, 같은 시장 평균보다 얼마나 나았는지예요. ‘최근 보류 구간’은 규칙을 정할 때 보지 않고 남겨 둔 최근 기간이에요.
            </p>
            {mkts.map((m) => <RuleRecord key={m} m={m} bt={bts[m]!} excluded={used.has(m) ? excluded?.[m] : undefined} />)}
          </div>
        </details>
      )}
    </section>
  );
}

export default function RecommendPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['recommend'], queryFn: recommend, staleTime: 4 * 60e3, refetchInterval: 5 * 60e3, retry: 1,
  });
  const stocks = useMemo(() => STOCK_GROUPS.flatMap((g) => data?.groups?.[g.key]?.items?.slice(0, 5) ?? []), [data]);
  const syms = useMemo(() => stocks.map((it) => it.sym), [stocks]);
  useEffect(() => { stocks.forEach((it) => remember(it.sym, { name: it.name, sub: it.sub })); }, [stocks]);
  useWant(syms);
  useEffect(() => { document.title = '추천 — 마켓'; return () => { document.title = '마켓'; }; }, []);
  const updated = data ? Date.parse(data.updatedAt) : NaN;
  const late = Number.isFinite(updated) && Date.now() - updated > 3 * 60 * 60e3;
  // 일반 안내(시장 이름으로 시작하지 않는 notes) — 맨 아래 '어떻게 만들었나요'
  const general = (data?.notes ?? []).filter((n) => !Object.values(NOTE_NAME).some((x) => n.startsWith(x)) && !/시장 이길 확률/.test(n));

  return (
    <div>
      <PageTitle sub={<span className="break-keep">업비트 옆에 두고 보는 예측이에요. 예측 숫자는 지난 데이터로 검증했고, 가격·채점은 실시간이에요.</span>}>
        추천<AiMark big />
      </PageTitle>

      <div className="space-y-2 sm:space-y-3 lg:space-y-4">
        <BtcCard />
        <div className="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          <div className="space-y-2 sm:space-y-3 lg:space-y-4">
            <LiveSurge />
            <PumpTop />
          </div>
          <RankTop />
        </div>
      </div>

      <div className="mt-7 space-y-7 sm:mt-8 sm:space-y-8">
        {isLoading && (
          <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-80 rounded-[20px] bg-card max-sm:rounded-none" />)}
          </div>
        )}
        {!isLoading && (isError || !data) && (
          <Card><Empty icon={<ShieldOff />} title="주식 목록을 준비하고 있어요">자동 수집이 돌면 채워져요. 잠시 뒤 다시 확인해 주세요.</Empty></Card>
        )}
        {data && STOCK_GROUPS.map((g) => (
          <GroupSection key={g.key} g={g} items={data.groups?.[g.key]?.items?.slice(0, 5) ?? []} notes={data.notes ?? []} bts={data.backtest ?? {}} excluded={data.excluded} />
        ))}

        <details className={cn(CARD_CLS, 'group px-4 py-1 sm:px-5')}>
          <summary className="press flex h-12 cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
            숫자 읽는 법 · 어떻게 만들었나요<ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <ul className="list-disc space-y-1.5 pb-4 pl-5 text-[13px] leading-[1.6] break-keep text-muted-foreground">
            <li><b className="font-semibold text-secondary-foreground">예상 %</b>는 그 시간이 지난 뒤 가격이 지금(기준가)보다 몇 % 달라질지의 가운데 값이에요. <b className="font-semibold text-secondary-foreground">‘10번 중 8번은’</b>은 실제 결과가 들어올 범위예요.</li>
            <li>코인 하루 방향은 누구도 잘 맞히지 못해요. 그래서 정직하게 계산하면 예상 % 가 0% 근처일 때가 많아요 — 그럴 땐 범위(얼마나 흔들릴지)와 ‘다른 종목보다 나을 몫’을 보세요.</li>
            <li>모든 예상은 학습에 쓰지 않은 과거 날짜로 되짚어 검증했고, 배포한 뒤부터는 실제 결과로 채점해요. 되짚어 본 성적과 실제 기록은 따로 보여 줘요.</li>
            <li>자동 수집은 보통 1시간 안쪽마다 다시 계산해요(GitHub 사정에 따라 늦어질 수 있어요). 가격은 화면에서 실시간으로 바뀌어요.</li>
            {general.map((n, i) => <li key={i}>{n}</li>)}
            <li>전체 순위는 <a href={href('picks')} className="font-semibold text-foreground underline-offset-2 hover:underline">전체 순위</a>, 펌핑 후보 전체는 <a href={href('pump')} className="font-semibold text-foreground underline-offset-2 hover:underline">펌핑 후보</a>에서 볼 수 있어요.</li>
            <li>지난 데이터로 만든 참고 자료예요. <b className="font-semibold text-secondary-foreground">투자 권유가 아니에요.</b></li>
          </ul>
        </details>
        <p className="mx-4 text-[12px] text-muted-foreground tabular sm:mx-1">
          {data ? <>주식 {stamp(data.updatedAt)} 기준{late ? <span className="text-warn"> · 업데이트가 늦어지고 있어요</span> : null} · </> : null}
          {dataUpdatedAt ? `${timeAgo(dataUpdatedAt)} 받아 옴` : ''}
        </p>
      </div>
    </div>
  );
}
