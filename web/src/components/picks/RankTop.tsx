// 첫 화면 '오늘 강할 코인' — 업비트 원화 점수 상위 10% 안에서 '24시간 뒤 예상'이 높은 5개 + 어제 성적 + '전체 순위 보기'
// 데이터: data/rank_top.json 하나(수집할 때마다 다시 고름, 작은 파일) + 표시하는 5개만 실시간 가격 구독.
// 정직: 예상 % 는 0% 근처가 정상(시장 방향은 거의 못 맞힌다) — 순위의 힘은 '다른 코인보다 나을 몫'. 검증이 약하면 먼저 알린다.
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AiMark, Card, CardTitle } from '@/components/common/Card';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { Skeleton } from '@/components/ui/skeleton';
import { useWant } from '@/hooks/market';
import { rankTop, type Market, type RankTop as RankTopData, type RankTopItem } from '@/lib/market';
import { href } from '@/lib/router';
import { CautionChips, expDigits, fcWarn, fpct, MiniRange, ScoreLines, toneOf, useMove, whenText } from './rank';
import { minusFix } from './fmt';

const Row = memo(function Row({ it, label, poor }: { it: RankTopItem; label: string; poor?: boolean }) {
  const { move } = useMove(it.sym, it.base, it.price);
  const why = it.ai || it.why ? minusFix(it.ai || it.why || '') : null;
  const top = it.pct != null ? Math.max(1, Math.round(100 - it.pct)) : null;
  return (
    <li>
      <a href={href('chart', it.sym, '1d')}
        className="press -mx-2 grid grid-cols-[16px_32px_minmax(0,1fr)_auto] gap-x-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover">
        <span className="self-center text-right text-[13px] font-semibold text-muted-foreground tabular">{it.rank}</span>
        <SymbolLogo sym={it.sym} size={32} className="self-center" />
        <span className="flex min-w-0 items-center gap-1.5 self-center">
          <b className="truncate text-[15px] leading-5 font-semibold">{it.name}</b>
          {top != null ? <span className="shrink-0 text-[12px] text-muted-foreground tabular">상위 {top}%</span> : null}
        </span>
        <span className="row-span-2 self-center text-right">
          <b className={cn('block text-[18px] leading-6 font-bold tracking-[-0.02em] tabular', poor ? 'text-muted-foreground' : toneOf(it.mid, expDigits(it.mid)))}>
            {fpct(it.mid, expDigits(it.mid))}
          </b>
          <span className="block text-[11px] leading-4 whitespace-nowrap text-muted-foreground">{label}</span>
        </span>
        <span className="col-start-3 min-w-0">
          {why ? <span className="line-clamp-4 text-[13px] leading-[18px] break-keep text-secondary-foreground">{why}</span> : null}
        </span>
        {it.lo != null && it.hi != null ? (
          <span className="col-span-2 col-start-3 mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] leading-4">
            <span className="tabular whitespace-nowrap text-muted-foreground">
              10번 중 8번 <span className={toneOf(it.lo)}>{fpct(it.lo)}</span> ~ <span className={toneOf(it.hi)}>{fpct(it.hi)}</span>
            </span>
            <MiniRange className="w-16 shrink-0" lo={it.lo} hi={it.hi} mid={it.mid} now={move} />
            {move != null ? <span className="tabular whitespace-nowrap text-muted-foreground">지금 <b className={cn('font-semibold', toneOf(move))}>{fpct(move)}</b></span> : null}
            <CautionChips cau={it.cau} max={2} />
          </span>
        ) : it.cau?.length ? <span className="col-span-2 col-start-3 mt-1"><CautionChips cau={it.cau} max={2} /></span> : null}
      </a>
    </li>
  );
});

function aiBy(by: string | null | undefined) {
  return by === 'claude' ? '클로드' : by === 'gemma' ? 'AI(Gemma)' : by ? 'AI' : null;
}

/** 첫 화면 카드 — 업비트(없으면 바이낸스) 상위 5개. 데이터가 아직 없으면 아무것도 그리지 않는다 */
export function RankTop({ className }: { className?: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['rank-top'], queryFn: rankTop, staleTime: 3 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });
  const items = useMemo(() => data?.items?.slice(0, 5) ?? [], [data]);
  const syms = useMemo(() => items.map((it) => it.sym), [items]);
  useWant(syms.length ? syms : null);
  if (isLoading) {
    return (
      <Card className={className}>
        <CardTitle>오늘 강할 코인</CardTitle>
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl bg-secondary" />)}</div>
      </Card>
    );
  }
  if (!data || !data.market || !items.length) return null;
  return <RankTopBody d={data} items={items} className={className} />;
}

function RankTopBody({ d, items, className }: { d: RankTopData; items: RankTopItem[]; className?: string }) {
  const m = d.market as Market;
  const ex = m === 'binance' ? '바이낸스' : '업비트 원화';
  const warn = fcWarn(d.fcGrade, d.hLabel);
  const who = aiBy(d.aiBy);
  const sc = d.score;
  const hasAi = items.some((it) => it.ai);
  return (
    <Card className={className}>
      <CardTitle
        sub={<span className="break-keep">{ex} · 점수 상위 10% 안에서 {d.hLabel ?? '24시간'} 뒤 예상이 높은 순{d.baseAt ? <span className="tabular"> · {whenText(d.baseAt)} 가격 기준</span> : null}</span>}
        right={<a href={href('picks', m)} className="inline-flex items-center font-semibold text-muted-foreground hover:text-foreground">전체 순위 보기<ChevronRight aria-hidden className="size-4" /></a>}>
        오늘 강할 코인<AiMark />
      </CardTitle>
      {d.stale ? (
        <p className="mb-2 flex gap-1.5 text-[12.5px] leading-[1.5] break-keep text-warn"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />예측 기준일이 오래됐어요 — 엔진이 며칠 돌지 못했어요.</p>
      ) : null}
      {d.common ? <p className="mb-1 rounded-xl bg-tile px-3 py-2 text-[13px] leading-[1.5] break-keep text-secondary-foreground">{d.common} 아래는 코인마다 다른 점이에요.</p> : null}
      <ol>{items.map((it) => <Row key={it.sym} it={it} label={`${d.hLabel ?? '24시간'} 뒤 예상`} poor={d.fcGrade === 'poor'} />)}</ol>
      <p className="mt-1.5 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
        {d.mkt?.mid != null ? <>{ex === '업비트 원화' ? '업비트' : '바이낸스'} 전체(가운데 코인) {d.hLabel ?? '24시간'} 예상은 <span className={cn('font-semibold tabular', toneOf(d.mkt.mid, 2))}>{fpct(d.mkt.mid, 2)}</span>예요. </> : null}
        시장 전체 방향은 거의 못 맞혀서 예상 % 는 0% 근처가 정상이고, 순위는 ‘다른 코인보다 나을 쪽’을 고른 거예요. 오를 확률이 아니에요.
      </p>
      {warn ? <p className="mt-1.5 flex gap-1.5 text-[12.5px] leading-[1.5] break-keep text-secondary-foreground"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{warn}</p> : null}
      {sc && (sc.last || sc.real || sc.past || sc.pending) ? (
        <section aria-label="예측 성적" className="mt-3 rounded-[14px] bg-tile px-3.5 pt-2.5 pb-1.5">
          <h3 className="text-[13.5px] font-bold">예측 성적</h3>
          <ScoreLines market={m} last={sc.last} real={sc.real} past={sc.past} pending={sc.pending} h={d.h} dd={sc.check} />
        </section>
      ) : null}
      <p className="mt-2 text-[12px] leading-[1.5] break-keep text-muted-foreground">
        {hasAi && who ? `※ 이유 문장은 ${who}가 숫자를 보고 썼어요. ` : '※ 이유는 엔진 근거를 쉬운 말로 옮긴 거예요. '}
        지난 데이터로 만든 참고 자료예요 · 투자 권유가 아니에요
      </p>
    </Card>
  );
}
