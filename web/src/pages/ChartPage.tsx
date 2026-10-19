// 종목 상세 — 가격 머리(시세 6칸 · 내 평단 한 줄) · 캔들 차트 | 호가 · 기술적 분석 · 주요 지표 · AI 예측 | 내 평단 진단 · 뉴스
// 코인은 한 종목 — 업비트 원화·바이낸스 USDT 양쪽에 있으면 머리의 [업비트 | 바이낸스] 로 거래소만 바꾼다 (주기는 그대로)
// 배치: PC(≥1024) 차트 | 호가 392 → 왼쪽 [분석 · 지표 · AI 예측] / 오른쪽 [내 평단 · 뉴스]
//       태블릿(768~1023) 차트 → 호가 | 내 평단 → 분석 → 지표 → AI 예측 | 뉴스
//       휴대폰(<768) 차트 → [호가 | 분석 | 내 평단 | AI 예측 | 뉴스] 탭
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Loader2, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { Card, CardTitle } from '@/components/common/Card';
import { Segmented } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CandleChart } from '@/components/chart/CandleChart';
import { OrderBook, roundTick } from '@/components/chart/OrderBook';
import { AnalysisPanel, KeyStats } from '@/components/chart/AnalysisPanel';
import { ForecastPanel } from '@/components/chart/ForecastPanel';
import { NewsPanel } from '@/components/chart/NewsPanel';
import { PositionCard, PositionHeadline } from '@/components/chart/PositionCard';
import { AiCommentary } from '@/components/chart/AiCommentary';
import { useNamesVersion, useQuote, useRelay, useWant } from '@/hooks/market';
import { coinBase, coinExOf, coinListsKnown, EX_NAME, useCoinsReady, venuesOf, type CoinEx } from '@/lib/coins';
import { analyze, series } from '@/lib/indicators';
import { applyLiveQuote } from '@/lib/liveCandle';
import { digits, dirShown, fmt, fmtAmount, fmtPrice, ccyOf } from '@/lib/format';
import { cssVar } from '@/lib/theme';
import {
  candles as fetchCandles, DAILY, INTERVALS, isValidSym, IV_LABEL, IV_SEC, IV_UNIT, kimp, MARKETS, nameOf, newsMoreUrl, predictSymbol,
  refreshKimpRef, split, Store, type Candle, type Interval, type Market, type Quote, type Sym,
} from '@/lib/market';
import { href, navigate } from '@/lib/router';
import { indStore, isWatched, toggleWatch, watchStore, type IndToggles } from '@/stores';

type Tab = 'book' | 'analysis' | 'pos' | 'forecast' | 'news';
/** 아주 좁은 화면(<360)에서는 탭 이름을 줄여 다섯 개가 한 줄에 들어가게 */
const short = (full: string, s: string) => <><span className="max-[359px]:hidden">{full}</span><span className="min-[360px]:hidden">{s}</span></>;
const TABS: { value: Tab; label: ReactNode }[] = [
  { value: 'book', label: '호가' }, { value: 'analysis', label: '분석' }, { value: 'pos', label: short('내 평단', '평단') }, { value: 'forecast', label: short('AI 예측', '예측') }, { value: 'news', label: '뉴스' },
];
const OTHER_EX: Record<CoinEx, string> = { upbit: '바이낸스 시세는 없어요', binance: '업비트 원화 마켓에는 없어요' };
const MINUTES = new Set<Interval>(['1m', '3m', '5m', '15m', '30m']);
const MINUS = '−';
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 화면 폭 조건 (호가창을 한 군데에만 그리려고) */
function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** 시세 상태 — 초록 점은 실제로 실시간일 때만 */
function liveState(market: Market, q: Quote | undefined): { text: string; live: boolean } {
  if (!q) return { text: '불러오는 중', live: false };
  if (!MARKETS[market].coin && q.status === 'CLOSE') return { text: market === 'krx' ? '장 마감 · 15:30 기준' : '장 마감', live: false };
  return q.live ? { text: '실시간', live: true } : { text: '지연 시세', live: false };
}
function LiveBadge({ market, q, className }: { market: Market; q: Quote | undefined; className?: string }) {
  const s = liveState(market, q);
  const ring = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ring.current;
    if (!el || !s.live || reduceMotion() || typeof el.animate !== 'function') return;
    const a = el.animate([{ transform: 'scale(1)', opacity: 0.55 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 2000, iterations: Infinity, easing: 'ease-out' });
    return () => a.cancel();
  }, [s.live]);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap text-muted-foreground', className)}>
      <span aria-hidden className="relative inline-flex size-1.5">
        {s.live ? <span ref={ring} className="absolute inset-0 rounded-full bg-good opacity-0" /> : null}
        <span className={cn('relative size-1.5 rounded-full', s.live ? 'bg-good' : 'bg-faint')} />
      </span>
      {s.text}
    </span>
  );
}

/** 코인 거래소 전환 — 이 코인을 볼 수 있는 거래소만. 한 곳뿐이면 버튼 대신 이름표와 안내 */
function ExchangeSwitch({ sym, iv, className }: { sym: Sym; iv: Interval; className?: string }) {
  const ready = useCoinsReady(); // 거래소 목록(coins.json)이 와야 어디서 거래되는지 안다
  const ex = coinExOf(sym);
  if (!ex) return null;
  if (!ready) return <div className={cn('h-9', className)} aria-hidden />; // 목록이 오기 전엔 자리만 (잘못된 '없어요' 안내가 깜빡이지 않게)
  const list = venuesOf(sym);
  if (list.length > 1) {
    return (
      <div className={className} role="group" aria-label="거래소">
        <Segmented size="sm" items={list.map((s) => ({ value: s, label: EX_NAME[coinExOf(s)!] }))} value={sym} onChange={(s) => navigate('chart', s, iv)} />
      </div>
    );
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1', className)}>
      <span className="inline-flex h-7 items-center rounded-lg bg-secondary px-2.5 text-[13px] font-semibold text-secondary-foreground">{EX_NAME[ex]}</span>
      {coinListsKnown() && <span className="text-[13px] break-keep text-muted-foreground">{OTHER_EX[ex]}</span>}
    </div>
  );
}

/** 큰 가격 — 늘 한 줄. 단위(원·USDT)는 작게 붙이고, 그래도 폭이 모자라면(긴 소수 가격·큰 글꼴 설정) 글자를 줄 폭에 맞춰 줄인다.
 *  값이 바뀌면 바탕을 칠하지 않고 숫자 색만 0.4초 진하게 했다가 돌아온다 */
function BigPrice({ price, market }: { price: number | null; market: Market }) {
  const text = useRef<HTMLDivElement>(null);
  const prev = useRef(price);
  const num = price == null ? '–' : (market === 'us' ? '$' : '') + fmtPrice(price, market);
  const unit = price == null || market === 'us' ? '' : market === 'binance' ? 'USDT' : '원';
  useLayoutEffect(() => {
    const t = text.current, row = t?.parentElement;
    if (!t || !row) return;
    const fit = () => {
      t.style.fontSize = ''; // CSS 크기(clamp 26~34px)로 재 보고
      const avail = row.clientWidth;
      const w = t.scrollWidth;
      if (!avail || w <= avail) return;
      // 폭에 비례해 줄인 뒤, 글자 크기와 상관없는 여백 때문에 남는 1~2px 은 0.5px 씩 더 줄인다 (16px 아래로는 안 줄인다)
      let fs = Math.max(16, Math.floor(((parseFloat(getComputedStyle(t).fontSize) * avail) / w) * 2) / 2);
      for (let i = 0; i < 8; i++) {
        t.style.fontSize = `${fs}px`;
        if (t.scrollWidth <= avail || fs <= 16) break;
        fs -= 0.5;
      }
    };
    fit();
    const ro = new ResizeObserver(fit); // 화면 폭이 바뀌면
    ro.observe(row);
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) fit(); }); // 웹 글꼴이 늦게 오면 폭이 달라진다
    return () => { alive = false; ro.disconnect(); };
  }, [num, unit]);
  useEffect(() => {
    const t = text.current, p = prev.current;
    prev.current = price;
    if (!t || p == null || price == null || p === price || reduceMotion() || typeof t.animate !== 'function') return;
    const col = cssVar(price > p ? '--up-text' : '--down-text');
    if (col) t.animate([{ color: col }, { color: col, offset: 0.35 }, { color: cssVar('--foreground') }], { duration: 400, easing: 'ease-out' });
  }, [price]);
  return (
    <div ref={text} className="w-max max-w-none text-[clamp(26px,7.4vw,34px)] leading-[1.24] font-bold tracking-[-0.03em] whitespace-nowrap tabular">
      {num}{unit && <span className={cn('font-bold', unit === '원' ? 'ml-0.5 text-[0.82em]' : 'ml-1.5 text-[0.6em] font-semibold')}>{unit}</span>}
    </div>
  );
}

/** 전일 종가 — 주식은 등락률로 거꾸로 계산한 값이라 호가 단위(국내)·센트(미국)로 맞춘다 (215,505 → 215,500) */
function prevOf(q: Quote | undefined, market: Market) {
  const p = q?.prevClose;
  if (p == null) return p;
  return market === 'krx' ? roundTick(p, 'krx') : market === 'us' ? Math.round(p * 100) / 100 : p;
}

/** '어제보다 ▲229,000원 (0.21%)' */
function ChangeLine({ market, q, price }: { market: Market; q: Quote | undefined; price: number | null }) {
  const prevClose = prevOf(q, market);
  const amt = price != null && prevClose ? price - prevClose : null;
  const d = dirShown(q?.chg);
  const tone = d === 'up' ? 'text-up-text' : d === 'down' ? 'text-down-text' : 'text-muted-foreground';
  const unit = market === 'us' ? '' : market === 'binance' ? ' USDT' : '원';
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1 text-[15px] tabular">
      <span className="text-muted-foreground">{market === 'binance' ? '24시간 전보다' : '어제보다'}</span>
      <span className={cn('font-semibold whitespace-nowrap', tone)}>
        {d !== 'flat' ? <><span aria-hidden className="mr-px text-[0.72em]">{d === 'up' ? '▲' : '▼'}</span><span className="sr-only">{d === 'up' ? '상승 ' : '하락 '}</span></> : null}
        {/* 변동폭은 가격과 같은 자릿수로 (1,345원이 1원 내리면 -1.000 이 아니라 1) */}
        {amt != null ? <>{market === 'us' ? '$' : ''}{fmt(Math.abs(amt), digits(price, market))}{unit} </> : null}
        ({q?.chg == null ? '–' : `${Math.abs(Math.round(q.chg * 100) / 100).toFixed(2)}%`})
      </span>
    </span>
  );
}

/** 시세 6칸 (≥640) — 시가 · 고가 · 저가 · 전일 종가 · 거래대금 · 거래량. 고가·저가 색은 전일 종가와 비교 */
function QuoteStats({ sym, market, q }: { sym: Sym; market: Market; q: Quote | undefined }) {
  const prev = prevOf(q, market);
  const coin = MARKETS[market].coin;
  const tone = (x: number | null | undefined) => (x == null || !prev || Math.round((x / prev - 1) * 1e4) === 0 ? '' : x > prev ? 'text-up-text' : 'text-down-text');
  const pf = (x: number | null | undefined) => (x == null ? '–' : (market === 'us' ? '$' : '') + fmtPrice(x, market));
  const unit = coin ? coinBase(sym) ?? '' : '주';
  const vol = q?.accVol;
  const volTxt = vol == null ? null : vol >= 1e4 ? `${fmtAmount(vol, 'KRW')} ${unit}` : `${fmt(vol, vol < 10 ? 3 : 1)} ${unit}`;
  const items: [string, string, string?][] = [];
  if (market !== 'binance') items.push(['시가', pf(q?.open), tone(q?.open)]); // 바이낸스 시가 = 24시간 전 가격
  items.push(['고가', pf(q?.high), tone(q?.high)], ['저가', pf(q?.low), tone(q?.low)]);
  items.push([market === 'binance' ? '24시간 전' : '전일 종가', pf(prev)]);
  items.push([coin ? '24시간 거래대금' : '오늘 거래대금', fmtAmount(q?.vol, ccyOf(market))]);
  if (volTxt) items.push(['오늘 거래량', volTxt]);
  return (
    <dl className="mt-5 grid grid-cols-3 gap-y-4 pt-4 shadow-[inset_0_1px_0_var(--border)] max-sm:hidden lg:grid-cols-[repeat(var(--n),minmax(0,1fr))]" style={{ ['--n' as string]: items.length }}>
      {items.map(([k, v, t], i) => (
        <div key={k} className={cn('min-w-0 border-l border-border px-4', i % 3 === 0 && 'max-lg:border-l-0 max-lg:pl-0', i === 0 && 'lg:border-l-0 lg:pl-0')}>
          <dt className="truncate text-[13px] text-muted-foreground">{k}</dt>
          <dd className={cn('mt-0.5 truncate text-[16px] font-semibold tabular', t)}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 봉 주기 — PC 는 글자 버튼 한 줄, 600px 아래는 분봉 다섯 개를 '분 ▾' 하나로 접는다 */
function IntervalBar({ ivs, iv, onPick }: { ivs: Interval[]; iv: Interval; onPick: (v: Interval) => void }) {
  const [open, setOpen] = useState(false);
  const mins = ivs.filter((x) => MINUTES.has(x)), rest = ivs.filter((x) => !MINUTES.has(x));
  const btn = (on: boolean) => cn('press h-8 shrink-0 rounded-lg px-2.5 text-[14px] whitespace-nowrap transition-colors', on ? 'bg-secondary font-bold text-foreground' : 'font-semibold text-muted-foreground hover:text-foreground');
  const minOn = MINUTES.has(iv);
  return (
    <div role="group" aria-label="봉 주기" className="flex min-w-0 items-center gap-0.5">
      <div className="flex items-center gap-0.5 max-[599px]:hidden">
        {mins.map((x) => <button key={x} onClick={() => onPick(x)} aria-pressed={iv === x} className={btn(iv === x)}>{IV_LABEL[x]}</button>)}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button aria-haspopup="listbox" aria-expanded={open} className={cn(btn(minOn), 'inline-flex items-center gap-0.5 min-[600px]:hidden')}>
            {minOn ? IV_LABEL[iv] : '분'}<ChevronDown aria-hidden className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-36 rounded-2xl p-1.5">
          <div role="listbox" aria-label="분봉">
            {mins.map((x) => (
              <button key={x} role="option" aria-selected={iv === x} onClick={() => { onPick(x); setOpen(false); }}
                className={cn('flex h-11 w-full items-center justify-between rounded-xl px-3 text-[15px] hover:bg-hover', iv === x ? 'font-bold' : 'font-medium text-secondary-foreground')}>
                {IV_LABEL[x]}{iv === x ? <Check aria-hidden className="size-4" /> : null}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-border" />
      {rest.map((x) => <button key={x} onClick={() => onPick(x)} aria-pressed={iv === x} className={btn(iv === x)}>{IV_LABEL[x]}</button>)}
    </div>
  );
}

/** 지표 칩 — 꺼짐: 흰 바탕 + 선 + 빈 고리 / 켬: 회색 바탕 + 색 원판 + ✓ (색·면·모양으로 구분) */
const IND: [keyof IndToggles, string, string][] = [
  ['ma', '이동평균', 'conic-gradient(var(--chart-1) 0 25%, var(--chart-2) 0 50%, var(--chart-3) 0 75%, var(--chart-4) 0)'],
  ['bb', '볼린저', 'var(--faint)'], ['vol', '거래량', 'var(--muted-foreground)'], ['rsi', 'RSI', 'var(--chart-5)'],
  ['macd', 'MACD', 'var(--chart-3)'], ['cross', '골든/데드', 'var(--up)'], ['forecast', 'AI 예측 경로', 'var(--ai, var(--chart-5))'],
];
function IndicatorChips({ toggles, daily }: { toggles: IndToggles; daily: boolean }) {
  return (
    <div role="group" aria-label="보조 지표" className="no-scrollbar flex gap-1.5 overflow-x-auto max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] max-md:pr-6">
      {IND.filter(([k]) => k !== 'forecast' || daily).map(([k, label, c]) => {
        const on = !!toggles[k];
        return (
          <button key={k} aria-pressed={on} onClick={() => indStore.set((t) => ({ ...t, [k]: !t[k] }))}
            className={cn('press inline-flex h-8 shrink-0 items-center gap-[7px] rounded-full pr-[13px] pl-[9px] text-[13px] font-semibold whitespace-nowrap transition-colors',
              on ? 'bg-secondary text-foreground' : 'bg-card text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover')}>
            <span aria-hidden className={cn('relative inline-flex size-[15px] shrink-0 items-center justify-center rounded-full', !on && 'shadow-[inset_0_0_0_1.5px_var(--faint)]')} style={on ? { background: c } : undefined}>
              {on ? <Check className="size-[11px] text-white" strokeWidth={3.5} /> : null}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** 카드 머리 — 휴대폰 탭에서는 탭 이름이 곧 제목이라 제목 대신 캡션만 (tabTitle=false) */
function PanelHead({ title, caption, right, tabTitle = true }: { title: ReactNode; caption?: ReactNode; right?: ReactNode; tabTitle?: boolean }) {
  return (
    <div className="mb-3 flex min-h-7 items-center justify-between gap-3 md:mb-4">
      <h2 className={cn('min-w-0 text-[18px] font-bold tracking-[-0.02em] md:text-[20px]', !tabTitle && 'max-md:hidden')}>{title}</h2>
      {!tabTitle && caption ? <span className="text-[13px] text-muted-foreground md:hidden">{caption}</span> : null}
      {right ? <div className="ml-auto shrink-0">{right}</div> : null}
    </div>
  );
}

export default function ChartPage({ args }: PageProps) {
  const sym = args[0] && isValidSym(args[0]) ? args[0] : Store.get('ml.lastSym', 'upbit:KRW-BTC');
  const [market] = split(sym);
  const coin = MARKETS[market].coin;
  const ivs = INTERVALS[coin ? 'coin' : 'stock'];
  const iv: Interval = ivs.includes(args[1] as Interval) ? (args[1] as Interval) : ivs.includes(Store.get<Interval>('ml.lastIv', '1d')) ? Store.get<Interval>('ml.lastIv', '1d') : '1d';
  useEffect(() => { Store.set('ml.lastSym', sym); Store.set('ml.lastIv', iv); }, [sym, iv]);
  useWant([sym]);
  useNamesVersion();
  const q = useQuote(sym);
  const n = nameOf(sym);
  const base = coinBase(sym);
  // 코인 이름표(coins.json)가 오기 전엔 'BTCUSDT' 대신 티커(BTC)로
  const name = base && n.name === split(sym)[1] ? base : n.name;
  const toggles = indStore.use();
  const watch = watchStore.use();
  const { ok: relayOk } = useRelay();
  const lg = useMedia('(min-width: 1024px)');
  const md = useMedia('(min-width: 768px)');
  const [tab, setTab] = useState<Tab>('book');
  const tabsRef = useRef<HTMLDivElement>(null);
  const [waitMsg, setWaitMsg] = useState<string | null>(null);
  useEffect(() => { document.title = `${name} ${q?.price != null ? fmtPrice(q.price, market) : ''} — 마켓`; }, [name, q?.price, market]);
  useEffect(() => { if (market === 'upbit') void refreshKimpRef(); }, [market]);
  // 휴대폰은 처음엔 보조지표 하나(RSI)만 — 지표를 한 번도 고른 적 없을 때만
  useEffect(() => {
    try { if (window.innerWidth < 640 && localStorage.getItem('ml.ind') == null) indStore.set((t) => ({ ...t, macd: false })); } catch { /* 저장소를 못 쓰면 그대로 */ }
  }, []);

  // 캔들: 종목·주기별로 기억해 두었다가 다시 열면 바로 보여 준다
  const fast = !DAILY.has(iv) && (market === 'binance' || relayOk);
  const cq = useQuery({
    queryKey: ['candles', sym, iv, relayOk],
    queryFn: () => fetchCandles(sym, iv, (sec) => setWaitMsg(`업비트 요청 제한 때문에 ${sec}초 뒤 불러와요`)),
    refetchInterval: fast ? ((IV_SEC[iv] ?? 3600) <= 300 ? 20_000 : 30_000) : 60_000,
    staleTime: 10_000,
  });
  useEffect(() => { if (cq.data || cq.error) setWaitMsg(null); }, [cq.data, cq.error]);
  // 일봉 (호가창 범위 막대) — 일봉 화면이거나 이미 받아 둔 것만 쓴다 (따로 부르지 않는다)
  const dq = useQuery({ queryKey: ['candles', sym, '1d', relayOk], queryFn: () => fetchCandles(sym, '1d'), enabled: false });

  // 실시간 시세를 마지막 봉에 누적 반영 (0.25초 단위로 묶어서)
  const [merged, setMerged] = useState<Candle[] | null>(null);
  const liveRef = useRef<Candle[] | null>(null);
  useEffect(() => { liveRef.current = cq.data ?? null; setMerged(cq.data ?? null); }, [cq.data]);
  const pendingQ = useRef(q);
  pendingQ.current = q;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!liveRef.current || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const base = liveRef.current;
      if (!base) return;
      const next = applyLiveQuote(base, pendingQ.current, market, iv);
      if (next) { liveRef.current = next; setMerged(next); }
    }, 250);
  }, [q, market, iv]);
  // 종목·주기를 바꾸면 (예: 업비트 → 바이낸스) 앞 종목 기준으로 걸어 둔 반영을 버린다 — 저장된 캔들이 바로 뜰 때 다른 시장 규칙으로 봉이 섞이지 않게
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, [sym, iv]);

  const ind = useMemo(() => (merged ? series(merged) : null), [merged]);
  const analysis = useMemo(() => (merged && ind ? analyze(merged, ind, IV_UNIT[iv] || '봉') : null), [merged, ind, iv]);
  const forecast = useQuery({ queryKey: ['predict', sym], queryFn: () => predictSymbol(sym), enabled: iv === '1d', staleTime: 10 * 60e3, retry: false });
  const daily = iv === '1d' ? merged : dq.data ?? null;

  const price = q?.price ?? merged?.[merged.length - 1]?.c ?? null;
  const k = market === 'upbit' ? kimp(n.sub, price) : null;
  const watched = isWatched(watch, sym);
  // 지금 거래 중인가 (차트 끝점 깜빡임) — 코인은 실시간 시세가 오면, 주식은 실시간이면서 장 마감이 아닐 때
  const liveNow = coin ? !!q?.live : !!(q?.live && q.status !== 'CLOSE');
  // 등락 방향 (라인 색) — 머리의 등락률과 같은 규칙(0.00% 는 보합). 시세가 오기 전엔 차트가 스스로 계산
  const dirNow = q?.chg == null ? undefined : Math.sign(dirShown(q.chg) === 'flat' ? 0 : q.chg);
  const err = cq.error as (Error & { needRelay?: boolean }) | null;
  const levels = market === 'krx' ? '5단계' : market === 'us' ? '' : '15단계';
  const venue = coin ? EX_NAME[coinExOf(sym)!] : MARKETS[market].name;

  // 머리 요약 줄 '진단 보기' — 휴대폰은 [내 평단] 탭, 넓은 화면은 오른쪽 진단 카드로
  const openPos = () => {
    if (!md) { setTab('pos'); requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })); }
    else document.getElementById('pos-card')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  const hide = (t: Tab) => tab !== t && 'max-md:hidden';
  const bookHead = (
    <PanelHead tabTitle={false} caption={[venue, levels].filter(Boolean).join(' · ')}
      title={<>호가{levels ? <small className="ml-1.5 text-[14px] font-semibold text-muted-foreground">{levels}</small> : null}</>}
      right={market === 'us' ? null : <LiveBadge market={market} q={q} />} />
  );
  const chartBox = 'h-[420px] md:h-[520px] lg:h-[600px]';

  return (
    <div className="space-y-2 sm:space-y-3 lg:space-y-4">
      {/* ── 가격 머리 ── */}
      <Card className="pt-[22px] pb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <SymbolLogo sym={sym} size={40} />
            <h1 className="min-w-0 truncate text-[20px] font-bold tracking-[-0.02em]">{name}</h1>
            {/* 코인은 거래소와 상관없이 한 이름 + 티커 — 거래소는 옆 전환 버튼이 말해 준다 */}
            {base ? (name !== base && <span className="shrink-0 text-[15px] text-muted-foreground">{base}</span>) : (
              <span className="min-w-0 truncate text-[15px] text-muted-foreground">
                {n.sub}{n.ex ? ` · ${n.ex}` : ''}<span className="max-sm:hidden"> · {MARKETS[market].name}</span>
              </span>
            )}
          </div>
          <ExchangeSwitch sym={sym} iv={iv} className="max-sm:order-last max-sm:basis-full" />
          <button
            onClick={() => toggleWatch(sym)} aria-pressed={watched} aria-label={watched ? '관심 종목에서 빼기' : '관심 종목에 담기'}
            className="press ml-auto inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-secondary px-3.5 text-[14px] font-semibold text-secondary-foreground hover:bg-border/60 sm:h-10"
          >
            <Star aria-hidden className={cn('size-[18px]', watched ? 'fill-[#ffc342] stroke-[#d39200] dark:fill-[#ffd158] dark:stroke-[#ffd158]' : 'text-faint')} strokeWidth={watched ? 2 : 1.8} />관심
          </button>
        </div>
        {/* 가격 줄 — 휴대폰은 김프·상태를 다음 줄로 */}
        <div className="mt-3 min-w-0">
          <BigPrice price={price} market={market} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ChangeLine market={market} q={q} price={price} />
          <span aria-hidden className="h-3.5 w-px bg-border max-sm:hidden" />
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 max-sm:basis-full">
            {k != null ? <span className="text-[14px] text-muted-foreground tabular">김프 <b className="font-semibold text-secondary-foreground">{k > 0 ? '+' : k < 0 ? MINUS : ''}{Math.abs(k).toFixed(2)}%</b></span> : null}
            <LiveBadge market={market} q={q} />
          </span>
        </div>
        <QuoteStats sym={sym} market={market} q={q} />
        {/* 내 평단 — 없으면 바로 넣는 칸, 있으면 요약 한 줄 (전체 진단은 [내 평단] 탭 · 오른쪽 카드) */}
        <div className="mt-4">
          <PositionHeadline sym={sym} onOpen={openPos} onSaved={() => { if (!md) setTab('pos'); }} />
        </div>
      </Card>

      {/* ── 차트 | 호가(PC) ── */}
      <div className="grid gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1fr)_392px] lg:gap-4">
        <section aria-label="차트" className="min-w-0 overflow-hidden rounded-[20px] bg-card pt-4 pb-3 max-sm:rounded-none md:pt-5">
          <div className="mb-3 flex flex-col gap-2.5 px-3 md:px-4">
            <IntervalBar ivs={ivs} iv={iv} onPick={(v) => navigate('chart', sym, v)} />
            <div className="px-1"><IndicatorChips toggles={toggles} daily={iv === '1d'} /></div>
          </div>
          <div className="relative">
            {merged && ind ? (
              <CandleChart market={market} iv={iv} candles={merged} ind={ind} toggles={toggles} forecast={forecast.data} live={liveNow} dir={dirNow} boxClassName={chartBox} />
            ) : <div className={cn('mt-[44px]', chartBox)} />}
            {(cq.isLoading || waitMsg) && !merged && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[14px] text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />{waitMsg || '차트 불러오는 중…'}
              </div>
            )}
            {err && !merged && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-muted-foreground">
                <p className="max-w-[320px] break-keep">{err.message}</p>
                {err.needRelay ? <a href={href('chart', sym, '1d')} className="press inline-flex h-11 items-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground">일봉 보기</a>
                  : <button onClick={() => cq.refetch()} className="press h-11 rounded-xl bg-secondary px-4 font-semibold text-secondary-foreground">다시 시도</button>}
              </div>
            )}
          </div>
        </section>

        {/* 호가 — PC 오른쪽 (차트 카드 높이에 맞춰 늘어나고 그 안에서 스크롤) */}
        {lg ? (
          <div className="relative min-h-[560px]">
            <section aria-label="호가" className="absolute inset-0 flex flex-col rounded-[20px] bg-card px-6 pt-6 pb-5">
              {bookHead}
              <OrderBook sym={sym} market={market} mode="scroll" daily={daily} className="min-h-0 flex-1" />
            </section>
          </div>
        ) : null}
      </div>

      {/* ── 휴대폰: 탭 ── */}
      <div ref={tabsRef} className="scroll-mt-2 bg-card px-4 py-3 max-sm:rounded-none max-[359px]:px-3 sm:rounded-[20px] md:hidden">
        <Segmented full items={TABS} value={tab} onChange={setTab} />
      </div>

      {/* ── 아래 패널 — PC 는 왼쪽·오른쪽 세로 스택, 태블릿은 2열 격자(order), 휴대폰은 고른 탭만 ── */}
      <div className="grid items-start gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_392px] lg:gap-4">
        <div className="flex min-w-0 flex-col gap-2 sm:gap-3 md:contents lg:flex lg:gap-4">
          <Card className={cn('md:order-3 md:col-span-2', hide('analysis'))}>
            <CardTitle right={analysis ? <span className="text-[13px] text-muted-foreground">{IV_LABEL[iv]}봉 · 지표 {analysis.votes.length}개 종합</span> : null}>기술적 분석</CardTitle>
            <AnalysisPanel a={analysis} market={market} iv={iv} />
            <AiCommentary sym={sym} title="AI가 본 흐름 · 일봉" className="mt-5" />
          </Card>
          <Card className={cn('md:order-4 md:col-span-2', hide('analysis'))}>
            <CardTitle right={<span className="text-[13px] text-muted-foreground">{IV_LABEL[iv]}봉 기준</span>}>주요 지표</CardTitle>
            <KeyStats a={analysis} market={market} iv={iv} />
          </Card>
          <Card className={cn('md:order-5', hide('forecast'))}>
            <CardTitle right={<span className="text-[13px] text-muted-foreground">앞으로 14일 · 매일 한 번 학습</span>}>AI 예측</CardTitle>
            <ForecastPanel sym={sym} market={market} />
          </Card>
          {/* 자리: '이 자리에서 사면 단기·중기·장기 기대 수익률'(비슷한 과거 자리 백테스트) 카드 — AI 예측 바로 아래, 같은 [AI 예측] 탭 · md:order-5 */}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:gap-3 md:contents lg:flex lg:gap-4">
          {!lg ? (
            <Card className={cn('md:order-1', hide('book'))}>
              {bookHead}
              <OrderBook sym={sym} market={market} mode="fold" daily={daily} />
            </Card>
          ) : null}
          <div id="pos-card" className={cn('min-w-0 scroll-mt-24 md:order-2', hide('pos'))}>
            <PositionCard sym={sym} />
          </div>
          <Card className={cn('md:order-6', hide('news'))}>
            <PanelHead tabTitle={false} title={`${name} 뉴스`} caption={`${name} 관련 소식`}
              right={<a href={newsMoreUrl(sym)} target="_blank" rel="noopener" className="inline-flex h-9 items-center text-[14px] font-semibold text-muted-foreground hover:text-foreground">더보기<ChevronRight aria-hidden className="size-4" /></a>} />
            <NewsPanel sym={sym} market={market} />
          </Card>
        </div>
      </div>
    </div>
  );
}
