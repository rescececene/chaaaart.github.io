import { useState } from 'react';
import { cn } from '@/lib/utils';
import { logoUrl } from '@/lib/logo';
import { nameOf, split, type Sym } from '@/lib/market';

/** 티커 → 색상환 각도 (같은 종목은 늘 같은 색) */
function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
// 이미지 원판 위 1px 안쪽 테 (투명 로고 가장자리가 바탕에 묻히지 않게)
const RING = 'after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_0_0_1px_var(--logo-ring)]';

/** 종목 로고 — 이미지 뒤엔 원판(라이트 흰색 · 다크 옅은 회색), 실패하면 티커 색 이니셜 원
 *  (코인·미국은 티커 첫 글자, 국내는 이름 첫 글자) */
export function SymbolLogo({ sym, size = 36, className }: { sym: Sym; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  // 크기는 CSS 변수로 — className 의 md:size-10 처럼 화면 폭에 따라 키울 수 있게
  const style = { ['--logo' as string]: `${size}px` };
  if (failed) {
    const n = nameOf(sym);
    const [market, code] = split(sym);
    const src = market === 'krx' ? n.name || code : (n.sub || code).replace(/^KRW-/, '');
    const ch = src.replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 1).toUpperCase() || '?';
    return (
      <span
        aria-hidden
        // 색은 테마 변수(--lg-*)로 — 라이트는 옅은 바탕·진한 글자, 다크는 반대
        style={{
          ...style, ['--h' as string]: hueOf(code), fontSize: Math.round(size * 0.42),
          background: 'hsl(var(--h) var(--lg-s) var(--lg-l))', color: 'hsl(var(--h) var(--lg-ts) var(--lg-tl))',
        }}
        className={cn('relative inline-flex size-(--logo) shrink-0 items-center justify-center rounded-full font-bold tracking-[-0.03em]', className)}
      >
        {ch}
      </span>
    );
  }
  return (
    <span style={style} className={cn('relative inline-flex size-(--logo) shrink-0 overflow-hidden rounded-full bg-[var(--logo-plate)]', RING, className)}>
      <img src={logoUrl(sym)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />
    </span>
  );
}
