// 설정 화면 전용 작은 부품 — 버튼 · 입력 칸 이름표 · 안내 상자 · 상태 점
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'secondary' | 'card';
const TONE: Record<Tone, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/85',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-border/60',
  // 회색 상자 안에 놓는 흰 버튼
  card: 'bg-card text-secondary-foreground ring-1 ring-border ring-inset hover:bg-hover',
};

/** 버튼 — 높이 40(휴대폰 44) · rounded-xl · 15px. 주 버튼은 먹색(다크는 흰 알약), 비활성은 투명도만 */
export function Btn({ tone = 'secondary', size = 'md', type = 'button', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone; size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-9 px-3 text-[14px]' : size === 'lg' ? 'h-12 px-5 text-[15px]' : 'h-11 px-4 text-[15px] md:h-10',
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
  'h-11 rounded-xl border-transparent bg-secondary px-3.5 text-[16px] md:text-[15px] placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-[1.5px] focus-visible:ring-foreground focus-visible:ring-inset dark:bg-secondary';

/** 백업 코드 상자 (고정 높이, 안에서 스크롤) */
export const CODE_CLS =
  'field-sizing-fixed h-24 min-h-0 resize-none rounded-xl border-transparent bg-card px-3.5 py-3 font-mono leading-snug break-all placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-[1.5px] focus-visible:ring-foreground focus-visible:ring-inset dark:bg-card';

export function Notice({ tone = 'info', className, children }: { tone?: 'info' | 'warn'; className?: string; children: ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <div className={cn('flex gap-2.5 rounded-[14px] px-4 py-3 text-[13.5px] leading-[1.55] text-secondary-foreground', tone === 'warn' ? 'bg-warn/12' : 'bg-tile', className)}>
      <Icon className={cn('mt-[3px] size-4 shrink-0', tone === 'warn' ? 'text-warn' : 'text-muted-foreground')} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 상태 점 — good(정상) · warn(늦음) · bad(오류) · off(꺼짐). 빨강은 '상승' 뜻이라 오류도 주황 점(글자로 구분) */
export function Dot({ tone, pulse }: { tone: 'good' | 'warn' | 'bad' | 'off'; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : tone === 'bad' ? 'bg-warn' : 'bg-faint',
        pulse && 'animate-pulse',
      )}
    />
  );
}
