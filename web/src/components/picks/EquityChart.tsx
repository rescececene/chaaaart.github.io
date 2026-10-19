// 백테스트 누적 곡선 — 모델 상위 10% vs 시장 전체 평균 (한 축, 1에서 시작)
import { useMemo, useState } from 'react';
import { fmtRatio } from '@/lib/format';

interface Pt { t: string; top: number; all: number }

export function EquityChart({ data, height = 180 }: { data: Pt[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, PL = 8, PR = 52, PT = 10, PB = 22;
  const geo = useMemo(() => {
    if (data.length < 2) return null;
    const vals = data.flatMap((d) => [d.top, d.all]);
    const min = Math.min(...vals, 1), max = Math.max(...vals, 1), span = max - min || 1;
    const x = (i: number) => PL + (i / (data.length - 1)) * (W - PL - PR);
    const y = (v: number) => PT + (1 - (v - min) / span) * (H - PT - PB);
    const path = (k: 'top' | 'all') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join('');
    const ticks = [min, 1, max].filter((v, i, a) => a.indexOf(v) === i);
    return { x, y, top: path('top'), all: path('all'), ticks };
  }, [data, H]);
  if (!geo) return <p className="py-6 text-center text-[13px] text-muted-foreground">백테스트 곡선이 아직 없어요.</p>;
  const last = data[data.length - 1];
  const h = hover != null ? data[hover] : null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
        <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 rounded-full bg-primary" />모델 상위 10% <b className="tabular">{fmtRatio(last.top - 1)}</b></span>
        <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 rounded-full bg-subtle" />시장 전체 평균 <b className="tabular">{fmtRatio(last.all - 1)}</b></span>
        {h && <span className="ml-auto text-muted-foreground tabular">{h.t} · 상위 {fmtRatio(h.top - 1)} · 전체 {fmtRatio(h.all - 1)}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none" style={{ height: H }}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(((rel - PL) / (W - PL - PR)) * (data.length - 1)))));
        }}
        onPointerLeave={() => setHover(null)} role="img" aria-label={`누적 성과: 모델 상위 10% ${fmtRatio(last.top - 1)}, 시장 평균 ${fmtRatio(last.all - 1)}`}>
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={W - PR + 6} y={geo.y(v) + 4} fontSize="11" fill="var(--subtle)">{fmtRatio(v - 1, 0)}</text>
          </g>
        ))}
        <path d={geo.all} fill="none" stroke="var(--subtle)" strokeWidth="2" strokeLinejoin="round" />
        <path d={geo.top} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
        {hover != null && (
          <g>
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={PT} y2={H - PB} stroke="var(--faint)" strokeDasharray="3 3" />
            <circle cx={geo.x(hover)} cy={geo.y(data[hover].top)} r="4" fill="var(--primary)" stroke="var(--card)" strokeWidth="2" />
            <circle cx={geo.x(hover)} cy={geo.y(data[hover].all)} r="4" fill="var(--subtle)" stroke="var(--card)" strokeWidth="2" />
          </g>
        )}
        <text x={PL} y={H - 6} fontSize="11" fill="var(--subtle)">{data[0].t}</text>
        <text x={W - PR} y={H - 6} fontSize="11" fill="var(--subtle)" textAnchor="end">{last.t}</text>
      </svg>
    </div>
  );
}
