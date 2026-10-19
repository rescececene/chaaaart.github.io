// 스크리너 한 줄 — 자기 종목 시세만 구독하고 memo 로 감싸, 다른 종목 시세가 바뀌어도 다시 그리지 않는다
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText, Flash } from '@/components/common/Change';
import { useQuote } from '@/hooks/market';
import { SIGNALS } from '@/lib/indicators';
import { tickerOf } from '@/lib/coins';
import { ccyOf, fmtAmount, fmtPrice } from '@/lib/format';
import { href } from '@/lib/router';
import type { Market, ScreenerRow as Row } from '@/lib/market';
import { mergeLive, opTone, WIDE_GRID } from './model';

const rsiText = (r: number | null) => (r == null ? '–' : r.toFixed(0));
// 과매도(≤30)·과매수(≥70), 거래량 3배 이상은 색 대신 굵은 먹색으로 강조한다 (방향이 아닌 값)
const rsiHot = (r: number | null) => r != null && (r <= 30 || r >= 70);
const ratioText = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}배`);
const ratioHot = (v: number | null) => v != null && v >= 3;
const OP_TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-text-3' } as const;
const GLYPH = { up: '▲', down: '▼', flat: '●' } as const;
const GLYPH_TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;
// 화면 밖 줄은 그리기를 미루고 이 높이로 자리만 잡아 둔다 (안쪽 여백 제외 높이 · 한 번 그린 뒤엔 실제 높이를 기억한다)
const LAZY_WIDE = '[content-visibility:auto] [contain-intrinsic-size:auto_44px]';
const LAZY_NARROW = '[content-visibility:auto] [contain-intrinsic-size:auto_100px]';

/** 신호 태그 — 바탕은 무채색, ▲▼● 글머리만 방향색 (행마다 빨강·파랑 바탕이 반복되지 않게) */
function SigTag({ k }: { k: string }) {
  const s = SIGNALS[k];
  if (!s) return null;
  return (
    <span className="inline-flex h-[22px] items-center gap-[3px] rounded-md bg-secondary px-[7px] text-[12px] font-semibold whitespace-nowrap text-secondary-foreground">
      <i aria-hidden className={cn('text-[8px]', GLYPH_TONE[s[1]])}>{GLYPH[s[1]]}</i>{s[0]}
    </span>
  );
}

export const ScreenerRowItem = memo(function ScreenerRowItem({ row, market, wide }: { row: Row; market: Market; wide: boolean }) {
  const q = useQuote(row.sym);
  const e = mergeLive(row, q);
  const ccy = ccyOf(market);
  const op = <span className={cn('font-bold whitespace-nowrap', OP_TONE[opTone(row.op)])}>{row.op}</span>;
  const tags = e.sig.length ? <div className="flex min-w-0 flex-wrap gap-1">{e.sig.map((k) => <SigTag key={k} k={k} />)}</div> : null;
  const link = href('chart', row.sym, '1d');

  if (wide) {
    return (
      <a href={link} data-sym={row.sym} className={cn(WIDE_GRID, LAZY_WIDE, 'press -mx-3 min-h-[60px] rounded-[14px] px-3 py-2 transition-colors hover:bg-hover')}>
        <SymbolLogo sym={row.sym} size={36} className="size-10" />
        <div className="min-w-0">
          <div className="truncate text-[16px] leading-[22px] font-semibold">{row.name}</div>
          <div className="truncate text-[13px] leading-[18px] text-muted-foreground">{tickerOf(market, row.sub)}{row.ex ? ` · ${row.ex}` : ''}</div>
        </div>
        {tags ?? <span />}
        <div className="text-right text-[16px] font-semibold whitespace-nowrap tabular">
          <Flash value={e.price} className="-mr-1 px-1">{fmtPrice(e.price, market)}</Flash>
        </div>
        <div className="text-right"><ChangeText value={e.chg} className="text-[15px] font-semibold" /></div>
        <div className="text-right text-[15px] whitespace-nowrap text-secondary-foreground tabular">{fmtAmount(e.vol, ccy)}</div>
        <div className={cn('text-right text-[15px] tabular', rsiHot(row.rsi) ? 'font-bold text-foreground' : 'text-secondary-foreground')}>{rsiText(row.rsi)}</div>
        <div className={cn('text-right text-[15px] whitespace-nowrap tabular', ratioHot(row.volRatio) ? 'font-bold text-foreground' : 'text-secondary-foreground')}>{ratioText(row.volRatio)}</div>
        <div className="text-right text-[14px]">{op}</div>
      </a>
    );
  }

  // 휴대폰·태블릿 — 두 줄 행(이름/코드·거래대금 · 가격/등락) + 의견·RSI·거래량 줄 + 신호 태그 줄
  return (
    <a href={link} data-sym={row.sym} className={cn(LAZY_NARROW, 'press -mx-2 grid grid-cols-[36px_minmax(0,1fr)_auto] gap-x-3 rounded-[14px] px-2 py-3 transition-colors hover:bg-hover')}>
      <SymbolLogo sym={row.sym} size={36} className="mt-0.5" />
      <div className="min-w-0">
        <div className="truncate text-[15px] leading-[21px] font-semibold">{row.name}</div>
        <div className="truncate text-[13px] leading-[18px] text-muted-foreground tabular">{tickerOf(market, row.sub)} · {fmtAmount(e.vol, ccy)}</div>
      </div>
      <div className="flex flex-col items-end">
        <div className="text-[15px] leading-[21px] font-semibold whitespace-nowrap tabular">
          <Flash value={e.price} className="-mr-1 px-1">{fmtPrice(e.price, market)}</Flash>
        </div>
        <ChangeText value={e.chg} className="text-[13px] leading-[18px] font-semibold" />
      </div>
      <div className="col-span-2 col-start-2 mt-1.5 truncate text-[13px] text-text-3 tabular">
        {op}
        <span className="mx-1 text-muted-foreground" aria-hidden>·</span>
        <span className={cn(rsiHot(row.rsi) && 'font-bold text-foreground')}>RSI {rsiText(row.rsi)}</span>
        <span className="mx-1 text-muted-foreground" aria-hidden>·</span>
        <span className={cn(ratioHot(row.volRatio) && 'font-bold text-foreground')}>거래량 {ratioText(row.volRatio)}</span>
      </div>
      {tags && <div className="col-span-2 col-start-2 mt-1.5">{tags}</div>}
    </a>
  );
});
