// 펌핑 후보 화면 조각 — 위험 칩 · 영역 점수 막대 · 점수 이력 선 · 매물대 그림 (모두 가벼운 SVG/DOM, 차트 라이브러리 없음)
import { memo, useId } from 'react';
import { cn } from '@/lib/utils';
import { signedPct } from '@/components/common/Change';
import { fmtPrice } from '@/lib/format';
import { PUMP_GROUPS, type PumpGroup, type PumpItem, type PumpRisk, type PumpVp } from '@/lib/market/pump';

/** 분수 → '+9.1%' (U+2212) */
export const sp = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : signedPct(x * 100, d));
/** 분수 → '24%' */
export const p0 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
export const DIR = (x: number | null | undefined) => (x == null ? 'text-muted-foreground' : x > 0 ? 'text-up-text' : x < 0 ? 'text-down-text' : 'text-muted-foreground');
/** 원 → '1,234억' · '5.3억' · '8,500만' */
export function eok(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return '–';
  if (x >= 1e12) return `${(x / 1e12).toFixed(1)}조`;
  if (x >= 1e10) return `${Math.round(x / 1e8).toLocaleString('ko-KR')}억`;
  if (x >= 1e8) return `${(x / 1e8).toFixed(1)}억`;
  return `${Math.round(x / 1e4).toLocaleString('ko-KR')}만`;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** 초(UTC) → '10/28 15:00' (기기 시간대) */
export function stampT(t: number) {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const RISK_SHORT: Record<string, string> = {
  heat: '과열', liq: '거래가 적어요', dump: '급락 위험', pumpdump: '펌핑 뒤 급락', new: '신규 상장', warn: '투자유의', caution: '업비트 주의',
  news: '상폐·해킹 소식', notice: '공지',
};
/** 위험 칩 — 높음(2)은 주황 바탕, 주의(1)는 회색. 빨강·파랑은 오름·내림 뜻이라 쓰지 않는다 */
export function RiskChips({ risks, max = 3, className }: { risks: PumpRisk[]; max?: number; className?: string }) {
  const shownRisks = risks.filter((r) => r.chip !== false);
  if (!shownRisks.length) return null;
  const sorted = [...shownRisks].sort((a, b) => b.lv - a.lv);
  const shown = sorted.slice(0, max);
  const more = sorted.length - shown.length;
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-1', className)}>
      {shown.map((r) => (
        <span key={r.k} title={r.t}
          className={cn('inline-flex h-[20px] shrink-0 items-center rounded-[6px] px-1.5 text-[12px] font-semibold whitespace-nowrap',
            r.lv >= 2 ? 'bg-warn/15 text-[color-mix(in_srgb,var(--warn)_55%,var(--foreground))]' : 'bg-secondary text-muted-foreground')}>
          {RISK_SHORT[r.k] ?? '위험'}
        </span>
      ))}
      {more > 0 ? <span className="text-[12px] text-muted-foreground">+{more}</span> : null}
    </span>
  );
}

/** 영역 점수 막대 — 0~100, 가운데(50) 눈금 = 보통. main 만 또는 전부 */
export function PartBars({ parts, all = false, className }: { parts: PumpItem['parts']; all?: boolean; className?: string }) {
  const groups = PUMP_GROUPS.filter((g) => (all || g.main) && parts[g.key] != null);
  return (
    <ul className={cn('grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2', className)}>
      {groups.map((g) => {
        const v = Math.max(0, Math.min(100, parts[g.key as PumpGroup] ?? 50));
        return (
          <li key={g.key} title={g.hint} className="grid grid-cols-[88px_minmax(0,1fr)_28px] items-center gap-2.5 text-[13px]">
            <span className="truncate text-muted-foreground">{g.label}</span>
            <span className="relative h-1.5 rounded-full bg-border" role="img" aria-label={`${g.label} ${Math.round(v)}점 (50 = 보통)`}>
              <span className={cn('absolute inset-y-0 left-0 rounded-full', v >= 50 ? 'bg-secondary-foreground' : 'bg-faint')} style={{ width: `${v}%` }} />
              <span aria-hidden className="absolute -inset-y-[3px] left-1/2 w-px bg-muted-foreground/60" />
            </span>
            <span className={cn('text-right font-semibold tabular', v >= 70 ? 'text-foreground' : 'text-muted-foreground')}>{Math.round(v)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 점수 이력 선 — 14일 × 1시간 (빈 시간은 끊지 않고 이어 그림), 기준선(90) 점선 */
export const ScoreLine = memo(function ScoreLine({ hist, thr = 90, height = 56, className }: { hist: (number | null)[]; thr?: number; height?: number; className?: string }) {
  const id = useId();
  const W = 336, H = height, pad = 4;
  const pts: [number, number][] = [];
  hist.forEach((v, i) => { if (v != null) pts.push([(i / Math.max(1, hist.length - 1)) * W, pad + (1 - v / 100) * (H - 2 * pad)]); });
  const y = (v: number) => pad + (1 - v / 100) * (H - 2 * pad);
  const line = pts.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join('');
  const vals = hist.filter((v): v is number => v != null);
  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[56px] w-full" role="img"
        aria-label={vals.length ? `최근 14일 점수 ${Math.min(...vals)}~${Math.max(...vals)}, 지금 ${vals[vals.length - 1]}` : '점수 이력 없음'}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--foreground)" stopOpacity="0.10" />
            <stop offset="100%" stopColor="var(--foreground)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={y(thr)} y2={y(thr)} stroke="var(--warn)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={y(50)} y2={y(50)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {pts.length > 1 && <path d={`${line}L${pts[pts.length - 1][0]},${H}L${pts[0][0]},${H}Z`} fill={`url(#${id})`} />}
        {pts.length > 1 && <path d={line} fill="none" stroke="var(--foreground)" strokeOpacity="0.75" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-1 flex justify-between text-[11.5px] text-muted-foreground tabular">
        <span>14일 전</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-0 w-3 border-t border-dashed border-warn" />기준 {thr}</span>
        <span>지금</span>
      </div>
    </div>
  );
});

/** 매물대 — 최근 120일 가격대별 거래대금(가로 막대) + 지금 가격 선 + +15% 점선. 위에 쌓인 물량이 얇을수록 오르기 쉬워요 */
export const VpChart = memo(function VpChart({ vp, className }: { vp: PumpVp; className?: string }) {
  const n = vp.b.length;
  const lo = Math.log(vp.lo), hi = Math.log(vp.hi), span = hi - lo || 1;
  const rowH = 7, H = n * rowH, W = 240;
  const yOf = (p: number) => H - ((Math.log(p) - lo) / span) * H; // 위가 비싼 가격
  const yCur = Math.max(0, Math.min(H, yOf(vp.cur)));
  const yUp = yOf(vp.cur * 1.15);
  const curBin = Math.min(n - 1, Math.max(0, Math.floor(((Math.log(vp.cur) - lo) / span) * n)));
  const upBin = Math.floor(((Math.log(vp.cur * 1.15) - lo) / span) * n);
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-2', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[168px] w-full" role="img"
        aria-label={`최근 120일 가격대별 거래대금 — 가장 많이 거래된 가격대는 지금 가격보다 ${vp.poc > curBin ? '위' : vp.poc < curBin ? '아래' : '근처'}에 있어요`}>
        {vp.b.map((v, k) => {
          const y = H - (k + 1) * rowH;
          const inUp = k > curBin && k <= upBin;
          const fill = k === vp.poc ? 'var(--secondary-foreground)' : inUp ? 'var(--muted-foreground)' : 'var(--faint)';
          return <rect key={k} x="0" y={y + 1} width={Math.max(1.5, (v / 100) * W)} height={rowH - 2} rx="1.5" fill={fill} fillOpacity={k === vp.poc ? 0.9 : inUp ? 0.55 : 0.5} />;
        })}
        {yUp > 0 && <line x1="0" x2={W} y1={yUp} y2={yUp} stroke="var(--up)" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        <line x1="0" x2={W} y1={yCur} y2={yCur} stroke="var(--foreground)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="relative w-[84px] text-[11.5px] text-muted-foreground tabular" style={{ height: 168 }}>
        <span className="absolute top-0 right-0">{fmtPrice(vp.hi, 'upbit')}</span>
        {yUp > 10 && <span className="absolute right-0 -translate-y-1/2 text-up-text" style={{ top: `${(yUp / H) * 100}%` }}>+15%</span>}
        <span className="absolute right-0 -translate-y-1/2 font-semibold text-foreground" style={{ top: `${(yCur / H) * 100}%` }}>지금 {fmtPrice(vp.cur, 'upbit')}</span>
        <span className="absolute right-0 bottom-0">{fmtPrice(vp.lo, 'upbit')}</span>
      </div>
    </div>
  );
});

/** 10~90% 범위 막대 — 회색 홈에 범위 띠, 0 눈금, 중앙값 점 (값은 분수). 양 끝 값은 방향색 */
export function SpanBar({ q10, q50, q90, className }: { q10: number; q50: number; q90: number; className?: string }) {
  const lo = Math.min(q10, -0.02), hi = Math.max(q90, 0.02), span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  return (
    <div className={className}>
      <div className="relative mt-2 mb-1 h-1.5 rounded-full bg-border" role="img" aria-label={`10번 중 8번은 ${sp(q10, 0)} ~ ${sp(q90, 0)}, 중앙 ${sp(q50)}`}>
        <span className="absolute inset-y-0 rounded-full bg-muted-foreground/35" style={{ left: `${x(q10)}%`, width: `${Math.max(1, x(q90) - x(q10))}%` }} />
        <span aria-hidden className="absolute -inset-y-[3px] w-[1.5px] -translate-x-1/2 bg-muted-foreground" style={{ left: `${x(0)}%` }} />
        <span aria-hidden className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--tile)]" style={{ left: `${x(q50)}%` }} />
      </div>
      <div className="flex justify-between text-[11.5px] font-semibold tabular">
        <span className={DIR(q10)}>{sp(q10, 0)}</span>
        <span className={DIR(q90)}>{sp(q90, 0)}</span>
      </div>
    </div>
  );
}

/** 점수 숫자 — 90 이상(기준)이면 진하게 */
export function ScoreNum({ score, thr = 90, className }: { score: number; thr?: number; className?: string }) {
  return (
    <span className={cn('inline-flex flex-col items-end leading-none', className)}>
      <b className={cn('text-[26px] font-bold tracking-[-0.03em] tabular', score >= thr ? 'text-foreground' : 'text-secondary-foreground')}>{Math.round(score)}</b>
      <span className="mt-1 text-[11.5px] text-muted-foreground">펌핑 점수</span>
    </span>
  );
}
