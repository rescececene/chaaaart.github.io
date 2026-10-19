// 호가창 (보기 전용 — 주문 기능 없음)
// 업비트식 배치: 가운데 가격 · 매도 잔량은 왼쪽(파랑) · 매수 잔량은 오른쪽(빨강) · 빈 칸엔 시세 요약과 잔량 비율
import { useEffect, useMemo, useRef } from 'react';
import { BookX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBook, useQuote } from '@/hooks/market';
import { fmt, fmtAmount, fmtPct, fmtPrice, fmtSize, ccyOf } from '@/lib/format';
import { MARKETS, type Book, type BookLevel, type Market, type Sym } from '@/lib/market';
import { href } from '@/lib/router';

const LEVELS: Record<Market, number> = { upbit: 15, binance: 15, krx: 5, us: 0 };

function pctOf(p: number, prev: number | null | undefined) { return prev ? (p / prev - 1) * 100 : null; }

function PriceCell({ p, prev, current, market }: { p: number; prev: number | null | undefined; current: boolean; market: Market }) {
  const pct = pctOf(p, prev);
  const tone = pct == null || Math.round(pct * 100) === 0 ? 'text-foreground' : pct > 0 ? 'text-up-text' : 'text-down-text';
  return (
    <div className={cn('flex min-w-0 items-center justify-between gap-1 px-2 tabular', current && 'rounded-md ring-[1.5px] ring-foreground ring-inset')}>
      <span className={cn('truncate text-[13.5px] font-bold', tone)}>{fmtPrice(p, market)}</span>
      <span className={cn('shrink-0 text-[10.5px] font-medium', tone)}>{pct == null ? '' : fmtPct(pct)}</span>
    </div>
  );
}

function SizeCell({ q, max, side }: { q: number; max: number; side: 'ask' | 'bid' }) {
  const w = max ? Math.max(2, (q / max) * 100) : 0;
  return (
    <div className={cn('relative flex items-center px-2 tabular text-[12.5px] text-secondary-foreground', side === 'ask' ? 'justify-end' : 'justify-start')}>
      <span
        className={cn('absolute inset-y-[3px] rounded-[3px] transition-[width] duration-200 ease-out', side === 'ask' ? 'right-0 bg-down-soft' : 'left-0 bg-up-soft')}
        style={{ width: `${w}%` }}
      />
      <span className="relative">{fmtSize(q)}</span>
    </div>
  );
}

export function OrderBook({ sym, market, className, maxHeight }: { sym: Sym; market: Market; className?: string; maxHeight?: number | string }) {
  const book = useBook(sym);
  const q = useQuote(sym);
  const n = LEVELS[market];
  const centerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef<Sym | null>(null);
  const ready = book && 'asks' in book ? (book as Book) : null;
  const view = useMemo(() => {
    if (!ready) return null;
    const asks = ready.asks.slice(0, n), bids = ready.bids.slice(0, n);
    const max = Math.max(...asks.map((x) => x.q), ...bids.map((x) => x.q), 0);
    return { asks: asks.slice().reverse(), bids, max };
  }, [ready, n]);
  const prev = ready?.prevClose ?? q?.prevClose;
  // 처음 열 때 매도·매수 경계가 호가창 가운데 오도록 — 페이지는 건드리지 않고 호가창 안에서만 스크롤
  useEffect(() => {
    const box = scrollRef.current, mid = centerRef.current;
    if (view && scrolled.current !== sym && box && mid) {
      if (box.scrollHeight > box.clientHeight) box.scrollTop = mid.offsetTop - box.clientHeight / 2; // box 가 relative 라 offsetTop 은 box 기준
      scrolled.current = sym;
    }
  }, [view, sym]);

  if (book && 'unsupported' in book) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
        <BookX className="size-9 text-faint" />
        <p className="text-[15px] font-semibold">미국 주식은 호가를 볼 수 없어요</p>
        <p className="text-[13px] text-muted-foreground">무료로 받을 수 있는 실시간 호가가 없어서예요. 현재가와 차트는 그대로 볼 수 있어요.</p>
      </div>
    );
  }
  if (book && 'error' in book) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
        <BookX className="size-9 text-faint" />
        <p className="text-[14px] text-muted-foreground">{book.error}</p>
        <a href={href('settings')} className="text-[13px] font-semibold text-primary">설정 확인</a>
      </div>
    );
  }
  if (!view) {
    return <div className={cn('flex items-center justify-center py-16 text-muted-foreground', className)}><Loader2 className="size-5 animate-spin" /></div>;
  }
  const price = q?.price;
  const bestAsk = view.asks[view.asks.length - 1]?.p, bestBid = view.bids[0]?.p;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const tA = ready!.totalAsk ?? 0, tB = ready!.totalBid ?? 0, tot = tA + tB;
  const bidShare = tot ? (tB / tot) * 100 : 50;
  // 가격 칸을 넓게(가격 + 등락률이 한 줄에 들어가게), 잔량 칸은 좁게
  const row = 'grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.6fr)_minmax(0,0.85fr)] h-[30px]';
  const info: [string, string][] = [
    ['전일', fmtPrice(prev, market)],
    ['고가', fmtPrice(q?.high, market)],
    ['저가', fmtPrice(q?.low, market)],
    ['거래대금', fmtAmount(q?.vol, ccyOf(market))],
  ].slice(0, view.asks.length <= 5 ? 3 : 4) as [string, string][]; // 5단계(국내)는 칸이 좁아 세 개만
  const isCurrent = (lv: BookLevel) => price != null && Math.abs(lv.p - price) < 1e-12 * Math.max(1, price);
  return (
    <div className={cn('flex flex-col', className)}>
      <div ref={scrollRef} className="no-scrollbar relative overflow-y-auto" style={{ maxHeight }}>
        {/* 매도 (높은 가격 → 최우선 매도) */}
        <div className="relative">
          {view.asks.map((lv, i) => (
            <div key={'a' + i} className={row}>
              <SizeCell q={lv.q} max={view.max} side="ask" />
              <PriceCell p={lv.p} prev={prev} current={isCurrent(lv)} market={market} />
              <div />
            </div>
          ))}
          <dl className="absolute top-0 right-0 bottom-0 flex w-[26.5%] flex-col justify-end gap-1.5 overflow-hidden px-2 pb-1.5 text-[11.5px]">
            {info.map(([k, v]) => (
              <div key={k} className="flex flex-col"><dt className="text-subtle">{k}</dt><dd className="tabular font-semibold text-secondary-foreground">{v}</dd></div>
            ))}
          </dl>
        </div>
        <div ref={centerRef} className="h-px bg-border" />
        {/* 매수 (최우선 매수 → 낮은 가격) */}
        <div className="relative">
          {view.bids.map((lv, i) => (
            <div key={'b' + i} className={row}>
              <div />
              <PriceCell p={lv.p} prev={prev} current={isCurrent(lv)} market={market} />
              <SizeCell q={lv.q} max={view.max} side="bid" />
            </div>
          ))}
          <dl className="absolute top-0 bottom-0 left-0 flex w-[26.5%] flex-col gap-1.5 overflow-hidden px-2 pt-2 text-[11.5px]">
            <div className="flex flex-col"><dt className="text-subtle">스프레드</dt><dd className="tabular font-semibold text-secondary-foreground">{spread == null ? '–' : fmtPrice(spread, market)}</dd></div>
            <div className="flex flex-col"><dt className="text-subtle">{MARKETS[market].coin ? '단계' : '호가'}</dt><dd className="font-semibold text-secondary-foreground">매도·매수 각 {view.bids.length}</dd></div>
          </dl>
        </div>
      </div>
      {/* 총 잔량 비율 */}
      <div className="mt-3 border-t border-border pt-3">
        <div className="flex justify-between text-[12px] text-muted-foreground"><span>총 매도 잔량</span><span>총 매수 잔량</span></div>
        <div className="mt-1 flex justify-between text-[14px] font-bold tabular">
          <span className="text-down-text">{fmt(tA, tA >= 100 ? 0 : 3)}</span>
          <span className="text-up-text">{fmt(tB, tB >= 100 ? 0 : 3)}</span>
        </div>
        <div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`매수 잔량 비중 ${bidShare.toFixed(0)}%`}>
          <span className="rounded-l-full bg-down transition-[width] duration-300" style={{ width: `${100 - bidShare}%` }} />
          <span className="rounded-r-full bg-up transition-[width] duration-300" style={{ width: `${bidShare}%` }} />
        </div>
        <p className="mt-1.5 text-right text-[11.5px] text-subtle">매수 비중 {bidShare.toFixed(0)}%</p>
      </div>
    </div>
  );
}
