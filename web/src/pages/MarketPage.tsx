// 시장 — 관심 · 코인 · 국내주식 · 미국주식 목록
// 코인은 한 탭이고 거래소는 그 아래 [업비트 · 원화 | 바이낸스 · USDT] 로만 고른다.
//   주소: #/market/upbit · #/market/binance (그 거래소) · #/market/coin (마지막으로 고른 거래소 — ml.coinEx)
// 성능: 줄마다 자기 시세만 구독(MarketRow) · 정렬은 약 1초마다(useQuotesTick) · 처음엔 40줄만 그리고 나머지는 이어서(transition)
// 전략 탭: 정렬 칩 아래 '🚀 분출 임박 · ⚡ 돌파 …' — 일봉 패턴 판정(screener/<시장>.json, 10분마다)에 걸린 종목만 점수 순으로,
//   머리에는 그 패턴의 과거 성적(setups_stats.json, 하루 1번). 둘 다 정적 파일이라 중계 호출은 늘지 않는다.
//   주소: #/market/upbit/squeeze_breakout — 칩을 누르면 주소만 조용히 바꾼다(화면이 맨 위로 튀지 않게)
import { startTransition, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, RotateCw, Search, SearchX, Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { CARD_CLS, Empty, EMPTY_BTN, RowSkeleton } from '@/components/common/Card';
import { Chip, UnderlineTabs } from '@/components/common/Segmented';
import { LiveBadge } from '@/components/common/Status';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { CoinExSwitch, VenueBadges } from '@/components/market/CoinVenues';
import { BreadthCard, WatchRail } from '@/components/market/MarketRail';
import { MarketRow } from '@/components/market/MarketRow';
import { GRID, ROW_GRID } from '@/components/market/shared';
import { StrategyBox, StrategyChips } from '@/components/market/StrategyTabs';
import { setupDefs, setupHits, stratFromArg, type Hit } from '@/components/market/strategy';
import { isNoData } from '@/components/screener/model';
import { useMedia } from '@/components/screener/useMedia';
import {
  CHIPS, chipOn, chipReversed, clearSpot, isTab, loadSorts, makeRanker, nextHeadSort, peekSpot, restoreSpot, sortOf, sortSyms,
  type Sort, type SortKey, type Tab,
} from '@/components/market/sort';
import { useNamesVersion, useQuotesTick, useRelay, useStockError, useWant } from '@/hooks/market';
import { coinKey, isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, type CoinEx } from '@/lib/coins';
import { dirShown } from '@/lib/format';
import {
  binanceTop, FX, getQuote, listOrder, loadCoins, MARKETS, nameOf, overview, refreshKimpRef, remember, screener, search, setupsStats, Store, upbitCodes,
  type Market, type Sym,
} from '@/lib/market';
import { href, navigate } from '@/lib/router';
import { distinctWatch, watchStore } from '@/stores';

/** 맨 위 탭 — 코인 탭 안에서 거래소(업비트·바이낸스)를 다시 고른다 */
type Top = 'watch' | 'coin' | 'krx' | 'us';
const topOf = (t: Tab): Top => (isCoinEx(t) ? 'coin' : t);
const TAB_NAME: Record<Tab, string> = { upbit: '업비트', binance: '바이낸스', krx: '국내주식', us: '미국주식', watch: '관심 종목' };
const TOP_ITEMS: { value: Top; label: ReactNode }[] = [
  { value: 'watch', label: <span className="inline-flex items-center gap-1"><Star aria-hidden strokeWidth={1.4} className="size-[15px] fill-[var(--star)] stroke-[var(--star-edge)]" />관심</span> },
  { value: 'coin', label: '코인' },
  { value: 'krx', label: '국내주식' },
  { value: 'us', label: '미국주식' },
];
const FIRST_ROWS = 40;
/** 전략 탭은 점수 상위 50개 + '더 보기' */
const STRAT_ROWS = 50;
/** '더 보기'를 누른 전략 (탭/전략) — 차트를 보고 돌아와도 펼친 채로 */
let lastMore: string | null = null;

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
    document.title = `${TAB_NAME[tab]}${isCoinEx(tab) ? ' 코인' : ''} 시세 — 마켓`;
    return () => { document.title = '마켓'; };
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

  // ── 전략 (차트 패턴) — 판정·과거 성적 모두 정적 파일 ──
  const mkt: Market | null = tab === 'watch' ? null : tab;
  const scr = useQuery({
    // 종목 골라보기 화면과 같은 열쇠·같은 처리 (한 번 받은 파일을 함께 쓴다)
    queryKey: ['screener', mkt],
    queryFn: async () => {
      const d = await screener(mkt!);
      for (const r of d.rows) remember(r.sym, { name: r.name, sub: r.sub, ex: r.ex ?? undefined });
      return d;
    },
    enabled: !!mkt,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: (n, e) => !isNoData(e) && n < 1,
  });
  const stQ = useQuery({ queryKey: ['setups-stats'], queryFn: setupsStats, enabled: !!mkt, staleTime: 30 * 60e3, retry: (n, e) => !isNoData(e) && n < 1 });
  const defs = useMemo(() => setupDefs(stQ.data), [stQ.data]);
  const mktStats = mkt ? stQ.data?.markets?.[mkt] : undefined;
  const hitsAll = useMemo(
    () => (scr.data && mkt && scr.data.market === mkt ? setupHits(scr.data.rows, mkt, (s) => nameOf(s).name) : null),
    [scr.data, mkt, namesV], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // 고른 전략: 주소(args[1])에서 시작하고, 칩을 누르면 화면 안에서 바꾼 뒤 주소만 조용히 고친다(replaceState — hashchange 없음).
  // 주소가 바뀌어 새 args 가 오면(뒤로 가기·거래소 바꾸기) 다시 주소를 따른다
  const [stratPick, setStratPick] = useState<{ args: string[]; key: string | null } | null>(null);
  const stratRaw = stratPick && stratPick.args === args ? stratPick.key : stratFromArg(args[1]);
  const stratDef = mkt && stratRaw ? defs.find((d) => d.key === stratRaw) : undefined;
  const strat = stratDef?.key ?? null;
  const stratView = `${tab}/${strat}`;
  // 전략 안에서 열 머리로 다시 정렬 (없으면 점수 순) — 전략을 바꾸면 점수 순으로 돌아간다
  const [stratSortSt, setStratSortSt] = useState<{ view: string; s: Sort } | null>(null);
  const stratSort = strat && stratSortSt?.view === stratView ? stratSortSt.s : null;
  const [moreView, setMoreView] = useState<string | null>(lastMore);
  const more = !!strat && moreView === stratView;
  const pickStrat = (key: string | null) => {
    setStratPick({ args, key });
    history.replaceState(history.state, '', href('market', tab, key ?? undefined));
  };

  // ── 종목 목록 → (전략) → 정렬 → 순위 ──
  // pool: 이 탭의 전체 종목(시세가 있는 것) · order: 화면에 보일 순서 (전략이면 걸린 종목만, 점수 순)
  // 누르는 순간 줄이 자리를 바꾸면 엉뚱한 종목이 열리므로, 누르고 있는 동안(+잠깐)은 순서를 고정한다
  const holdUntil = useRef(0);
  const last = useRef<{ key: string; v: { pool: Sym[]; order: Sym[] } } | null>(null);
  const { pool, order } = useMemo(() => {
    let syms: Sym[];
    if (tab === 'watch') syms = watchSyms;
    else if (tab === 'upbit') syms = coinsReady ? upbitCodes().map((c) => 'upbit:' + c) : [];
    else if (tab === 'binance') syms = coinsReady ? binanceTop().map((s) => 'binance:' + s) : [];
    else syms = listOrder[tab];
    if (tab !== 'watch') syms = syms.filter((s) => getQuote(s)?.price != null);
    let list = syms;
    let s = sort;
    if (strat) {
      const have = new Set(syms);
      list = (hitsAll?.get(strat) ?? []).filter((h) => have.has(h.sym)).map((h) => h.sym);
      s = stratSort;
    }
    const key = `${tab}|${strat}|${s?.k}|${s?.d}|${syms.length}|${list.length}|${namesV}|${watchSyms.join(',')}`;
    if (last.current && last.current.key === key && performance.now() < holdUntil.current) return last.current.v;
    const v = { pool: syms, order: sortSyms(list, s) };
    last.current = { key, v };
    return v;
    // tick·kimpV 는 시세·김프가 바뀌었다는 신호 (값은 getQuote 로 읽는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, coinsReady, watchSyms, sort?.k, sort?.d, tick, kimpV, namesV, strat, hitsAll, stratSort?.k, stratSort?.d]);
  // 전략별 지금 걸린 종목 수 (이 탭 목록에 있는 것만 — 칩 숫자와 목록 줄 수가 같게)
  const stratCounts = useMemo(() => {
    if (!hitsAll || !pool.length) return null;
    const have = new Set(pool);
    const m = new Map<string, number>();
    for (const [k, l] of hitsAll) m.set(k, l.reduce((n, h) => n + (have.has(h.sym) ? 1 : 0), 0));
    return m;
  }, [hitsAll, pool]);
  const hitOf = useMemo(() => new Map<Sym, Hit>(strat ? (hitsAll?.get(strat) ?? []).map((h) => [h.sym, h]) : []), [strat, hitsAll]);

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
  // (전략 안에서 못 찾으면 다른 시장 대신 '전략을 풀고 찾기'를 권한다)
  const others = useQuery({ queryKey: ['search', dq], queryFn: () => search(dq), enabled: noMatch && !strat, staleTime: 60_000 });

  // ── 요약: 상승·하락 수, 실시간 여부 (전략을 골라도 이 탭 전체 기준) ──
  const stats = useMemo(() => {
    let up = 0, down = 0, live = 0, open = 0;
    for (const s of pool) {
      const q = getQuote(s);
      if (!q) continue;
      const d = dirShown(q.chg);
      if (d === 'up') up++; else if (d === 'down') down++;
      if (q.live) { live++; if (q.status !== 'CLOSE') open++; }
    }
    return { up, down, flat: pool.length - up - down, live, open, total: pool.length };
  }, [pool]);
  const liveState: 'live' | 'closed' | 'delayed' | null = !stats.total ? null : !stats.live ? 'delayed' : stock && !stats.open ? 'closed' : 'live';
  const markDelay = stats.live > 0 && stats.live < stats.total;
  const viewSort = strat ? stratSort : sort;
  const metric: 'vol' | 'cap' = stock && viewSort?.k !== 'vol' ? 'cap' : 'vol';

  // ── 처음엔 FIRST_ROWS 줄만, 다음 프레임에 나머지 (탭 전환이 바로 반응하도록) ──
  const stage = `${tab}:${strat ?? ''}:${order.length > 0 ? 1 : 0}`;
  const [fullStage, setFullStage] = useState<string | null>(null);
  const full = fullStage === stage;
  useEffect(() => {
    if (full) return;
    const id = requestAnimationFrame(() => startTransition(() => setFullStage(stage)));
    return () => cancelAnimationFrame(id);
  }, [full, stage]);
  // 전략은 점수 상위 50개 + '더 보기' (찾을 때는 걸린 종목 전부에서)
  const shown = strat ? (ranker || more ? rows : rows.slice(0, STRAT_ROWS)) : full || ranker ? rows : rows.slice(0, FIRST_ROWS);

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
  const empty = pool.length === 0;
  useEffect(() => {
    if (!empty) return;
    const t = setTimeout(() => setSlowTab(tab), 12_000);
    return () => clearTimeout(t);
  }, [empty, tab]);

  const stickyTop = useStickyTop();
  const railOn = useMedia('(min-width: 1240px)'); // 오른쪽 레일 — 넓은 화면에서만 그린다(시세 구독도 그때만)
  // 코인 탭을 누르면 마지막으로 고른 거래소로, 거래소를 바꾸면 그 주소로 (#/market/upbit · #/market/binance)
  // 고른 전략은 시장을 바꿔도 이어 간다 (관심 탭에는 전략이 없다)
  const goTop = (t: Top) => { if (t !== top) navigate('market', t === 'coin' ? storedCoinEx() : t, t === 'watch' ? undefined : strat); };
  const goEx = (ex: CoinEx) => { if (ex !== tab) { saveCoinEx(ex); navigate('market', ex, strat); } };
  const onHeadSort = (k: SortKey) => {
    if (strat) setStratSortSt({ view: stratView, s: nextHeadSort(k, stratSort) });
    else setSort(nextHeadSort(k, sort));
  };
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
    <div className={cn('relative', mobile ? 'w-full' : 'w-60')}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={mobile}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); openFirst(); }
          else if (e.key === 'Escape') { e.preventDefault(); clearQuery(); (e.target as HTMLInputElement).blur(); }
        }}
        placeholder={`${TAB_NAME[tab]}에서 찾기`} aria-label="목록에서 종목 찾기" enterKeyHint="go" autoComplete="off" spellCheck={false}
        className="h-10 w-full rounded-xl bg-secondary pr-9 pl-9.5 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[1.5px] focus-visible:ring-foreground focus-visible:ring-inset lg:text-[15px] [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button type="button" onClick={() => setQuery('')} aria-label="지우기" className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-faint/60 text-card">
          <X className="size-3.5" strokeWidth={3} />
        </button>
      )}
    </div>
  );

  // ── 요약 줄: (상승·하락 수) · n종목 · 시세 상태 — 레일이 보이면 상승·하락 수는 레일에만 ──
  const breadth = tab !== 'watch' && stats.total > 0 ? (
    <span className="relative font-semibold whitespace-nowrap tabular">
      <span className="text-up-text">상승 {stats.up}</span><span className="mx-1 text-faint" aria-hidden>·</span><span className="text-down-text">하락 {stats.down}</span>
    </span>
  ) : null;
  const count = stats.total > 0 ? <span className="whitespace-nowrap tabular">{ranker ? `${rows.length}/${order.length}` : stats.total}종목</span> : null;
  const status = liveState === 'live' ? <LiveBadge state="live" />
    : liveState === 'closed' ? <LiveBadge state="closed" label={tab === 'krx' ? '장 마감 · 15:30 기준' : '장 마감'} />
      : liveState === 'delayed' ? <LiveBadge state="delayed" label={stock ? '지연 시세 · 10분 단위' : '지연 시세'} /> : null;
  const metaWide = <div className="hidden shrink-0 items-center gap-2.5 text-[13px] text-muted-foreground md:flex">{!railOn && breadth}{count}{status}</div>;
  const metaNarrow = <div className="mt-3 flex items-center justify-between gap-3 text-[13px] text-muted-foreground md:hidden">{breadth ?? <span />}{count}{status}</div>;

  const head = (k: SortKey, label: string, cls?: string) => {
    const on = viewSort?.k === k;
    return (
      <button type="button" onClick={() => onHeadSort(k)} aria-label={`${label} 순으로 정렬`}
        className={cn('inline-flex items-center justify-self-end gap-0.5 whitespace-nowrap transition-colors hover:text-foreground', on && 'text-foreground', cls)}>
        {label}{on && (viewSort!.d === -1 ? <ArrowDown className="size-3" strokeWidth={2.4} /> : <ArrowUp className="size-3" strokeWidth={2.4} />)}
      </button>
    );
  };

  const noWatch = tab === 'watch' && !watch.length;
  let body: ReactNode;
  if (noWatch) {
    body = (
      <Empty icon={<Star />} title="관심 종목이 없어요" action={<a href={href('market', 'coin')} className={EMPTY_BTN}>코인 둘러보기</a>}>
        목록에서 ☆를 누르면 여기에 모여요
      </Empty>
    );
  } else if (empty) {
    const slow = slowTab === tab;
    body = (
      <div className="pt-1">
        {slow && (
          <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4 text-center text-[14px] text-muted-foreground">
            <p>{stock && stockErr ? `시세를 불러오지 못했어요 (${stockErr.message})` : '시세를 불러오는 데 시간이 걸리고 있어요. 네트워크를 확인해 주세요.'}</p>
            <button type="button" onClick={() => location.reload()} className={EMPTY_BTN}>
              <RotateCw className="size-4" />새로고침
            </button>
          </div>
        )}
        <RowSkeleton rows={slow ? 3 : 10} />
      </div>
    );
  } else if (strat && !order.length) {
    // 전략에 걸린 종목이 없다 — 판정 파일을 아직 못 받았거나, 받지 못했거나, 정말 없거나
    body = scr.isPending ? <RowSkeleton rows={4} /> : scr.isError && !scr.data ? (
      <Empty icon={<SearchX />} title="전략 판정을 불러오지 못했어요" action={<button type="button" onClick={() => void scr.refetch()} className={EMPTY_BTN}><RotateCw className="size-4" />다시 시도</button>}>
        {isNoData(scr.error) ? '판정이 아직 만들어지지 않았어요. 잠시 뒤 다시 확인해 주세요.' : '네트워크를 확인해 주세요.'}
      </Empty>
    ) : (
      <Empty icon={<SearchX />} title={`지금 ‘${stratDef!.name}’에 걸린 종목이 없어요`} action={<button type="button" onClick={() => pickStrat(null)} className={EMPTY_BTN}>전체 목록 보기</button>}>
        판정은 10분마다 새로 해요
      </Empty>
    );
  } else if (strat && !rows.length) {
    body = (
      <Empty icon={<SearchX />} title={`‘${dq}’ — 지금 ‘${stratDef!.name}’에 걸린 종목 중에는 없어요`} action={<button type="button" onClick={() => pickStrat(null)} className={EMPTY_BTN}>전략 풀고 찾기</button>} />
    );
  } else if (!rows.length) {
    const items = (others.data || []).slice(0, 8);
    body = (
      <div className="pb-2">
        <div className="px-6 pt-8 pb-4 text-center text-[14px] text-muted-foreground">
          <p className="text-[15px] font-semibold text-foreground">‘{dq}’ — {TAB_NAME[tab]}에는 없어요</p>
          {items.length > 0 && <p className="mt-1">다른 시장에서 찾았어요</p>}
          {!items.length && !others.isFetching && <p className="mt-1">이름이나 코드를 다시 확인해 주세요</p>}
        </div>
        {items.length > 0 && (
          <ul>
            {items.map((it) => (
              <li key={it.sym}>
                <a href={href('chart', it.sym)} className="-mx-2 flex items-center gap-3 px-2 py-2.5 transition-colors hover:bg-hover active:bg-secondary/70 md:-mx-3 md:rounded-[14px] md:px-3">
                  <SymbolLogo sym={it.sym} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{it.name}</span>
                    {MARKETS[it.market].coin ? (
                      // 코인은 한 번만 — 볼 수 있는 거래소를 배지로
                      <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                        <span className="truncate">코인 · {it.sub}</span><VenueBadges sym={it.sym} />
                      </span>
                    ) : (
                      <span className="block truncate text-[13px] text-muted-foreground">{MARKETS[it.market].name} · {it.sub}{it.ex ? ` · ${it.ex}` : ''}</span>
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
            <MarketRow sym={sym} rank={rank} tab={tab} metric={metric} watched={watchKeys.has(coinKey(sym))} markDelay={markDelay} kimpKey={kimpKey} namesV={namesV}
              why={strat ? hitOf.get(sym)?.r : undefined} />
          </div>
        ))}
      </div>
    );
    if (strat && rows.length > shown.length) {
      body = (
        <>
          {body}
          <button type="button" onClick={() => { lastMore = stratView; setMoreView(stratView); }}
            className="press -mx-2 mt-1 flex h-12 w-[calc(100%+1rem)] items-center justify-center gap-1 rounded-[14px] text-[14px] font-semibold text-text-3 hover:bg-hover md:-mx-3 md:w-[calc(100%+1.5rem)]">
            나머지 {rows.length - shown.length}종목 더 보기<ChevronDown className="size-4" aria-hidden />
          </button>
        </>
      );
    }
  }

  const note = noWatch ? null : tab === 'upbit' ? '거래대금은 최근 24시간 합계예요. 김프는 바이낸스 시세와 환율로 계산한 참고값이에요.'
    : tab === 'binance' ? '등락률과 거래대금은 최근 24시간 기준이에요. 가격 단위는 USDT예요.'
      : tab === 'watch' ? '★를 다시 누르면 관심 종목에서 빠져요. 관심 종목은 이 기기에만 암호화해 저장돼요.'
        : `${tab === 'krx' ? '코스피·코스닥' : '나스닥·뉴욕증권거래소'} 시가총액 상위 종목이에요. ${relayOk && !stockErr ? '장중에는 2.5초마다 새로 받아요.' : '실시간 중계가 연결되지 않아 10분마다 바뀌는 지연 시세예요.'}`;

  const list = (
    <section className={cn(CARD_CLS, 'min-w-0 px-4 pt-0.5 pb-3 sm:px-5 md:px-6 md:pt-1.5')}>
      {/* 탭 + 목록 안 찾기 (PC 입력칸 · 휴대폰 돋보기) */}
      <div className="flex items-center gap-4 shadow-[inset_0_-1px_0_var(--border)]">
        <UnderlineTabs size="lg" items={TOP_ITEMS} value={top} onChange={goTop} className="min-w-0 flex-1" />
        {!noWatch && <div className="hidden lg:block">{searchField(false)}</div>}
        {!noWatch && (
          <button
            type="button" onClick={() => (searchOpen ? clearQuery() : setSearchOpen(true))} aria-label={searchOpen ? '찾기 닫기' : '목록에서 찾기'} aria-expanded={searchOpen}
            className={cn('press -mr-2.5 grid size-11 shrink-0 place-items-center rounded-xl text-secondary-foreground transition-colors lg:hidden', searchOpen || query ? 'bg-secondary text-foreground' : 'hover:bg-secondary')}
          >
            {searchOpen ? <X className="size-5" strokeWidth={1.8} /> : <Search className="size-5" strokeWidth={1.8} />}
          </button>
        )}
      </div>
      {searchOpen && !noWatch && <div className="pt-3 lg:hidden">{searchField(true)}</div>}

      {/* 코인 — 같은 코인을 거래소만 바꿔서 본다 (오른쪽엔 요약) */}
      {coin && (
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <CoinExSwitch value={tab} onChange={goEx} className="w-full md:w-auto" />
          {metaWide}
        </div>
      )}
      {!noWatch && metaNarrow}

      {/* 정렬 칩 (+ 코인이 아니면 오른쪽에 요약) — 관심 종목이 비었으면 감춘다 */}
      {!noWatch && (
        <div className="mt-3 flex items-center gap-3">
          {/* 휴대폰에선 칩이 넘치면 옆으로 밀린다 — 오른쪽 끝을 흐리게 해서 더 있다는 걸 보여 준다 */}
          <div className="no-scrollbar -my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1 max-md:-mr-4 max-md:pr-6 max-md:[mask-image:linear-gradient(to_right,black_85%,transparent)]" role="group" aria-label="정렬">
            {/* 정렬 칩과 전략 칩은 한 묶음의 탭 — 정렬 칩을 누르면 전략을 풀고 전체 목록으로 */}
            {CHIPS[tab].map((c) => {
              const on = !strat && chipOn(c, sort);
              return (
                <Chip key={c.id} on={on} onClick={() => { if (strat) pickStrat(null); setSort(c.sort ? { ...c.sort } : null); }}>
                  {c.label}
                  {on && chipReversed(c, sort) && (sort!.d === 1 ? <ArrowUp className="-ml-0.5 size-3.5" /> : <ArrowDown className="-ml-0.5 size-3.5" />)}
                </Chip>
              );
            })}
          </div>
          {!coin && metaWide}
        </div>
      )}

      {/* 전략 칩 (관심 탭에는 없다) + 고른 전략의 머리 — 설명 · 과거 성적 한 줄 */}
      {mkt && (
        <StrategyChips defs={defs} counts={stratCounts} stats={mktStats} value={strat} onChange={pickStrat} />
      )}
      {mkt && stratDef && (
        <StrategyBox def={stratDef} stat={mktStats?.[stratDef.key]} stats={stQ.data} market={mkt}
          count={stratCounts ? stratCounts.get(stratDef.key) ?? 0 : null} updatedAt={scr.data ? Date.parse(scr.data.updatedAt) : null} />
      )}

      {/* 목록 — 태블릿·PC 는 표 머리줄이 사이트 머리글 아래에 붙어 따라온다 */}
      <div className="mt-1.5 md:mt-2">
        {!empty && rows.length > 0 && (
          <div className={cn(ROW_GRID, GRID[tab], 'sticky z-20 -mx-3 hidden h-[34px] bg-card px-3 text-[13px] font-semibold text-muted-foreground md:grid')} style={{ top: stickyTop }}>
            {strat ? (
              // 전략: '#' 은 점수 순 — 열 머리로 다시 정렬했다가 되돌아올 때
              <button type="button" onClick={() => setStratSortSt(null)} aria-label="전략 점수 순으로 정렬" title="점수 순"
                className={cn('justify-self-center transition-colors hover:text-foreground', !stratSort && 'text-foreground')}>#</button>
            ) : <span className="text-center">#</span>}
            <span className="col-span-2">{head('name', '종목', 'justify-self-start')}</span>
            {head('price', '현재가')}
            {head('chg', '등락률')}
            {head('vol', '거래대금', stock ? 'hidden lg:inline-flex' : '')}
            {tab === 'upbit' && head('kimp', '김프', 'hidden lg:inline-flex')}
            {stock && head('cap', '시가총액')}
            <span />
          </div>
        )}
        {body}
      </div>

      {note && <p className="mt-2 border-t border-border pt-3 text-[12.5px] leading-[1.6] text-muted-foreground">{note}</p>}
    </section>
  );

  return (
    <div className="grid items-start gap-2 sm:gap-3 lg:gap-4 min-[1240px]:grid-cols-[minmax(0,1fr)_300px]">
      {list}
      {railOn && (
        <aside className="sticky grid gap-4" style={{ top: stickyTop + 16 }} aria-label="시장 요약">
          {stats.total > 0 && <BreadthCard up={stats.up} flat={stats.flat} down={stats.down} caption={`${TAB_NAME[tab]} ${stats.total}종목`} />}
          {tab !== 'watch' && <WatchRail />}
        </aside>
      )}
    </div>
  );
}
