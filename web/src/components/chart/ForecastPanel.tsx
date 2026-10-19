// AI 예측 — 하루 한 번 GitHub Actions 가 학습한 순위 모델의 결과 (예측 대상: 각 시장 유니버스 종목)
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtRatio } from '@/lib/format';
import { MARKETS, predictSummary, predictSymbol, type Market, type PredictSymbol, type Sym } from '@/lib/market';
import { href } from '@/lib/router';
import { Skeleton } from '@/components/ui/skeleton';
import { AiRange } from '@/components/common/RangeBar';
import { minus } from '@/components/common/Change';

const DIR = (x: number) => (x > 0 ? 'text-up-text' : x < 0 ? 'text-down-text' : 'text-foreground');
/** 분수 → '+3.4%' · '−0.6%' (U+2212) */
export const ratioText = (x: number | null | undefined, d = 1) => minus(fmtRatio(x, d));

/** 이유 한 줄 — '하루 평균 변동폭(ATR) 6.0% (시장 하위 14%)' → 본문 + 회색 순위. 음수 부호는 U+2212 */
export function ReasonText({ text }: { text: string }) {
  const t = text.replace(/(^|[\s(~])-(?=\d)/g, '$1−');
  const m = t.match(/^(.*\S)\s*\(([^()]*\d%[^()]*)\)\s*$/);
  if (!m) return <>{t}</>;
  return <>{m[1]} <span className="text-[13px] whitespace-nowrap text-muted-foreground">{m[2]}</span></>;
}

/** 회색 점 글머리 목록 — 변동성·거래량처럼 방향이 아닌 이유도 있으므로 빨강·파랑 글머리를 쓰지 않는다 */
export function DotList({ items, className, itemClass }: { items: string[]; className?: string; itemClass?: string }) {
  return (
    <ul className={className}>
      {items.map((x, i) => (
        <li key={i} className={cn('relative py-1 pl-3.5 text-[14.5px] leading-[21px] text-secondary-foreground before:absolute before:top-[13px] before:left-0.5 before:size-1 before:rounded-full before:bg-muted-foreground/70', itemClass)}>
          <ReasonText text={x} />
        </li>
      ))}
    </ul>
  );
}

/** 비슷했던 과거 차트들의 이후 경로 */
function AnalogPaths({ data }: { data: PredictSymbol }) {
  const paths = data.analogs.filter((a) => a.path?.length);
  if (!paths.length) return null;
  const all = paths.flatMap((a) => a.path);
  const min = Math.min(1, ...all), max = Math.max(1, ...all), W = 280, H = 72, n = Math.max(...paths.map((a) => a.path.length));
  const y = (v: number) => H - 6 - ((v - min) / (max - min || 1)) * (H - 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-3 h-[72px] w-full" role="img" aria-label="비슷했던 과거 구간 이후의 가격 경로 (빨강: 올랐음, 파랑: 내렸음)">
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} stroke="var(--border)" strokeDasharray="3 3" />
      {paths.map((a, i) => {
        const pts = [1, ...a.path].map((v, k) => `${(k / n) * W},${y(v)}`).join(' ');
        return <polyline key={i} points={pts} fill="none" stroke={a.fwdRet >= 0 ? 'var(--up)' : 'var(--down)'} strokeOpacity={0.45} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col items-center gap-0.5 rounded-[14px] bg-tile px-1 py-2.5">
    <span className="text-[12.5px] whitespace-nowrap text-muted-foreground">{label}</span>
    <b className="text-[17px] font-bold tabular">{children}</b>
  </div>
);

export function ForecastPanel({ sym, market }: { sym: Sym; market: Market }) {
  const sum = useQuery({ queryKey: ['predict-summary'], queryFn: predictSummary, staleTime: 10 * 60e3, retry: false });
  const one = useQuery({ queryKey: ['predict', sym], queryFn: () => predictSymbol(sym), staleTime: 10 * 60e3, retry: false });
  const m = sum.data?.markets?.[market];
  if (sum.isLoading || one.isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-32 bg-secondary" /><Skeleton className="h-16 w-full bg-secondary" /><Skeleton className="h-24 w-full bg-secondary" /></div>;
  if (!sum.data) return <p className="py-8 text-center text-[14px] text-muted-foreground">예측 데이터를 준비하고 있어요. 하루 한 번 새로 계산돼요.</p>;
  if (!one.data) {
    return (
      <div className="py-6 text-center text-[14px] leading-[1.6] text-muted-foreground">
        이 종목은 예측 대상이 아니에요.<br />{MARKETS[market].name}에서 시가총액·거래대금 상위 {m?.universe ?? ''}개 종목을 예측해요.
        <div className="mt-3"><a className="font-semibold text-foreground underline-offset-2 hover:underline" href={href('picks', market)}>{MARKETS[market].name} 유망 종목 보기</a></div>
      </div>
    );
  }
  const d = one.data, bt = m?.backtest;
  const unit = MARKETS[market].coin ? '일' : '거래일';
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[30px] leading-9 font-bold tracking-[-0.03em] tabular md:text-[34px] md:leading-10">{Math.round(d.score)}<small className="ml-0.5 text-[17px] font-semibold text-text-3">점</small></div>
          <div className="text-[13px] text-muted-foreground">{MARKETS[market].name} {d.of}종목 중 {d.rank}위</div>
        </div>
        {d.probUp != null && (
          <div className="flex shrink-0 flex-col items-end rounded-[14px] bg-tile px-3 py-2 text-right sm:px-3.5 sm:py-2.5" title={`${d.horizon}${unit} 뒤 시장 중앙값보다 오를 확률`}>
            <span className="text-[13px] whitespace-nowrap text-muted-foreground">시장보다 나을 확률</span>
            <b className="text-[20px] leading-7 font-bold tabular sm:text-[22px]">{Math.round(d.probUp * 100)}%</b>
          </div>
        )}
      </div>
      {d.q10 != null && d.q50 != null && d.q90 != null && (
        <AiRange className="mt-[18px]" q10={d.q10} q50={d.q50} q90={d.q90} label={`${d.horizon}${unit} 뒤 수익률 예상 범위 (10~90%)`} />
      )}
      {d.reasons.length > 0 && (
        <>
          <h3 className="mt-5 mb-1 text-[15px] font-bold">이렇게 본 이유</h3>
          <DotList items={d.reasons.map((r) => r.text)} />
        </>
      )}
      {d.analogStats && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Tile label="비슷했던 차트">{d.analogStats.n}번</Tile>
            <Tile label="그 뒤 오른 비율">{Math.round(d.analogStats.winRate * 100)}%</Tile>
            <Tile label="평균 수익률"><span className={DIR(d.analogStats.avg)}>{ratioText(d.analogStats.avg)}</span></Tile>
          </div>
          <AnalogPaths data={d} />
        </>
      )}
      {bt && (
        <details className="group mt-3">
          <summary className="press flex h-11 cursor-pointer list-none items-center justify-center gap-1 rounded-xl text-[14px] font-semibold text-text-3 hover:bg-secondary [&::-webkit-details-marker]:hidden">
            이 모델의 과거 성적 보기<ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="mt-2 rounded-[14px] bg-tile p-4 text-[13px] leading-[1.6] text-secondary-foreground">
            <p>
              {MARKETS[market].name} · {bt.from} ~ {bt.to} — 상위 10% 종목이 시장 중앙값을 이긴 비율 <b className="tabular">{bt.topHitRate == null ? '–' : Math.round(bt.topHitRate * 100) + '%'}</b>,
              평균 초과수익 <b className={cn('tabular', DIR(bt.topExcess ?? 0))}>{ratioText(bt.topExcess)}</b>,
              순위 상관(IC) <b className="tabular">{bt.rankIC == null ? '–' : bt.rankIC.toFixed(3)}</b>
            </p>
            {m?.notes?.length ? <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground">{m.notes.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
            <p className="mt-2 text-muted-foreground">{d.asOf} 기준 · 과거 성과가 미래 수익을 보장하지 않아요. 참고용으로만 보세요.</p>
          </div>
        </details>
      )}
    </div>
  );
}
