// 지난 48시간 가격 + 다음 24시간 '10번 중 8번' 범위(부채꼴) · 예상(점선) · 갈림길(가로 점선) · 지금 가격(점)
// 차트 라이브러리 없이 SVG 하나 + 글자는 HTML (선 굵기·글자 크기가 폭에 따라 늘지 않게).
// 부채꼴 폭은 시간의 제곱근에 비례(변동성 규칙)로 그린 그림이고, 실제 예측은 24시간 끝의 범위예요.
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { krw } from './fmt';

const W = 300, Hh = 120; // viewBox (preserveAspectRatio=none) — 실제 크기는 CSS
const PAST = 48, FUT = 24;

export function ForecastFan({ spark, base, lo, hi, med, pivot, live, hoursSince, className }: {
  spark: number[]; base: number; lo: number; hi: number; med: number; pivot?: number | null; live?: number | null;
  /** 기준 시각부터 지금까지 시간 (지금 가격 점의 가로 위치) */
  hoursSince: number; className?: string;
}) {
  const g = useMemo(() => {
    const past = spark.filter((x) => Number.isFinite(x) && x > 0).slice(-PAST);
    const span = Math.max(hi - lo, base * 0.004);
    const near = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > lo - span * 0.8 && x < hi + span * 0.8;
    const ys = [...past, lo, hi, base, ...(near(pivot) ? [pivot] : []), ...(near(live) ? [live] : [])];
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = (y1 - y0) * 0.08 || base * 0.002;
    const min = y0 - pad, max = y1 + pad;
    const X = (h: number) => ((h + PAST) / (PAST + FUT)) * W; // h: 기준 시각 기준 시간 (−48 … +24)
    const Y = (p: number) => Hh - ((p - min) / (max - min)) * Hh;
    const pct = (p: number) => (1 - (p - min) / (max - min)) * 100; // HTML 글자용 top %
    const n = past.length;
    const line = past.map((p, k) => `${k ? 'L' : 'M'}${X(k - (n - 1)).toFixed(1)},${Y(p).toFixed(1)}`).join('');
    // 부채꼴: √(t/24) 로 벌어진다 (기준 가격 → 24시간 뒤 10%·90%)
    const steps = 12;
    const up: string[] = [], dn: string[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = (k / steps) * FUT, f = Math.sqrt(t / FUT);
      up.push(`${X(t).toFixed(1)},${Y(base + (hi - base) * f).toFixed(1)}`);
      dn.push(`${X(t).toFixed(1)},${Y(base + (lo - base) * f).toFixed(1)}`);
    }
    const mid = Array.from({ length: steps + 1 }, (_, k) => [X((k / steps) * FUT), base] as const);
    const upper = `M${mid.map(([x, y]) => `${x.toFixed(1)},${Y(y).toFixed(1)}`).join('L')}L${up.slice().reverse().join('L')}Z`;
    const lower = `M${mid.map(([x, y]) => `${x.toFixed(1)},${Y(y).toFixed(1)}`).join('L')}L${dn.slice().reverse().join('L')}Z`;
    // 오른쪽 가격 글자 — 겹치지 않게 최소 간격(높이의 13%) 띄우기
    const labs = [{ k: 'hi', p: hi }, { k: 'med', p: med }, { k: 'lo', p: lo }].map((l) => ({ ...l, top: pct(l.p) }));
    for (let i = 1; i < labs.length; i++) if (labs[i].top - labs[i - 1].top < 13) labs[i].top = labs[i - 1].top + 13;
    const over = labs[labs.length - 1].top - 96;
    if (over > 0) labs.forEach((l) => { l.top -= over; });
    return {
      line, upper, lower, X, Y, pct, labs,
      medPath: `M${X(0).toFixed(1)},${Y(base).toFixed(1)}L${X(FUT).toFixed(1)},${Y(med).toFixed(1)}`,
      pivotIn: near(pivot), liveIn: near(live),
    };
  }, [spark, base, lo, hi, med, pivot, live]);
  const tNow = Math.min(FUT, Math.max(0, hoursSince));
  return (
    <div className={cn('relative', className)}>
      <div className="relative mr-[70px] h-[132px]">
        <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          <path d={g.upper} className="fill-up/15" />
          <path d={g.lower} className="fill-down/15" />
          <path d={`M${g.X(0)},${g.Y(hi)}L${g.X(FUT)},${g.Y(hi)}`} className="stroke-up/40" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
          <path d={`M${g.X(0)},${g.Y(lo)}L${g.X(FUT)},${g.Y(lo)}`} className="stroke-down/40" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
          <line x1={g.X(0)} x2={g.X(0)} y1={0} y2={Hh} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {g.pivotIn && pivot != null ? (
            <line x1={0} x2={W} y1={g.Y(pivot)} y2={g.Y(pivot)} className="stroke-foreground/60" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          ) : null}
          <path d={g.line} fill="none" className="stroke-foreground" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={g.medPath} fill="none" className="stroke-foreground/70" strokeWidth="1.4" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* 지금 가격 (실시간) — 원은 HTML 로 (늘어나지 않게) */}
        {g.liveIn && live != null ? (
          <span aria-hidden className="absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card"
            style={{ left: `${(g.X(tNow) / W) * 100}%`, top: `${g.pct(live)}%` }} />
        ) : null}
        <span aria-hidden className="absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${(g.X(0) / W) * 100}%`, top: `${g.pct(base)}%` }} />
        {g.pivotIn && pivot != null ? (
          <span className="absolute left-0 -translate-y-full pb-0.5 text-[11px] leading-none font-semibold text-foreground/70" style={{ top: `${g.pct(pivot)}%` }}>갈림길</span>
        ) : null}
        {/* 오른쪽 가격 */}
        {g.labs.map((l) => (
          <span key={l.k} className={cn('absolute left-full ml-1.5 -translate-y-1/2 text-[11.5px] leading-none font-semibold whitespace-nowrap tabular',
            l.k === 'hi' ? 'text-up-text' : l.k === 'lo' ? 'text-down-text' : 'text-foreground')} style={{ top: `${l.top}%` }}>
            {krw(l.p, false)}
          </span>
        ))}
      </div>
      <div className="relative mt-1.5 mr-[70px] h-4 text-[11.5px] leading-4 text-muted-foreground">
        <span className="absolute left-0">48시간 전</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${(PAST / (PAST + FUT)) * 100}%` }}>기준</span>
        <span className="absolute right-0">24시간 뒤</span>
      </div>
    </div>
  );
}

/** 그림 아래 범례 */
export function FanLegend({ pivot, live }: { pivot: boolean; live: boolean }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[1.5] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="flex h-2.5 w-5 flex-col overflow-hidden rounded-sm"><span className="h-1/2 bg-up/25" /><span className="h-1/2 bg-down/25" /></span>
        10번 중 8번
      </span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t-[1.5px] border-dashed border-foreground/70" />예상</span>
      {pivot ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t-[1.5px] border-dashed border-foreground/50" />갈림길</span> : null}
      {live ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-[11px] rounded-full border-2 border-foreground bg-card" />지금</span> : null}
    </p>
  );
}
