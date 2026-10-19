import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { arrow, dirShown, fmtPct, round2 } from '@/lib/format';

const TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;

/** 등락률 — ▲ +1.23% (상승 빨강·하락 파랑, 기호를 함께 써서 색만으로 구분하지 않는다) */
export function ChangeText({ value, className, digits = 2, arrowOn = true }: { value: number | null | undefined; className?: string; digits?: number; arrowOn?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className={cn('text-muted-foreground', className)}>–</span>;
  const d = dirShown(value);
  return (
    <span className={cn('tabular whitespace-nowrap', TONE[d], className)}>
      {arrowOn && d !== 'flat' ? <span className="mr-0.5 text-[0.8em]">{arrow(round2(value))}</span> : null}
      {fmtPct(value, digits)}
    </span>
  );
}

/** 값이 오르내릴 때 배경이 잠깐 물드는 래퍼 */
export function Flash({ value, children, className }: { value: number | null | undefined; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      setCls(value > prev.current ? 'flash-up' : 'flash-down');
      setKey((k) => k + 1);
    }
    prev.current = value;
  }, [value]);
  return <span key={key} className={cn('rounded-md', cls, className)}>{children}</span>;
}

export const toneClass = (tone: 'up' | 'down' | 'flat') => TONE[tone];
