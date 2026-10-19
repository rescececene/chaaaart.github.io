// 스크리너 한 줄 — 자기 종목 시세만 구독하고 memo 로 감싸, 다른 종목 시세가 바뀌어도 다시 그리지 않는다
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText, Flash, toneClass } from '@/components/common/Change';
import { SignalTag } from '@/components/chart/AnalysisPanel';
import { useQuote } from '@/hooks/market';
import { tickerOf } from '@/lib/coins';
import { ccyOf, fmtAmount, fmtPrice } from '@/lib/format';
import { href } from '@/lib/router';
import type { Market, ScreenerRow as Row } from '@/lib/market';
import { mergeLive, opTone, WIDE_GRID } from './model';

const rsiText = (r: number | null) => (r == null ? '–' : r.toFixed(0));
// 과매도(≤30)는 상승 쪽, 과매수(≥70)는 하락 쪽 신호와 같은 색
const rsiClass = (r: number | null) => (r == null ? 'text-muted-foreground' : r <= 30 ? 'font-semibold text-up-text' : r >= 70 ? 'font-semibold text-down-text' : '');
const ratioText = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}배`);
const ratioClass = (v: number | null) => (v != null && v >= 3 ? 'font-semibold text-foreground' : 'text-muted-foreground');
// 화면 밖 줄은 그리기를 미루고 이 높이로 자리만 잡아 둔다 (안쪽 여백 제외 높이 · 한 번 그린 뒤엔 실제 높이를 기억한다)
const LAZY_WIDE = '[content-visibility:auto] [contain-intrinsic-size:auto_40px]';
const LAZY_NARROW = '[content-visibility:auto] [contain-intrinsic-size:auto_80px]';

export const ScreenerRowItem = memo(function ScreenerRowItem({ row, market, wide }: { row: Row; market: Market; wide: boolean }) {
  const q = useQuote(row.sym);
  const e = mergeLive(row, q);
  const ccy = ccyOf(market);
  const opCls = cn(toneClass(opTone(row.op)), row.op.startsWith('적극') && 'font-bold');
  const tags = e.sig.map((k) => <SignalTag key={k} k={k} size={wide ? 'md' : 'sm'} />);
  const link = href('chart', row.sym, '1d');

  if (wide) {
    return (
      <a href={link} data-sym={row.sym} className={cn(WIDE_GRID, LAZY_WIDE, 'press -mx-3 rounded-xl px-3 py-2.5 hover:bg-hover')}>
        <div className="flex min-w-0 items-center gap-3">
          <SymbolLogo sym={row.sym} size={36} />
          <div className="min-w-0">
            <div className="truncate text-[15px] leading-snug font-semibold">{row.name}</div>
            <div className="truncate text-[12.5px] text-muted-foreground">{tickerOf(market, row.sub)}{row.ex ? ` · ${row.ex}` : ''}</div>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap gap-1">{tags}</div>
        <div className="text-right text-[15px] font-semibold tabular">
          <Flash value={e.price} className="-mr-1 px-1">{fmtPrice(e.price, market)}</Flash>
        </div>
        <div className="text-right"><ChangeText value={e.chg} className="text-[14px] font-semibold" /></div>
        <div className="text-right text-[14px] text-muted-foreground tabular">{fmtAmount(e.vol, ccy)}</div>
        <div className={cn('text-right text-[14px] tabular', rsiClass(row.rsi))}>{rsiText(row.rsi)}</div>
        <div className={cn('text-right text-[14px] tabular', ratioClass(row.volRatio))}>{ratioText(row.volRatio)}</div>
        <div className={cn('text-right text-[14px] font-semibold whitespace-nowrap', opCls)}>{row.op}</div>
      </a>
    );
  }

  // 휴대폰 — 토스식 행: 왼쪽 로고·이름·코드, 오른쪽 가격·등락, 아래 줄에 의견·RSI·신호
  return (
    <a href={link} data-sym={row.sym} className={cn(LAZY_NARROW, 'press -mx-2 flex gap-3 rounded-xl px-2 py-3 hover:bg-hover')}>
      <SymbolLogo sym={row.sym} size={36} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[15px] leading-snug font-semibold">{row.name}</div>
            <div className="truncate text-[12.5px] text-muted-foreground tabular">{tickerOf(market, row.sub)} · {fmtAmount(e.vol, ccy)}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[15px] leading-snug font-semibold tabular">
              <Flash value={e.price} className="-mr-1 px-1">{fmtPrice(e.price, market)}</Flash>
            </div>
            <ChangeText value={e.chg} className="text-[12.5px] font-semibold" />
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="mr-1 max-w-full truncate text-[12px] tabular">
            <span className={opCls}>{row.op}</span>
            <span className="text-faint"> · </span>
            <span className={cn(rsiClass(row.rsi) || 'text-muted-foreground')}>RSI {rsiText(row.rsi)}</span>
            <span className="text-faint"> · </span>
            <span className={ratioClass(row.volRatio)}>거래량 {ratioText(row.volRatio)}</span>
          </span>
          {tags}
        </div>
      </div>
    </a>
  );
});
