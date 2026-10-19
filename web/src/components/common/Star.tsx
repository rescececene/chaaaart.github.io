import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 관심 별 — 꺼짐은 빈 별(선), 켬은 채운 노란 별 (색뿐 아니라 모양으로도 구분) */
export function StarIcon({ on, className }: { on: boolean; className?: string }) {
  return (
    <Star
      aria-hidden
      strokeWidth={on ? 1.4 : 1.8}
      className={cn('size-[18px]', on ? 'fill-[var(--star)] stroke-[var(--star-edge)]' : 'fill-none', className)}
    />
  );
}
