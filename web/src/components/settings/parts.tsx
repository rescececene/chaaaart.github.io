// 설정 화면 전용 작은 부품 — 버튼 · 입력 칸 이름표 · 안내 상자 · 상태 점
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'secondary' | 'card';
const TONE: Record<Tone, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-border/60',
  // 회색 상자 안에 놓는 흰 버튼
  card: 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-hover',
};

/** 차트 화면 버튼과 같은 크기·모양 (h-10 · rounded-xl · 14px) */
export function Btn({ tone = 'secondary', size = 'md', type = 'button', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone; size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-9 px-3 text-[13px]' : size === 'lg' ? 'h-12 px-5 text-[15px]' : 'h-10 px-4 text-[14px]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="mb-1.5 block px-0.5 text-[13px] font-semibold text-secondary-foreground">{children}</label>;
}

/** 회색 칸 입력 (휴대폰에선 16px — 아이폰이 확대하지 않게) */
export const INPUT_CLS =
  'h-11 rounded-xl border-transparent bg-secondary px-3.5 text-[16px] md:text-[14px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card focus-visible:ring-3 focus-visible:ring-ring/20 dark:bg-secondary dark:focus-visible:bg-card';

/** 백업 코드 상자 (고정 높이, 안에서 스크롤) */
export const CODE_CLS =
  'field-sizing-fixed h-24 min-h-0 resize-none rounded-xl border-transparent bg-card px-3.5 py-3 font-mono leading-snug break-all placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 dark:bg-card';

export function Notice({ tone = 'info', className, children }: { tone?: 'info' | 'warn'; className?: string; children: ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <div className={cn('flex gap-2.5 rounded-2xl px-4 py-3 text-[13px] leading-relaxed text-secondary-foreground', tone === 'warn' ? 'bg-warn/10' : 'bg-secondary/60', className)}>
      <Icon className={cn('mt-[3px] size-4 shrink-0', tone === 'warn' ? 'text-warn' : 'text-subtle')} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 상태 점 — good(정상) · warn(늦음) · bad(오류) · off(꺼짐) */
export function Dot({ tone, pulse }: { tone: 'good' | 'warn' | 'bad' | 'off'; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : tone === 'bad' ? 'bg-destructive' : 'bg-faint',
        pulse && 'animate-pulse',
      )}
    />
  );
}
