// 이 자리에서 사면 — 단기·중기·장기 (주식 5·20·60 거래일, 코인 7·30·90일)
// 지금과 비슷했던 과거 자리에서 실제로 어땠는지의 분포 (collector/model — predict/sym/*.json 의 outlook)와,
// 그 방식을 과거 시점으로 되돌려 확인한 결과 (predict/summary.json 의 outlookBacktest). 정적 파일만 — 중계 요청 없음.
// 문구는 단정하지 않는다: '이만큼 먹을 수 있다'가 아니라 '과거 비슷한 자리에선 보통 이 범위였어요'.
// 최근 업비트에 새로 상장한 코인이면(news_state.json) 과거 신규 상장 결과를 주의 카드로 먼저 보인다.
import { useQuery } from '@tanstack/react-query';
import { Card, CardTitle } from '@/components/common/Card';
import { signedPct } from '@/components/common/Change';
import { Skeleton } from '@/components/ui/skeleton';
import { ListingCaution, useNewsState } from '@/components/news/Study';
import { coinBase } from '@/lib/coins';
import { MARKETS, predictSummary, predictSymbol, type Market, type OutlookCheck, type OutlookGrade, type OutlookItem, type Sym } from '@/lib/market';
import { isNewUpbitListing, listingStudy } from '@/lib/newsTag';
import { cn } from '@/lib/utils';

const pct = (x: number, d = 1) => signedPct(x * 100, d);
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const DIR = (x: number) => (Math.round(x * 1000) > 0 ? 'text-up-text' : Math.round(x * 1000) < 0 ? 'text-down-text' : 'text-foreground');
/** '2026-10-18' → '10월 18일' */
const dayLabel = (s: string | undefined) => {
  const m = s?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${+m[1]}월 ${+m[2]}일` : '';
};

// 검증 등급 — 과거 시점으로 되돌려 확인했을 때 오를지 내릴지를 아무 날이나 고른 것보다 잘 맞혔는가
const GRADE: Record<OutlookGrade, { text: string; cls: string; title: string }> = {
  good: { text: '검증 통과', cls: 'text-secondary-foreground before:bg-good', title: '과거로 되돌려 확인했을 때 범위와 오른 비율이 잘 맞았어요' },
  weak: { text: '참고 보통', cls: 'text-muted-foreground before:bg-faint', title: '과거로 되돌려 확인했을 때 아무 날이나 고른 것보다 아주 조금 나았어요' },
  poor: { text: '참고 낮음', cls: 'bg-secondary px-1.5 text-muted-foreground', title: '과거로 되돌려 확인했을 때 오를지 내릴지를 아무 날이나 고른 것보다 잘 맞히지 못했어요' },
};
function GradeTag({ grade, className }: { grade: OutlookGrade; className?: string }) {
  const g = GRADE[grade] ?? GRADE.poor;
  return (
    <span title={g.title}
      className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md text-[12.5px] font-bold whitespace-nowrap',
        grade !== 'poor' && 'before:size-1.5 before:rounded-full', g.cls, className)}>
      {g.text}
    </span>
  );
}

/** 세 기간이 함께 쓰는 막대 눈금 — 0 과 모든 10~90% 구간이 들어가게 (기간이 길수록 범위가 넓어지는 게 그대로 보인다) */
type Scale = { lo: number; hi: number };
function scaleOf(items: OutlookItem[]): Scale {
  const xs = items.flatMap((o) => (o.q10 != null && o.q90 != null ? [o.q10, o.q90] : []));
  const lo = Math.min(-0.02, ...xs), hi = Math.max(0.02, ...xs), pad = (hi - lo) * 0.03;
  return { lo: lo - pad, hi: hi + pad };
}

/** 범위 막대 — 10~90% 구간(0 아래는 파랑, 위는 빨강) · 0 눈금 · 중앙값 점. dim: '참고 낮음'이면 회색으로 흐리게 */
function Band({ q10, q50, q90, dim, scale }: { q10: number; q50: number; q90: number; dim: boolean; scale: Scale }) {
  const { lo, hi } = scale, span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  const seg = (a: number, b: number, cls: string) => <span className={cn('absolute inset-y-0', cls)} style={{ left: `${x(a)}%`, width: `${Math.max(0, x(b) - x(a))}%` }} />;
  return (
    <div aria-hidden className="relative mx-1.5 mt-2.5 h-2 rounded-full bg-border">
      {dim ? seg(q10, q90, 'rounded-full bg-[color-mix(in_srgb,var(--muted-foreground)_38%,var(--border))]') : (
        <>
          {q10 < 0 ? seg(q10, Math.min(0, q90), cn('bg-down/45', q90 > 0 ? 'rounded-l-full' : 'rounded-full')) : null}
          {q90 > 0 ? seg(Math.max(0, q10), q90, cn('bg-up/45', q10 < 0 ? 'rounded-r-full' : 'rounded-full')) : null}
        </>
      )}
      <span className="absolute -inset-y-[3px] w-[1.5px] -translate-x-1/2 bg-muted-foreground" style={{ left: `${x(0)}%` }} />
      <span className={cn('absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_var(--card)]', dim ? 'bg-muted-foreground' : 'bg-foreground')}
        style={{ left: `${x(q50)}%` }} />
    </div>
  );
}

function OutlookRow({ o, unit, scale }: { o: OutlookItem; unit: string; scale: Scale }) {
  const ok = o.q10 != null && o.q50 != null && o.q90 != null;
  const dim = o.grade === 'poor';
  // '참고 낮음'은 방향 색 없이 회색 글자로 (회색도 카드 위 4.5:1 이상)
  const tone = (v: number) => (dim ? 'text-muted-foreground' : DIR(v));
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="text-[16px] font-bold">{o.label}</h3>
        <span className="text-[13px] text-muted-foreground tabular">
          {o.h}{unit} 뒤{ok && o.n ? <span className="max-[359px]:hidden"> · 과거 {o.n}번</span> : null}
        </span>
        <GradeTag grade={o.grade} className="ml-auto" />
      </div>
      {!ok ? (
        <p className="mt-1.5 text-[13.5px] leading-[1.5] break-keep text-muted-foreground">{o.reason || '비교할 과거 자리가 부족해 계산하지 못했어요.'}</p>
      ) : (
        <div role="group" aria-label={`${o.label} ${o.h}${unit} 뒤 — 보통 ${pct(o.q10!)} ~ ${pct(o.q90!)}, 중앙값 ${pct(o.q50!)}`}>
          <div className="mt-2 flex items-end justify-between gap-3">
            <p className="min-w-0 text-[13.5px] leading-5 text-muted-foreground">
              보통 <span className={cn('font-semibold tabular whitespace-nowrap', dim ? 'text-muted-foreground' : 'text-foreground')}>
                <span className={tone(o.q10!)}>{pct(o.q10!)}</span> ~ <span className={tone(o.q90!)}>{pct(o.q90!)}</span>
              </span>
            </p>
            <p className="shrink-0 text-right leading-none whitespace-nowrap">
              <span className="mr-1.5 text-[12.5px] text-muted-foreground">중앙값</span>
              <b className={cn('text-[20px] font-bold tracking-[-0.02em] tabular', tone(o.q50!))}>{pct(o.q50!)}</b>
            </p>
          </div>
          <Band q10={o.q10!} q50={o.q50!} q90={o.q90!} dim={dim} scale={scale} />
          {o.win != null ? (
            <p className="mt-2.5 text-[13px] leading-[1.5] break-keep text-muted-foreground">
              오른 비율 <b className="font-semibold text-secondary-foreground tabular">{pct0(o.win)}</b>
              {o.base ? <> · 아무 날이나 샀을 땐 <span className="tabular">{pct0(o.base.win)}</span> <span className="whitespace-nowrap tabular">(중앙값 {pct(o.base.q50)})</span></> : null}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** 되돌려 확인한 결과 한 줄 — 실제 결과가 '보통 범위'(10번 중 8번 목표) 안에 든 비율 */
function Verify({ checks, items }: { checks: Partial<Record<string, OutlookCheck | null>> | undefined; items: OutlookItem[] }) {
  const rows = items.flatMap((o) => { const c = checks?.[o.label]; return c && Number.isFinite(c.coverage) ? [{ o, c }] : []; });
  if (!rows.length) return null;
  const ps = rows.map((r) => r.c.periods || 0).filter((x) => x > 0);
  const periods = !ps.length ? '' : Math.min(...ps) === Math.max(...ps) ? `${ps[0]}번` : `${Math.min(...ps)}~${Math.max(...ps)}번`;
  return (
    <div className="mt-4 rounded-[14px] bg-tile px-3.5 py-3 text-[12.5px] leading-[1.6] break-keep text-secondary-foreground">
      <p>
        <b className="font-semibold">과거로 되돌려 확인했어요.</b>{periods ? ` 과거 ${periods}의 시점에서 이 방식으로 범위를 냈다면,` : ''} 실제 결과가 범위 안에 든 비율은{' '}
        {rows.map(({ o, c }, i) => (
          <span key={o.label} className="whitespace-nowrap" title={`${o.label}: 오를지 내릴지 맞힌 비율 ${pct0(c.dirHit)} (늘 많이 나온 쪽으로 찍었을 때 ${pct0(c.baseDirHit)}) · 확인 ${c.n.toLocaleString('ko-KR')}건`}>
            {o.label} <b className="font-semibold tabular">{pct0(c.coverage)}</b>{i < rows.length - 1 ? ' · ' : ''}
          </span>
        ))}
        였어요 <span className="whitespace-nowrap text-muted-foreground">(목표 80%)</span>.
      </p>
      {items.some((o) => o.grade === 'poor') ? (
        <p className="mt-1 text-muted-foreground">‘참고 낮음’은 오를지 내릴지를 아무 날이나 고른 것보다 잘 맞히지 못한 기간이에요. 범위만 참고해 주세요.</p>
      ) : null}
    </div>
  );
}

export function OutlookCard({ sym, market, className }: { sym: Sym; market: Market; className?: string }) {
  const coin = MARKETS[market].coin;
  const unit = coin ? '일' : '거래일';
  const base = coin ? coinBase(sym) : null;
  const st = useNewsState(coin);
  const newListing = coin && isNewUpbitListing(st.data, base) ? listingStudy(st.data) : null;
  const sum = useQuery({ queryKey: ['predict-summary'], queryFn: predictSummary, staleTime: 10 * 60e3, retry: false });
  const one = useQuery({ queryKey: ['predict', sym], queryFn: () => predictSymbol(sym), staleTime: 10 * 60e3, retry: false });
  const items = one.data?.outlook?.filter((o) => o && o.label) ?? [];

  if (one.isLoading) {
    return (
      <Card className={className}>
        <Skeleton className="h-6 w-36 bg-secondary" />
        <div className="mt-5 space-y-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[74px] w-full bg-secondary" />)}</div>
      </Card>
    );
  }
  // 예측 대상이 아닌 종목은 카드 없이 (AI 예측 카드가 안내한다) — 신규 상장 주의만 있으면 그것만
  if (!items.length && !newListing) return null;
  const asOf = dayLabel(one.data?.asOf);
  const scale = scaleOf(items);
  return (
    <Card className={className}>
      <CardTitle right={asOf ? `${asOf} 기준` : null} sub="지금과 비슷했던 과거 자리에서 샀다면 어땠는지예요">이 자리에서 사면</CardTitle>
      {newListing ? <ListingCaution ls={newListing} className={items.length ? 'mb-5' : undefined} /> : null}
      {items.length ? (
        <>
          <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] leading-[1.5] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              {items.every((o) => o.grade === 'poor')
                ? <span aria-hidden className="h-2 w-7 rounded-full bg-[color-mix(in_srgb,var(--muted-foreground)_38%,var(--border))]" />
                : <span aria-hidden className="flex h-2 w-7 overflow-hidden rounded-full"><span className="w-1/2 bg-down/45" /><span className="w-1/2 bg-up/45" /></span>}
              보통 범위 (10번 중 8번)
            </span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-full bg-foreground" />중앙값</span>
          </p>
          <ul className="divide-y divide-border">
            {items.map((o) => <OutlookRow key={o.label} o={o} unit={unit} scale={scale} />)}
          </ul>
          <Verify checks={sum.data?.outlookBacktest?.[market]} items={items} />
          <p className="mt-3 text-[12px] leading-[1.55] break-keep text-muted-foreground">
            과거 비슷한 자리에서 실제로 어땠는지 보여 드리는 거예요. 앞으로도 그렇다는 보장은 없으니 참고만 해 주세요.
          </p>
        </>
      ) : (
        <p className="mt-3 text-[13px] leading-[1.55] break-keep text-muted-foreground">상장한 지 얼마 안 돼 기간별 범위는 아직 계산할 수 없어요.</p>
      )}
    </Card>
  );
}
