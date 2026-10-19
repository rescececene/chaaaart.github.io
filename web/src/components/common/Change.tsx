import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;
type Tone = keyof typeof TONE;

const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
/** 보이는 자릿수로 반올림한 값의 방향 — 0.00% 로 보이면 방향 없음 */
const toneOf = (x: number, d: number): Tone => { const r = roundTo(x, d); return r > 0 ? 'up' : r < 0 ? 'down' : 'flat'; };
/** 부호 있는 퍼센트 — '+1.07%' · '−2.0%'(U+2212) · '0.00%' (김프·괴리율·지수 띠처럼 ▲ 없이 쓰는 값) */
export function signedPct(x: number | null | undefined, d = 2) {
  if (x == null || !Number.isFinite(x)) return '–';
  const r = roundTo(x, d);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(d)}%`;
}
/** 부호 있는 수 (U+2212) — '+30.4만' 같은 곳에 */
export const minus = (s: string) => s.replace(/^-/, '−');

/** ▲ · ▼ 기호 — 글자의 0.72em, 살짝 올림. 화면 낭독은 옆의 sr-only 글자로 */
export function Tri({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === 'flat') return null;
  return (
    <>
      <span aria-hidden className={cn('relative top-[-0.08em] mr-[2px] text-[0.72em]', className)}>{tone === 'up' ? '▲' : '▼'}</span>
      <span className="sr-only">{tone === 'up' ? '상승 ' : '하락 '}</span>
    </>
  );
}

/** 등락률 — ▲0.21% · ▼1.43% · 0.00% (기호가 부호를 대신한다). arrowOn={false} 면 +1.07% · −2.0%.
 *  relative: 안쪽 sr-only(절대 위치) 글자가 가로 스크롤 상자 밖으로 새어 페이지를 넓히지 않게 */
export function ChangeText({ value, className, digits = 2, arrowOn = true }: { value: number | null | undefined; className?: string; digits?: number; arrowOn?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className={cn('text-muted-foreground', className)}>–</span>;
  const d = toneOf(value, digits);
  return (
    <span className={cn('relative tabular whitespace-nowrap', TONE[d], className)}>
      {arrowOn ? <><Tri tone={d} />{Math.abs(roundTo(value, digits)).toFixed(digits)}%</> : signedPct(value, digits)}
    </span>
  );
}

/** 값이 오르내릴 때 잠깐 물드는 래퍼 — 기본은 바탕(0.5초), text 는 글자 색만 (큰 가격용: 분홍 상자가 남지 않게) */
export function Flash({ value, children, className, mode = 'bg' }: { value: number | null | undefined; children: ReactNode; className?: string; mode?: 'bg' | 'text' }) {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      const up = value > prev.current;
      setCls(mode === 'text' ? (up ? 'pulse-up' : 'pulse-down') : up ? 'flash-up' : 'flash-down');
      setKey((k) => k + 1);
    }
    prev.current = value;
  }, [value, mode]);
  return <span key={key} className={cn(mode === 'bg' && 'rounded-md', cls, className)}>{children}</span>;
}

export const toneClass = (tone: 'up' | 'down' | 'flat') => TONE[tone];
