import { useId, useMemo } from 'react';

/** 미니 추세선 — 처음보다 끝이 높으면 상승색, 낮으면 하락색 */
export function Sparkline({ data, width = 96, height = 32, className, area = true }: { data: number[]; width?: number; height?: number; className?: string; area?: boolean }) {
  const id = useId();
  const { d, fill, up } = useMemo(() => {
    const xs = data.filter((x) => Number.isFinite(x));
    if (xs.length < 2) return { d: '', fill: '', up: true };
    const min = Math.min(...xs), max = Math.max(...xs), span = max - min || 1;
    const pts = xs.map((v, i) => [(i / (xs.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    return { d: line, fill: `${line}L${width},${height}L0,${height}Z`, up: xs[xs.length - 1] >= xs[0] };
  }, [data, width, height]);
  if (!d) return <svg width={width} height={height} className={className} aria-hidden />;
  const color = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {area && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fill} fill={`url(#${id})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
