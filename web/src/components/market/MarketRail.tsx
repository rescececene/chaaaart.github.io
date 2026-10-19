// 시장 목록 오른쪽 레일 (≥1240px) — 상승·하락 종목 수, 관심 종목
import { memo, useEffect, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { CARD_CLS } from '@/components/common/Card';
import { ChangeText } from '@/components/common/Change';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { useNamesVersion, useQuote, useWant } from '@/hooks/market';
import { tickerOf } from '@/lib/coins';
import { loadStaticStocks, MARKETS, nameOf, split, type Sym } from '@/lib/market';
import { href } from '@/lib/router';
import { cn } from '@/lib/utils';
import { distinctWatch, watchStore } from '@/stores';
import { priceText } from './shared';

const RAIL_CARD = cn(CARD_CLS, 'p-5');
const H2 = 'text-[17px] font-bold tracking-[-0.02em]';

/** 상승·하락 종목 — 빨강·회색·파랑 3칸 막대 + ▲상승 · 보합 · ▼하락 */
export function BreadthCard({ up, flat, down, caption }: { up: number; flat: number; down: number; caption: string }) {
  const total = up + flat + down || 1;
  const seg = (n: number, cls: string) => (n > 0 ? <i className={cn('block h-full first:rounded-l-full last:rounded-r-full', cls)} style={{ width: `${(n / total) * 100}%` }} /> : null);
  return (
    <section className={RAIL_CARD} aria-label="상승·하락 종목 수">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className={H2}>상승·하락 종목</h2>
        <span className="text-[13px] text-muted-foreground tabular">{caption}</span>
      </div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {seg(up, 'bg-up')}{seg(flat, 'bg-faint')}{seg(down, 'bg-down')}
      </div>
      <div className="mt-2.5 flex justify-between text-[13px] font-semibold text-secondary-foreground tabular">
        <span className="relative text-up-text"><span aria-hidden className="relative top-[-0.08em] mr-[2px] text-[0.72em]">▲</span>상승 {up}</span>
        <span>보합 {flat}</span>
        <span className="relative text-down-text"><span aria-hidden className="relative top-[-0.08em] mr-[2px] text-[0.72em]">▼</span>하락 {down}</span>
      </div>
    </section>
  );
}

const WatchRow = memo(function WatchRow({ sym }: { sym: Sym }) {
  useNamesVersion();
  const q = useQuote(sym);
  const [market] = split(sym);
  const n = nameOf(sym);
  return (
    <li>
      <a href={href('chart', sym)} className="-mx-2 grid h-14 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-xl px-2 transition-colors hover:bg-hover">
        <SymbolLogo sym={sym} size={32} />
        <span className="flex min-w-0 flex-col">
          <b className="truncate text-[15px] leading-[21px] font-semibold">{n.name}</b>
          <span className="truncate text-[12.5px] leading-[17px] text-muted-foreground">{MARKETS[market].name} · {tickerOf(market, n.sub)}</span>
        </span>
        <span className="flex flex-col items-end">
          <b className="text-[15px] leading-[21px] font-semibold whitespace-nowrap tabular">{q ? priceText(q.price, market) : '–'}</b>
          <ChangeText value={q?.chg} className="text-[13px] leading-[17px] font-semibold" />
        </span>
      </a>
    </li>
  );
});

/** 관심 종목 — 코인만 실시간으로 받고(거래소 웹소켓), 주식은 지금 탭이 받고 있는 시세나 10분 단위 정적 시세를 쓴다 (중계 호출을 늘리지 않게) */
export function WatchRail({ limit = 8 }: { limit?: number }) {
  const all = watchStore.use();
  const list = useMemo(() => distinctWatch(all).slice(0, limit).map((w) => w.sym), [all, limit]);
  const coins = useMemo(() => list.filter((s) => MARKETS[split(s)[0]].coin), [list]);
  useWant(coins.length ? coins : null);
  const hasStock = list.length > coins.length;
  useEffect(() => { if (hasStock) void loadStaticStocks(); }, [hasStock]);
  return (
    <section className={RAIL_CARD} aria-label="관심 종목">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 className={H2}>관심 종목</h2>
        {list.length ? <a href={href('market', 'watch')} className="inline-flex items-center text-[14px] font-semibold text-muted-foreground hover:text-foreground">편집<ChevronRight className="size-4" aria-hidden /></a> : null}
      </div>
      {list.length ? (
        <ul>{list.map((s) => <WatchRow key={s} sym={s} />)}</ul>
      ) : (
        <p className="py-3 text-[14px] leading-[1.5] text-muted-foreground">목록에서 ☆를 누르면 여기에 모여요</p>
      )}
    </section>
  );
}
