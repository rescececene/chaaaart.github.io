// 시장 — 관심 · 코인 · 국내주식 · 미국주식 목록
// 코인은 한 탭이고 거래소는 그 아래 [업비트 · 원화 | 바이낸스 · USDT] 로만 고른다.
//   주소: #/market/upbit · #/market/binance (그 거래소) · #/market/coin (마지막으로 고른 거래소 — ml.coinEx)
// 성능: 줄마다 자기 시세만 구독(MarketRow) · 정렬은 약 1초마다(useQuotesTick) · 처음엔 40줄만 그리고 나머지는 이어서(transition)
import { startTransition, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, RotateCw, Search, Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { Empty, RowSkeleton } from '@/components/common/Card';
import { Chip, UnderlineTabs } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { CoinExSwitch, VenueBadges } from '@/components/market/CoinVenues';
import { MarketRow } from '@/components/market/MarketRow';
import { GRID, ROW_GRID } from '@/components/market/shared';
import {
  CHIPS, chipOn, chipReversed, clearSpot, isTab, loadSorts, makeRanker, nextHeadSort, peekSpot, restoreSpot, sortOf, sortSyms,
  type Sort, type SortKey, type Tab,
} from '@/components/market/sort';
import { useNamesVersion, useQuotesTick, useRelay, useStockError, useWant } from '@/hooks/market';
import { coinKey, isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, type CoinEx } from '@/lib/coins';
import { dirShown } from '@/lib/format';
import { binanceTop, FX, getQuote, listOrder, loadCoins, MARKETS, overview, refreshKimpRef, search, Store, upbitCodes, type Sym } from '@/lib/market';
import { href, navigate } from '@/lib/router';
import { distinctWatch, watchStore } from '@/stores';

/** 맨 위 탭 — 코인 탭 안에서 거래소(업비트·바이낸스)를 다시 고른다 */
type Top = 'watch' | 'coin' | 'krx' | 'us';
const topOf = (t: Tab): Top => (isCoinEx(t) ? 'coin' : t);
const TAB_NAME: Record<Tab, string> = { upbit: '업비트', binance: '바이낸스', krx: '국내주식', us: '미국주식', watch: '관심 종목' };
const TOP_ITEMS: { value: Top; label: ReactNode }[] = [
  { value: 'watch', label: <span className="inline-flex items-center gap-1"><Star className="size-[15px] fill-current text-warn" />관심</span> },
  { value: 'coin', label: '코인' },
  { value: 'krx', label: '국내주식' },
  { value: 'us', label: '미국주식' },
];
const FIRST_ROWS = 40;

/** 주소에 탭이 없으면 마지막으로 본 탭 — 코인이면 거래소는 따로 기억한 쪽(다른 화면에서 바꿨을 수도 있다) */
function storedTab(): Tab {
  const t = Store.get<unknown>('ml.mkt', 'upbit');
  return isTab(t) && !isCoinEx(t) ? t : storedCoinEx();
}
const tabFromArg = (arg: string | undefined): Tab => (arg === 'coin' ? storedCoinEx() : isTab(arg) ? arg : storedTab());

/** 고정 머리(헤더) 높이 — PC 표 머리줄을 그 아래에 붙인다 */
function useStickyTop() {
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const el = document.querySelector('header');
    if (!el) return;
    const update = () => setTop(Math.round(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return top;
}

export default function MarketPage({ args }: PageProps) {
  const tab: Tab = tabFromArg(args[0]);
  const top = topOf(tab);
  const stock = tab === 'krx' || tab === 'us';
  const coin = isCoinEx(tab);
  useEffect(() => {
    Store.set('ml.mkt', tab);
    if (isCoinEx(tab)) saveCoinEx(tab);
    document.title = `${TAB_NAME[tab]}${isCoinEx(tab) ? ' 코인' : ''} 시세 — 마켓렌즈`;
    return () => { document.title = '마켓렌즈'; };
  }, [tab]);
  useEffect(() => { if (isCoinEx(tab)) settleCoinArg('market', args, tab); }, [args, tab]);

  const watch = watchStore.use();
  const namesV = useNamesVersion();
  const { ok: relayOk } = useRelay();
  const stockErr = useStockError();
  // 코인 목록(coins.json)이 왔는가 — 다른 화면의 쿼리와 섞이지 않게 이 화면 전용 키
  const coinsReady = !!useQuery({ queryKey: ['market-page', 'coins-ready'], queryFn: async () => { await loadCoins(); return true; }, staleTime: Infinity, gcTime: Infinity }).data;

  // ── 구독: 시장 탭은 '<시장>:*', 관심 탭은 담은 종목만 (코인 목록이 와야 '*' 를 풀 수 있다) ──
  // 관심 탭에서 같은 코인은 한 줄 (업비트·바이낸스로 둘 다 담겨 있으면 먼저 담은 쪽), ★는 어느 거래소로 담았든 켜진다
  const watchSyms = useMemo(() => distinctWatch(watch).map((w) => w.sym), [watch]);
  const watchSet = useMemo(() => new Set(watchSyms), [watchSyms]);
  const watchKeys = useMemo(() => new Set(watch.map((w) => coinKey(w.sym))), [watch]);
  useWant(tab === 'watch' ? watchSyms : coin && !coinsReady ? null : [tab + ':*']);
  const tick = useQuotesTick(1000, (changed) => {
    if (tab === 'watch') { for (const s of changed) if (watchSet.has(s)) return true; return false; }
    for (const s of changed) if (s.startsWith(tab + ':')) return true;
    return false;
  });

  // ── 김프: 바이낸스 기준가(20초마다)와 환율(상단 지수 띠와 같은 요청)이 바뀌면 다시 계산 ──
  const kimpOn = tab === 'upbit' && coinsReady;
  const [kimpV, setKimpV] = useState(0);
  useEffect(() => {
    if (!kimpOn) return;
    let alive = true;
    const run = () => { void refreshKimpRef().then(() => { if (alive) setKimpV((v) => v + 1); }); };
    run();
    const id = setInterval(() => { if (!document.hidden) run(); }, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [kimpOn]);
  const fxData = useQuery({ queryKey: ['overview', relayOk], queryFn: overview, staleTime: 10_000, enabled: tab === 'upbit' }).data;
  const kimpKey = tab === 'upbit' ? `${kimpV}:${fxData ? FX.usd ?? '' : ''}` : '';

  // ── 정렬 (탭마다 기억 — ml.mktSort) ──
  const [sorts, setSorts] = useState(loadSorts);
  const sort = sortOf(sorts, tab);
  const setSort = (s: Sort | null) => {
    const next = { ...sorts, [tab]: s };
    setSorts(next);
    Store.set('ml.mktSort', next);
  };

  // ── 종목 목록 → 정렬 → 순위 ──
  // 누르는 순간 줄이 자리를 바꾸면 엉뚱한 종목이 열리므로, 누르고 있는 동안(+잠깐)은 순서를 고정한다
  const holdUntil = useRef(0);
  const last = useRef<{ key: string; order: Sym[] } | null>(null);
  const order = useMemo(() => {
    let syms: Sym[];
    if (tab === 'watch') syms = watchSyms;
    else if (tab === 'upbit') syms = coinsReady ? upbitCodes().map((c) => 'upbit:' + c) : [];
    else if (tab === 'binance') syms = coinsReady ? binanceTop().map((s) => 'binance:' + s) : [];
    else syms = listOrder[tab];
    if (tab !== 'watch') syms = syms.filter((s) => getQuote(s)?.price != null);
    const key = `${tab}|${sort?.k}|${sort?.d}|${syms.length}|${namesV}|${watchSyms.join(',')}`;
    if (last.current && last.current.key === key && performance.now() < holdUntil.current) return last.current.order;
    const sorted = sortSyms(syms, sort);
    last.current = { key, order: sorted };
    return sorted;
    // tick·kimpV 는 시세·김프가 바뀌었다는 신호 (값은 getQuote 로 읽는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, coinsReady, watchSyms, sort?.k, sort?.d, tick, kimpV, namesV]);

  // ── 목록 안 찾기 ──
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const dq = useDeferredValue(query.trim());
  const ranker = useMemo(() => makeRanker(dq), [dq, namesV]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    if (!ranker) return order.map((sym, i) => ({ sym, rank: i + 1 }));
    // 찾을 때는 똑같은 이름·코드 → 앞부분 일치 → 포함 순 (순위 번호는 원래 목록 기준 그대로)
    const hits: { sym: Sym; rank: number; g: number }[] = [];
    order.forEach((sym, i) => { const g = ranker(sym); if (g >= 0) hits.push({ sym, rank: i + 1, g }); });
    return hits.sort((a, b) => a.g - b.g);
  }, [order, ranker]);
  // 이 목록에 없으면 다른 시장까지 찾아 준다 (상단 검색과 같은 결과)
  const noMatch = !!ranker && order.length > 0 && rows.length === 0;
  const others = useQuery({ queryKey: ['search', dq], queryFn: () => search(dq), enabled: noMatch, staleTime: 60_000 });

  // ── 요약: 상승·하락 수, 실시간 여부 ──
  const stats = useMemo(() => {
    let up = 0, down = 0, live = 0, open = 0;
    for (const s of order) {
      const q = getQuote(s);
      if (!q) continue;
      const d = dirShown(q.chg);
      if (d === 'up') up++; else if (d === 'down') down++;
      if (q.live) { live++; if (q.status !== 'CLOSE') open++; }
    }
    return { up, down, flat: order.length - up - down, live, open, total: order.length };
  }, [order]);
  const liveState: 'live' | 'closed' | 'delayed' | null = !stats.total ? null : !stats.live ? 'delayed' : stock && !stats.open ? 'closed' : 'live';
  const markDelay = stats.live > 0 && stats.live < stats.total;
  const metric: 'vol' | 'cap' = stock && sort?.k !== 'vol' ? 'cap' : 'vol';

  // ── 처음엔 FIRST_ROWS 줄만, 다음 프레임에 나머지 (탭 전환이 바로 반응하도록) ──
  const stage = `${tab}:${order.length > 0 ? 1 : 0}`;
  const [fullStage, setFullStage] = useState<string | null>(null);
  const full = fullStage === stage;
  useEffect(() => {
    if (full) return;
    const id = requestAnimationFrame(() => startTransition(() => setFullStage(stage)));
    return () => cancelAnimationFrame(id);
  }, [full, stage]);
  const shown = full || ranker ? rows : rows.slice(0, FIRST_ROWS);

  // ── 차트를 보고 돌아오면 보던 자리로 (이 화면에 들어올 때 한 번만 — 다른 탭에서 남긴 자리는 버린다) ──
  const hasRows = rows.length > 0;
  const spotDone = useRef(false);
  useEffect(() => {
    if (spotDone.current || !full || !hasRows) return;
    const spot = peekSpot(tab);
    if (!spot) { spotDone.current = true; clearSpot(); return; }
    const id = requestAnimationFrame(() => { spotDone.current = true; restoreSpot(spot); clearSpot(); });
    return () => cancelAnimationFrame(id);
  }, [full, hasRows, tab]);

  // ── 오래 걸리면 안내 ──
  const [slowTab, setSlowTab] = useState<Tab | null>(null);
  const empty = order.length === 0;
  useEffect(() => {
    if (!empty) return;
    const t = setTimeout(() => setSlowTab(tab), 12_000);
    return () => clearTimeout(t);
  }, [empty, tab]);

  const stickyTop = useStickyTop();
  // 코인 탭을 누르면 마지막으로 고른 거래소로, 거래소를 바꾸면 그 주소로 (#/market/upbit · #/market/binance)
  const goTop = (t: Top) => { if (t !== top) navigate('market', t === 'coin' ? storedCoinEx() : t); };
  const goEx = (ex: CoinEx) => { if (ex !== tab) { saveCoinEx(ex); navigate('market', ex); } };
  const onHeadSort = (k: SortKey) => setSort(nextHeadSort(k, sort));
  // Enter — 가장 잘 맞는 종목의 차트로 (빨리 치고 바로 누르면 아직 늦게 따라오는 목록 대신 지금 입력값으로 고른다)
  const openFirst = () => {
    const q = query.trim();
    let sym: Sym | undefined;
    if (q === dq) sym = rows[0]?.sym;
    else {
      const rank = makeRanker(q);
      let best = 3;
      if (rank) for (const s of order) { const g = rank(s); if (g >= 0 && g < best) { best = g; sym = s; if (g === 0) break; } }
    }
    sym ??= q === dq ? others.data?.[0]?.sym : undefined;
    if (sym) navigate('chart', sym);
  };
  const clearQuery = () => { setQuery(''); setSearchOpen(false); };

  const searchField = (mobile: boolean) => (
    <div className={cn('relative', mobile ? 'w-full' : 'w-64')}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
      <input
        type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={mobile}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); openFirst(); }
          else if (e.key === 'Escape') { e.preventDefault(); clearQuery(); (e.target as HTMLInputElement).blur(); }
        }}
        placeholder={`${TAB_NAME[tab]}에서 찾기`} aria-label="목록에서 종목 찾기" enterKeyHint="go" autoComplete="off" spellCheck={false}
        className="h-10 w-full rounded-xl bg-secondary pr-9 pl-9 text-[16px] text-foreground outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-ring/40 lg:text-[14px] [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button type="button" onClick={() => setQuery('')} aria-label="지우기" className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-faint/60 text-card">
          <X className="size-3.5" strokeWidth={3} />
        </button>
      )}
    </div>
  );

  const meta = (
    <>
      {tab !== 'watch' && stats.total > 0 && (
        <span className="tabular whitespace-nowrap">
          <span className="text-up-text">상승 {stats.up}</span><span className="mx-1 text-faint">·</span><span className="text-down-text">하락 {stats.down}</span>
        </span>
      )}
      <span className="flex items-center gap-2 whitespace-nowrap">
        {stats.total > 0 && <span className="tabular">{ranker ? `${rows.length}/${stats.total}` : stats.total}종목</span>}
        {liveState === 'live' && <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-good" />실시간</span>}
        {liveState === 'closed' && <span>장 마감</span>}
        {liveState === 'delayed' && <span>지연 시세{stock ? ' · 10분 단위' : ''}</span>}
      </span>
    </>
  );

  const head = (k: SortKey, label: string) => {
    const on = sort?.k === k;
    return (
      <button type="button" onClick={() => onHeadSort(k)} aria-label={`${label} 순으로 정렬`}
        className={cn('inline-flex items-center justify-self-end gap-0.5 whitespace-nowrap transition-colors hover:text-foreground', on && 'font-semibold text-foreground')}>
        {label}{on && (sort!.d === -1 ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
      </button>
    );
  };

  const noWatch = tab === 'watch' && !watch.length;
  let body: ReactNode;
  if (noWatch) {
    body = (
      <Empty icon={<Star className="size-9" />} action={<a href={href('market', 'coin')} className="press rounded-xl bg-secondary px-4 py-2.5 text-[14px] font-semibold text-secondary-foreground">코인 둘러보기</a>}>
        <p className="text-[15px] font-semibold text-foreground">관심 종목이 없어요</p>
        <p className="mt-1">목록에서 ☆를 누르면 여기에 모여요</p>
      </Empty>
    );
  } else if (empty) {
    const slow = slowTab === tab;
    body = (
      <div className="px-2 pt-1">
        {slow && (
          <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4 text-center text-[14px] break-keep text-muted-foreground">
            <p>{stock && stockErr ? `시세를 불러오지 못했어요 (${stockErr.message})` : '시세를 불러오는 데 시간이 걸리고 있어요. 네트워크를 확인해 주세요.'}</p>
            <button type="button" onClick={() => location.reload()} className="press inline-flex items-center gap-1.5 rounded-xl bg-secondary px-4 py-2 font-semibold text-secondary-foreground">
              <RotateCw className="size-4" />새로고침
            </button>
          </div>
        )}
        <RowSkeleton rows={slow ? 3 : 10} />
      </div>
    );
  } else if (!rows.length) {
    const items = (others.data || []).slice(0, 8);
    body = (
      <div className="pb-2">
        <div className="px-6 pt-8 pb-4 text-center text-[14px] break-keep text-muted-foreground">
          <p className="text-[15px] font-semibold text-foreground">‘{dq}’ — {TAB_NAME[tab]}에는 없어요</p>
          {items.length > 0 && <p className="mt-1">다른 시장에서 찾았어요</p>}
          {!items.length && !others.isFetching && <p className="mt-1">이름이나 코드를 다시 확인해 주세요</p>}
        </div>
        {items.length > 0 && (
          <ul className="lg:px-2">
            {items.map((it) => (
              <li key={it.sym}>
                <a href={href('chart', it.sym)} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover active:bg-secondary/70 lg:rounded-xl lg:px-3">
                  <SymbolLogo sym={it.sym} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{it.name}</span>
                    {MARKETS[it.market].coin ? (
                      // 코인은 한 번만 — 볼 수 있는 거래소를 배지로
                      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                        <span className="truncate">코인 · {it.sub}</span><VenueBadges sym={it.sym} />
                      </span>
                    ) : (
                      <span className="block truncate text-[12.5px] text-muted-foreground">{MARKETS[it.market].name} · {it.sub}{it.ex ? ` · ${it.ex}` : ''}</span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } else {
    body = (
      <div role="list" aria-label={`${TAB_NAME[tab]} 종목`} onPointerDown={() => { holdUntil.current = performance.now() + 1200; }}>
        {shown.map(({ sym, rank }) => (
          <div role="listitem" key={sym}>
            <MarketRow sym={sym} rank={rank} tab={tab} metric={metric} watched={watchKeys.has(coinKey(sym))} markDelay={markDelay} kimpKey={kimpKey} namesV={namesV} />
          </div>
        ))}
      </div>
    );
  }

  const note = noWatch ? null : tab === 'upbit' ? '거래대금은 최근 24시간 합계예요. 김프는 바이낸스 시세와 환율로 계산한 참고값이에요.'
    : tab === 'binance' ? '등락률과 거래대금은 최근 24시간 기준이에요. 가격 단위는 USDT예요.'
      : tab === 'watch' ? '★를 다시 누르면 관심 종목에서 빠져요. 관심 종목은 이 기기의 브라우저에만 저장돼요.'
        : `${tab === 'krx' ? '코스피·코스닥' : '나스닥·뉴욕증권거래소'} 시가총액 상위 종목이에요. ${relayOk && !stockErr ? '장중에는 2.5초마다 새로 받아요.' : '실시간 중계가 연결되지 않아 10분마다 바뀌는 지연 시세예요.'}`;

  return (
    <section className="rounded-[20px] bg-card pb-3 text-card-foreground">
      {/* 탭 + (PC) 목록 안 찾기 */}
      <div className="mx-4 flex items-end gap-4 border-b border-border pt-1.5 lg:mx-6 lg:pt-3">
        <UnderlineTabs items={TOP_ITEMS} value={top} onChange={goTop} className="min-w-0 flex-1 gap-5 lg:gap-6 lg:[&>button]:text-[17px]" />
        {!noWatch && <div className="mb-2 hidden lg:block">{searchField(false)}</div>}
      </div>

      {/* 코인 — 같은 코인을 거래소만 바꿔서 본다 */}
      {isCoinEx(tab) && <CoinExSwitch value={tab} onChange={goEx} className="px-4 pt-3 lg:px-6 lg:pt-4" />}

      {/* 정렬 칩 + 요약 (관심 종목이 비었으면 감춘다) */}
      <div className={cn('flex items-center gap-2 pt-3 pr-3 pl-4 lg:px-6', noWatch && 'hidden')}>
        {/* 휴대폰에선 칩이 넘치면 옆으로 밀린다 — 오른쪽 끝을 흐리게 해서 더 있다는 걸 보여 준다 */}
        <div className="no-scrollbar -my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1 max-lg:pr-6 max-lg:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]" role="group" aria-label="정렬">
          {CHIPS[tab].map((c) => {
            const on = chipOn(c, sort);
            return (
              <Chip key={c.id} on={on} onClick={() => setSort(c.sort ? { ...c.sort } : null)}>
                {c.label}
                {on && chipReversed(c, sort) && (sort!.d === 1 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />)}
              </Chip>
            );
          })}
        </div>
        <div className="hidden items-center gap-3 text-[13px] text-muted-foreground lg:flex">{meta}</div>
        <button
          type="button" onClick={() => (searchOpen ? clearQuery() : setSearchOpen(true))} aria-label={searchOpen ? '찾기 닫기' : '목록에서 찾기'} aria-expanded={searchOpen}
          className={cn('press grid size-9 shrink-0 place-items-center rounded-xl text-secondary-foreground transition-colors lg:hidden', searchOpen || query ? 'bg-foreground text-background' : 'hover:bg-secondary')}
        >
          {searchOpen ? <X className="size-[18px]" /> : <Search className="size-[18px]" />}
        </button>
      </div>
      {searchOpen && !noWatch && <div className="px-4 pt-2.5 lg:hidden">{searchField(true)}</div>}
      {!noWatch && <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1 text-[12.5px] text-muted-foreground lg:hidden">{meta}</div>}

      {/* 목록 */}
      <div className="mt-1 lg:mt-3 lg:px-2">
        {!empty && rows.length > 0 && (
          <div className={cn(ROW_GRID, GRID[tab], 'sticky z-20 hidden h-10 border-b border-border bg-card px-2 text-[12.5px] text-muted-foreground lg:grid')} style={{ top: stickyTop }}>
            <span className="text-center">#</span>
            <span className="col-span-2">{head('name', '종목')}</span>
            {head('price', '현재가')}
            {head('chg', '등락률')}
            {head('vol', coin ? '거래대금(24h)' : '거래대금')}
            {tab === 'upbit' && head('kimp', '김프')}
            {stock && head('cap', '시가총액')}
            <span />
          </div>
        )}
        <div className="lg:pt-1">{body}</div>
      </div>

      {note && <p className="mx-4 mt-2 border-t border-border pt-3 text-[12px] leading-relaxed break-keep text-subtle lg:mx-6">{note}</p>}
    </section>
  );
}
