import { useState } from 'react';
import { cn } from '@/lib/utils';
import { logoUrl } from '@/lib/logo';
import { nameOf, type Sym } from '@/lib/market';

/** 종목 로고 — 이미지가 없으면 이름 첫 글자를 원 안에 */
export function SymbolLogo({ sym, size = 36, className }: { sym: Sym; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const n = nameOf(sym);
  const style = { width: size, height: size };
  if (failed) {
    const ch = (n.name || n.sub).replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 1).toUpperCase() || '?';
    return (
      <span style={{ ...style, fontSize: size * 0.42 }} className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-muted-foreground', className)} aria-hidden>
        {ch}
      </span>
    );
  }
  return (
    <img
      src={logoUrl(sym)} alt="" loading="lazy" decoding="async" style={style}
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-full bg-secondary object-cover', className)}
    />
  );
}
