// AI 예측 — 하루 한 번 GitHub Actions 가 학습한 순위 모델의 결과 (예측 대상: 각 시장 유니버스 종목)
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtRatio } from '@/lib/format';
import { MARKETS, predictSummary, predictSymbol, type Market, type PredictSymbol, type Sym } from '@/lib/market';
import { href } from '@/lib/router';
import { Skeleton } from '@/components/ui/skeleton';

const TONE_TEXT = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;

/** 예상 수익 범위 막대: 10% ~ 90% 구간과 중앙값 */
export function RangeBar({ q10, q50, q90 }: { q10: number; q50: number; q90: number }) {
  const lo = Math.min(q10, -0.02), hi = Math.max(q90, 0.02), span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  return (
    <div>
      <div className="relative h-8">
        <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-secondary" />
        <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-primary/25" style={{ left: `${x(q10)}%`, width: `${x(q90) - x(q10)}%` }} />
        <div className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-subtle" style={{ left: `${x(0)}%` }} title="0%" />
        <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary" style={{ left: `${x(q50)}%` }} />
      </div>
      <div className="flex justify-between text-[12px] tabular">
        <span className={TONE_TEXT[q10 < 0 ? 'down' : 'up']}>{fmtRatio(q10)}</span>
        <span className="font-semibold">중앙 {fmtRatio(q50)}</span>
        <span className={TONE_TEXT[q90 < 0 ? 'down' : 'up']}>{fmtRatio(q90)}</span>
      </div>
    </div>
  );
}

/** 비슷했던 과거 차트들의 이후 경로 */
function AnalogPaths({ data }: { data: PredictSymbol }) {
  const paths = data.analogs.filter((a) => a.path?.length);
  if (!paths.length) return null;
  const all = paths.flatMap((a) => a.path);
  const min = Math.min(1, ...all), max = Math.max(1, ...all), W = 280, H = 90, n = Math.max(...paths.map((a) => a.path.length));
  const y = (v: number) => H - 6 - ((v - min) / (max - min || 1)) * (H - 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[90px] w-full" aria-label="비슷했던 과거 구간 이후의 가격 경로">
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} stroke="var(--border)" strokeDasharray="3 3" />
      {paths.map((a, i) => {
        const pts = [1, ...a.path].map((v, k) => `${(k / n) * W},${y(v)}`).join(' ');
        return <polyline key={i} points={pts} fill="none" stroke={a.fwdRet >= 0 ? 'var(--up)' : 'var(--down)'} strokeOpacity={0.45} strokeWidth="1.4" />;
      })}
    </svg>
  );
}

export function ForecastPanel({ sym, market }: { sym: Sym; market: Market }) {
  const sum = useQuery({ queryKey: ['predict-summary'], queryFn: predictSummary, staleTime: 10 * 60e3, retry: false });
  const one = useQuery({ queryKey: ['predict', sym], queryFn: () => predictSymbol(sym), staleTime: 10 * 60e3, retry: false });
  const m = sum.data?.markets?.[market];
  if (sum.isLoading || one.isLoading) return <div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (!sum.data) return <p className="py-8 text-center text-[14px] text-muted-foreground">예측 데이터를 준비하고 있어요. 하루 한 번 새로 계산됩니다.</p>;
  if (!one.data) {
    return (
      <div className="py-6 text-center text-[14px] text-muted-foreground">
        이 종목은 예측 대상이 아니에요.<br />{MARKETS[market].name}에서 시가총액·거래대금 상위 {m?.universe ?? ''}개 종목을 예측해요.
        <div className="mt-3"><a className="font-semibold text-primary" href={href('picks', market)}>{MARKETS[market].name} 유망 종목 보기</a></div>
      </div>
    );
  }
  const d = one.data, bt = m?.backtest;
  const unit = MARKETS[market].coin ? '일' : '거래일';
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><Sparkles className="size-3.5 text-primary" /> 향후 {d.horizon}{unit} · {d.asOf} 기준</div>
          <div className="mt-1 text-[28px] font-bold tracking-tight tabular">{Math.round(d.score)}<span className="text-[16px] text-muted-foreground">점</span></div>
          <div className="text-[13px] text-muted-foreground">{MARKETS[market].name} {d.of}개 중 {d.rank}위</div>
        </div>
        {d.probUp != null && (
          <div className="rounded-2xl bg-secondary/60 px-4 py-3 text-right">
            <div className="text-[12px] text-muted-foreground">시장 중앙값을 이길 확률</div>
            <div className={cn('text-[22px] font-bold tabular', d.probUp >= 0.5 ? 'text-up-text' : 'text-down-text')}>{Math.round(d.probUp * 100)}%</div>
          </div>
        )}
      </div>
      {d.q10 != null && d.q50 != null && d.q90 != null && (
        <div>
          <div className="mb-1 text-[14px] font-bold">예상 수익률 범위 <span className="text-[12px] font-normal text-muted-foreground">(10~90% 구간)</span></div>
          <RangeBar q10={d.q10} q50={d.q50} q90={d.q90} />
        </div>
      )}
      {d.reasons.length > 0 && (
        <div>
          <div className="mb-2 text-[14px] font-bold">이렇게 본 이유</div>
          <ul className="space-y-2">
            {d.reasons.map((r, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-snug">
                <span className={cn('mt-[3px] text-[10px]', TONE_TEXT[r.tone])} aria-hidden>{r.tone === 'up' ? '▲' : r.tone === 'down' ? '▼' : '●'}</span>
                <span className="text-secondary-foreground">{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.analogStats && (
        <div>
          <div className="mb-1 text-[14px] font-bold">비슷했던 과거 차트 {d.analogStats.n}번, 그 뒤 {d.horizon}{unit}</div>
          <AnalogPaths data={d} />
          <div className="mt-1 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-secondary/60 py-2"><div className="text-[12px] text-muted-foreground">오른 비율</div><div className="text-[15px] font-bold tabular">{Math.round(d.analogStats.winRate * 100)}%</div></div>
            <div className="rounded-xl bg-secondary/60 py-2"><div className="text-[12px] text-muted-foreground">평균</div><div className={cn('text-[15px] font-bold tabular', TONE_TEXT[d.analogStats.avg >= 0 ? 'up' : 'down'])}>{fmtRatio(d.analogStats.avg)}</div></div>
            <div className="rounded-xl bg-secondary/60 py-2"><div className="text-[12px] text-muted-foreground">중앙값</div><div className={cn('text-[15px] font-bold tabular', TONE_TEXT[d.analogStats.median >= 0 ? 'up' : 'down'])}>{fmtRatio(d.analogStats.median)}</div></div>
          </div>
        </div>
      )}
      {bt && (
        <div className="rounded-2xl bg-secondary/60 p-4 text-[13px]">
          <div className="mb-1 font-bold">이 모델의 과거 성적 ({MARKETS[market].name}, {bt.from} ~ {bt.to})</div>
          <p className="text-secondary-foreground">
            상위 10% 종목이 시장 중앙값을 이긴 비율 <b className="tabular">{bt.topHitRate == null ? '–' : Math.round(bt.topHitRate * 100) + '%'}</b>,
            평균 초과수익 <b className={cn('tabular', TONE_TEXT[(bt.topExcess ?? 0) >= 0 ? 'up' : 'down'])}>{fmtRatio(bt.topExcess)}</b> ·
            순위 상관(IC) <b className="tabular">{bt.rankIC == null ? '–' : bt.rankIC.toFixed(3)}</b>
          </p>
          {m?.notes?.length ? <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12px] text-muted-foreground">{m.notes.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
          <p className="mt-2 text-[12px] text-subtle">과거 성과가 미래 수익을 보장하지 않아요. 참고용으로만 보세요.</p>
        </div>
      )}
    </div>
  );
}
