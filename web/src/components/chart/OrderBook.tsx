// 호가창 (보기 전용 — 주문 기능 없음)
// 3열 [매도 잔량 | 가격 · 전일 대비 | 매수 잔량]. 매도가 위(먼 가격이 맨 위), 매수가 아래.
// 매도 구역은 파랑, 매수 구역은 빨강으로 옅게 칠하고, 잔량 막대는 √(잔량 ÷ 보이는 단계 최대 잔량) 너비로 가격 쪽에서 바깥으로 자란다.
// 빈 칸에는 시세 정보(전일 종가·고가·저가·거래대금 / 범위 막대·호가 단위 또는 상한가·하한가)를 넣는다.
//  - scroll: PC — 모든 단계를 그리고 카드 안에서 스크롤 (처음·크기 바뀔 때 스프레드를 가운데로)
//  - fold: 휴대폰·태블릿 — 가까운 5+5 단계만, '모두 보기'로 펼친다
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookX, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBook, useQuote } from '@/hooks/market';
import { coinBase } from '@/lib/coins';
import { digits, fmt, fmtAmount, fmtPrice, fmtPriceUnit, ccyOf } from '@/lib/format';
import { cssVar } from '@/lib/theme';
import { MARKETS, type Book, type Candle, type Market, type Sym } from '@/lib/market';
import { href } from '@/lib/router';

const LEVELS: Record<Market, number> = { upbit: 15, binance: 15, krx: 5, us: 0 };
const FOLD = 5;
const MINUS = '−';

// ── 호가 단위 (계산값 반올림용) ──
/** 업비트 원화 호가 단위 (1만 원 이상 구간) */
const upbitTick = (p: number) => (p >= 2e6 ? 1000 : p >= 1e6 ? 500 : p >= 5e5 ? 100 : p >= 1e5 ? 50 : p >= 1e4 ? 10 : 0);
/** 국내 주식 호가 단위 (2023년 이후) */
export const krxTick = (p: number) => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
/** 이동평균·볼린저처럼 계산한 가격을 호가 단위로 반올림 (110,455,400 → 110,455,000). 단위를 모르는 시장은 그대로 */
export function roundTick(p: number, market: Market): number {
  if (!Number.isFinite(p)) return p;
  const t = market === 'krx' ? krxTick(p) : market === 'upbit' ? upbitTick(p) : 0;
  return t ? Math.round(p / t) * t : p;
}

const pctOf = (p: number, prev: number | null | undefined) => (prev ? (p / prev - 1) * 100 : null);
/** 부호 값 '+0.22%' · '−0.10%' (호가 %·괴리율 — ▲ 없이 방향색) */
const sgnPct = (x: number, d = 2) => { const r = Math.round(x * 10 ** d) / 10 ** d; return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(d)}%`; };
const toneOf = (x: number | null | undefined) => (x == null || Math.round(x * 100) === 0 ? 'flat' : x > 0 ? 'up' : 'down');
const TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-secondary-foreground' } as const;
/** 잔량 — 국내·미국은 정수, 코인은 소수 4자리(큰 수량은 줄여서) */
function fmtQ(q: number, coin: boolean) {
  if (!coin) return fmt(q, 0);
  return q >= 1e4 ? fmt(q, 0) : q >= 100 ? fmt(q, 2) : fmt(q, 4);
}
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 범위 막대 — 4px 회색 트랙 위 현재 위치 점 */
export function RangeDot({ lo, hi, v, className, label }: { lo: number; hi: number; v: number; className?: string; label: string }) {
  const x = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 100 : 50;
  return (
    <span role="img" aria-label={label} className={cn('relative mx-[5px] block h-1 rounded-full bg-border', className)}>
      <i className="absolute top-1/2 -mt-[5px] -ml-[5px] size-2.5 rounded-full bg-foreground shadow-[0_0_0_2px_var(--card)]" style={{ left: `${x}%` }} />
    </span>
  );
}

/** 가까운 날의 가격 범위 (일봉 days 개) */
function rangeOf(daily: Candle[] | null | undefined, days: number) {
  if (!daily || daily.length < 20) return null;
  const xs = daily.slice(-days);
  let hi = -Infinity, lo = Infinity;
  for (const c of xs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
  return hi > lo ? { hi, lo } : null;
}

function SizeCell({ p, q, w, side, coin, style }: { p: number; q: number; w: number; side: 'ask' | 'bid'; coin: boolean; style: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef({ p, q });
  useEffect(() => {
    // 같은 가격의 잔량이 바뀐 칸만 0.5초 동안 옅은 테가 사라진다 (호가가 한 칸씩 밀릴 때는 깜빡이지 않게)
    const was = prev.current;
    if (was.p === p && was.q !== q && ref.current && !reduceMotion() && typeof ref.current.animate === 'function') {
      const c = cssVar('--faint') || '#b0b8c1';
      ref.current.animate([{ boxShadow: `inset 0 0 0 1px ${c}` }, { boxShadow: 'inset 0 0 0 1px transparent' }], { duration: 500, easing: 'ease-out' });
    }
    prev.current = { p, q };
  }, [p, q]);
  return (
    <div ref={ref} style={style}
      className={cn('relative flex min-w-0 items-center overflow-hidden px-2.5 text-[13px] font-medium whitespace-nowrap text-secondary-foreground tabular',
        side === 'ask' ? 'justify-end rounded-l-lg bg-down/6 dark:bg-down/9' : 'justify-start rounded-r-lg bg-up/6 dark:bg-up/9')}>
      <i aria-hidden
        className={cn('absolute inset-y-1 w-full transition-transform duration-[250ms] ease-out motion-reduce:transition-none',
          side === 'ask' ? 'right-0 origin-right rounded-l-[4px] bg-down/16 dark:bg-down/24' : 'left-0 origin-left rounded-r-[4px] bg-up/16 dark:bg-up/24')}
        style={{ transform: `scaleX(${w})` }} />
      <span className="relative">{fmtQ(q, coin)}</span>
    </div>
  );
}

function PriceCell({ p, prev, current, market, side, long, style }: {
  p: number; prev: number | null | undefined; current: boolean; market: Market; side: 'ask' | 'bid'; long: boolean; style: React.CSSProperties;
}) {
  const pct = pctOf(p, prev);
  const t = TONE[toneOf(pct)];
  return (
    <div style={style} aria-current={current ? 'true' : undefined}
      className={cn('flex min-w-0 items-center justify-end gap-1.5 px-2 tabular whitespace-nowrap',
        side === 'ask' ? 'rounded-r-lg bg-down/6 dark:bg-down/9' : 'rounded-l-lg bg-up/6 dark:bg-up/9',
        current && 'rounded-lg ring-[1.5px] ring-foreground ring-inset')}>
      <b className={cn('min-w-0 truncate text-[14px] @max-[340px]:text-[13.5px]', current ? 'font-bold' : 'font-semibold', t)}>{fmtPrice(p, market)}</b>
      <em className={cn('w-11 shrink-0 text-right text-[11px] font-semibold @max-[296px]:hidden', long && '@max-[320px]:hidden', t)}>{pct == null ? '' : sgnPct(pct)}</em>
    </div>
  );
}

function Info({ items, className, style }: { items: [string, React.ReactNode, string?][]; className?: string; style: React.CSSProperties }) {
  return (
    <dl style={style} className={cn('flex min-w-0 flex-col gap-1.5 overflow-hidden py-0.5 @max-[268px]:invisible', className)}>
      {items.map(([k, v, tone]) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-[11.5px] leading-[15px] font-medium text-muted-foreground @max-[320px]:text-[11px]">{k}</dt>
          <dd className={cn('text-[12px] leading-4 font-semibold tabular whitespace-nowrap @max-[320px]:text-[11px]', tone ?? 'text-foreground')}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BookSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-x-[2px] gap-y-1 py-2" aria-label="호가 불러오는 중">
      {Array.from({ length: 30 }).map((_, i) => {
        const row = Math.floor(i / 3), col = i % 3;
        const hidden = row < 5 ? col === 2 : col === 0;
        return <i key={i} className={cn('h-6 animate-pulse rounded-lg bg-secondary', hidden && 'invisible')} />;
      })}
    </div>
  );
}

export function OrderBook({ sym, market, className, mode = 'fold', daily }: {
  sym: Sym; market: Market; className?: string;
  /** scroll: 모든 단계 + 카드 안 스크롤 (PC) · fold: 5+5 단계 + 펼치기 (휴대폰·태블릿) */
  mode?: 'scroll' | 'fold';
  /** 일봉 (범위 막대 — 200일 · 52주 · 250일). 없으면 그 칸은 빠진다 */
  daily?: Candle[] | null;
}) {
  const book = useBook(sym);
  const q = useQuote(sym);
  const coin = MARKETS[market].coin;
  const n = LEVELS[market];
  const [open, setOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const centered = useRef<Sym | null>(null);
  const ready = book && 'asks' in book ? (book as Book) : null;
  const shown = mode === 'fold' && !open ? Math.min(FOLD, n) : n;
  const view = useMemo(() => {
    if (!ready) return null;
    const asks = ready.asks.slice(0, shown), bids = ready.bids.slice(0, shown);
    const max = Math.max(...asks.map((x) => x.q), ...bids.map((x) => x.q), 0);
    // 호가 단위 — 이웃한 가격 차이 중 가장 작은 값
    let tick = Infinity;
    const all = ready.asks.slice(0, n);
    for (let i = 1; i < all.length; i++) { const d = all[i].p - all[i - 1].p; if (d > 0 && d < tick) tick = d; }
    return { asks: asks.slice().reverse(), bids, max, tick: Number.isFinite(tick) ? tick : null, more: Math.min(ready.asks.length, n) > shown };
  }, [ready, shown, n]);
  const prev = ready?.prevClose ?? q?.prevClose;

  // 스프레드를 가운데로 — 처음 열 때와 크기가 바뀔 때 (호가창 안에서만 스크롤)
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (mode !== 'scroll' || !box) return;
    const center = () => {
      const mid = centerRef.current;
      if (mid && box.scrollHeight > box.clientHeight) box.scrollTop = mid.offsetTop - box.clientHeight / 2;
    };
    if (view && centered.current !== sym) { center(); centered.current = sym; }
    const ro = new ResizeObserver(center);
    ro.observe(box);
    return () => ro.disconnect();
  }, [mode, sym, !!view]); // eslint-disable-line react-hooks/exhaustive-deps

  if (book && 'unsupported' in book) return <NoBook sym={sym} market={market} daily={daily} className={className} />;
  if (book && 'error' in book) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
        <span className="flex size-14 items-center justify-center rounded-full bg-secondary"><BookX className="size-6 text-muted-foreground" /></span>
        <p className="text-[17px] font-bold">호가를 볼 수 없어요</p>
        <p className="max-w-[300px] text-[14px] text-muted-foreground">{book.error}</p>
        <a href={href('settings')} className="mt-1 text-[14px] font-semibold text-foreground underline-offset-2 hover:underline">설정에서 중계 확인하기</a>
      </div>
    );
  }
  if (!view) return <div className={className}><BookSkeleton /></div>;

  const price = q?.price;
  const bestAsk = view.asks[view.asks.length - 1]?.p, bestBid = view.bids[0]?.p;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const sumQ = (xs: { q: number }[]) => xs.reduce((s, x) => s + x.q, 0);
  const tA = ready!.totalAsk ?? sumQ(ready!.asks), tB = ready!.totalBid ?? sumQ(ready!.bids), tot = tA + tB;
  const bidShare = tot ? Math.round((tB / tot) * 100) : 50;
  const unit = coin ? coinBase(sym) ?? '' : '주';
  const long = (fmtPrice(bestAsk ?? price ?? 0, market).length) >= 10;
  const cols = long ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]';
  const rowH = market === 'krx' ? 30 : 32;
  const isCurrent = (p: number) => price != null && Math.abs(p - price) < 1e-12 * Math.max(1, price);
  const sq = (x: number) => (view.max ? Math.sqrt(x / view.max) : 0);
  const pf = (x: number | null | undefined) => (x == null ? '–' : fmtPrice(x, market));
  const vsPrev = (x: number | null | undefined) => TONE[toneOf(x != null && prev ? (x / prev - 1) * 100 : null)];
  // 호가 단위·스프레드는 가격과 같은 자릿수로 (0.01 USDT · 1,000원)
  const dgP = digits(bestBid ?? price ?? 0, market);
  const pStep = (x: number) => { const t = fmt(x, dgP); return market === 'us' ? '$' + t : t + (market === 'binance' ? ' USDT' : '원'); };

  // 매도 쪽 빈 칸 — 전일 종가 · 고가 · 저가 · 거래대금
  const askInfo: [string, React.ReactNode, string?][] = [
    [market === 'binance' ? '24시간 전' : '전일 종가', pf(prev)],
    ['고가', pf(q?.high), vsPrev(q?.high)],
    ['저가', pf(q?.low), vsPrev(q?.low)],
    ['거래대금', fmtAmount(q?.vol, ccyOf(market))],
  ];
  // 매수 쪽 빈 칸 — 코인: 오늘 범위 · 200일 범위 · 호가 단위 / 국내: 상한가 · 하한가 · 52주 범위
  const bidInfo: [string, React.ReactNode, string?][] = [];
  const cur = price ?? bestBid ?? null;
  const rg = rangeOf(daily, market === 'krx' ? 250 : 200);
  if (coin) {
    if (q?.high != null && q.low != null && cur != null) bidInfo.push(['오늘 범위', <RangeDot key="d" lo={q.low} hi={q.high} v={cur} className="mt-1.5 mb-1" label={`오늘 저가 ${pf(q.low)} ~ 고가 ${pf(q.high)} 중 현재 위치`} />]);
    if (rg && cur != null) {
      bidInfo.push(['200일 범위', <>
        <RangeDot lo={rg.lo} hi={rg.hi} v={cur} className="mt-1.5 mb-1" label={`200일 최저 ${pf(rg.lo)} ~ 최고 ${pf(rg.hi)} 중 현재 위치`} />
        <small className="block text-[11px] leading-[14px] font-medium whitespace-normal text-muted-foreground">최고가 대비 {sgnPct((cur / rg.hi - 1) * 100, 1)}</small>
      </>]);
    }
    if (view.tick != null) bidInfo.push(['호가 단위', pStep(view.tick)]);
  } else {
    const base = prev ? Math.round(prev) : null;
    if (base) {
      const up = base * 1.3, dn = base * 0.7;
      bidInfo.push(['상한가', pf(Math.floor(up / krxTick(up)) * krxTick(up)), TONE.up]);
      bidInfo.push(['하한가', pf(Math.ceil(dn / krxTick(dn)) * krxTick(dn)), TONE.down]);
    }
    if (rg && cur != null) {
      bidInfo.push(['52주 범위', <>
        <RangeDot lo={rg.lo} hi={rg.hi} v={cur} className="mt-1.5 mb-1" label={`52주 최저 ${pf(rg.lo)} ~ 최고 ${pf(rg.hi)} 중 현재 위치`} />
        <small className="block text-[11px] leading-[14px] font-medium whitespace-normal text-muted-foreground">최고가 대비 {sgnPct((cur / rg.hi - 1) * 100, 1)}</small>
      </>]);
    }
  }

  const na = view.asks.length, nb = view.bids.length;
  const at = (row: number, col: number): React.CSSProperties => ({ gridRow: row, gridColumn: col });
  const table = (
    <div className="@container">
      <div className={cn('grid gap-x-[2px]', cols)} style={{ gridAutoRows: rowH, rowGap: 2 }}>
        {view.asks.map((lv, i) => [
          <SizeCell key={'aq' + i} p={lv.p} q={lv.q} w={sq(lv.q)} side="ask" coin={coin} style={at(i + 1, 1)} />,
          <PriceCell key={'ap' + i} p={lv.p} prev={prev} current={isCurrent(lv.p)} market={market} side="ask" long={long} style={at(i + 1, 2)} />,
        ])}
        {na ? <Info items={askInfo} className="justify-end pl-2.5" style={{ gridColumn: 3, gridRow: `1 / span ${na}` }} /> : null}
      </div>
      <div ref={centerRef} className="h-[2px]" />
      <div className={cn('grid gap-x-[2px]', cols)} style={{ gridAutoRows: rowH, rowGap: 2 }}>
        {view.bids.map((lv, i) => [
          <PriceCell key={'bp' + i} p={lv.p} prev={prev} current={isCurrent(lv.p)} market={market} side="bid" long={long} style={at(i + 1, 2)} />,
          <SizeCell key={'bq' + i} p={lv.p} q={lv.q} w={sq(lv.q)} side="bid" coin={coin} style={at(i + 1, 3)} />,
        ])}
        {nb && bidInfo.length ? <Info items={bidInfo} className="justify-start pr-2.5" style={{ gridColumn: 1, gridRow: `1 / span ${nb}` }} /> : null}
      </div>
    </div>
  );

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* 열 머리 */}
      <div className={cn('@container grid h-7 shrink-0 items-center gap-x-[2px] text-[12px] font-semibold whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]', cols)}>
        <span className="truncate pr-2.5 text-right">매도 잔량</span>
        <span className="truncate text-center">가격<span className="@max-[340px]:hidden"> · 전일 대비</span></span>
        <span className="truncate pl-2.5">매수 잔량</span>
      </div>
      {mode === 'scroll' ? (
        <div ref={scrollRef}
          className="no-scrollbar relative mt-1.5 min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,#000_16px,#000_calc(100%-16px),transparent)]">
          <div className="flex min-h-full flex-col py-3"><div className="my-auto">{table}</div></div>
        </div>
      ) : (
        <div className="mt-1.5">
          {table}
          {view.more || open ? (
            <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="press mt-2 flex h-11 w-full items-center justify-center gap-1 rounded-xl text-[14px] font-semibold text-secondary-foreground hover:bg-hover">
              {open ? '가까운 5단계만 보기' : `${Math.min(ready!.asks.length, n)}단계 모두 보기`}
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </button>
          ) : null}
        </div>
      )}
      {/* 아래 요약 — 잔량 비율 · 총 잔량 · 스프레드 */}
      <div className="mt-3 shrink-0 pt-3.5 shadow-[inset_0_1px_0_var(--border)]">
        <div className="flex items-center gap-2 text-[12px] font-semibold whitespace-nowrap tabular" role="img" aria-label={`매도 ${100 - bidShare}% · 매수 ${bidShare}%`}>
          <span className="text-down-text">매도 {100 - bidShare}%</span>
          <span className="flex h-1.5 min-w-10 flex-1 gap-[2px]">
            <i className="rounded-full bg-down transition-[flex-grow] duration-300" style={{ flexGrow: 100 - bidShare }} />
            <i className="rounded-full bg-up transition-[flex-grow] duration-300" style={{ flexGrow: bidShare }} />
          </span>
          <span className="text-up-text">{bidShare}% 매수</span>
        </div>
        <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 tabular">
          <div className="min-w-0"><dt className="text-[12px] text-muted-foreground">총 매도 잔량</dt><dd className="truncate text-[15px] font-bold">{fmtQ(tA, coin)}<small className="ml-0.5 text-[12px] font-semibold text-muted-foreground">{unit}</small></dd></div>
          <div className="text-center"><dt className="text-[12px] text-muted-foreground">스프레드</dt>
            <dd className="text-[14px] font-semibold whitespace-nowrap">{spread == null ? '–' : pStep(spread)}
              {spread != null && bestBid ? <small className="ml-0.5 text-[12px] font-medium text-muted-foreground">({spread / bestBid * 100 < 0.001 ? '0.001% 미만' : `${(spread / bestBid * 100).toFixed(3)}%`})</small> : null}
            </dd>
          </div>
          <div className="min-w-0 text-right"><dt className="text-[12px] text-muted-foreground">총 매수 잔량</dt><dd className="truncate text-[15px] font-bold">{fmtQ(tB, coin)}<small className="ml-0.5 text-[12px] font-semibold text-muted-foreground">{unit}</small></dd></div>
        </dl>
      </div>
    </div>
  );
}

/** 미국 주식 — 호가 대신 가격 범위로 지금 위치 */
function NoBook({ sym, market, daily, className }: { sym: Sym; market: Market; daily?: Candle[] | null; className?: string }) {
  const q = useQuote(sym);
  const cur = q?.price ?? daily?.[daily.length - 1]?.c ?? null;
  const rg = rangeOf(daily, 250);
  const pu = (x: number | null | undefined) => fmtPriceUnit(x, market);
  const bar = (title: string, lo: number, hi: number, extra?: string) => cur == null ? null : (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-semibold text-secondary-foreground">{title}</span>
        <span className="text-muted-foreground tabular">현재 <b className="font-semibold text-foreground">{pu(cur)}</b></span>
      </div>
      <RangeDot lo={lo} hi={hi} v={cur} className="mt-2.5 mb-2" label={`${title}: 저가 ${pu(lo)} ~ 고가 ${pu(hi)}`} />
      <div className="flex justify-between gap-2 text-[12px] font-semibold tabular">
        <span className="text-down-text">저가 {pu(lo)}</span>
        {extra ? <span className="text-muted-foreground">{extra}</span> : null}
        <span className="text-up-text">고가 {pu(hi)}</span>
      </div>
    </div>
  );
  return (
    <div className={cn('py-2', className)}>
      <div className="flex items-start gap-3.5 sm:flex-col sm:items-center sm:text-center">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-secondary"><BookX aria-hidden className="size-6 text-muted-foreground" /></span>
        <div className="min-w-0">
          <p className="text-[17px] font-bold">미국 주식은 호가를 볼 수 없어요</p>
          <p className="mt-1 max-w-[320px] text-[14px] leading-[1.5] text-muted-foreground">무료로 받을 수 있는 미국 주식 실시간 호가가 없어요. 대신 가격 범위로 지금 위치를 보여 드려요.</p>
        </div>
      </div>
      {cur != null && ((q?.high != null && q.low != null) || rg) ? (
        <div className="mt-5 space-y-5 rounded-[14px] bg-[var(--tile,var(--hover))] p-4">
          {q?.high != null && q.low != null ? bar('오늘 가격 범위', q.low, q.high) : null}
          {rg ? bar('250일 가격 범위', rg.lo, rg.hi, `최고가 대비 ${sgnPct((cur / rg.hi - 1) * 100, 1)}`) : null}
        </div>
      ) : null}
    </div>
  );
}
