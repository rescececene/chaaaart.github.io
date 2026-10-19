// 종목 상세 — 가격 헤더 · 캔들 차트 · 호가창 · 기술적 분석 · AI 예측 · 뉴스
// 코인은 한 종목 — 업비트 원화·바이낸스 USDT 양쪽에 있으면 가격 헤더의 [업비트 | 바이낸스] 로 거래소만 바꾼다 (주기는 그대로)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, SlidersHorizontal, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { Card, CardTitle } from '@/components/common/Card';
import { Segmented } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { Flash } from '@/components/common/Change';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { CandleChart } from '@/components/chart/CandleChart';
import { OrderBook } from '@/components/chart/OrderBook';
import { AnalysisPanel } from '@/components/chart/AnalysisPanel';
import { ForecastPanel } from '@/components/chart/ForecastPanel';
import { NewsPanel } from '@/components/chart/NewsPanel';
import { PositionCard } from '@/components/chart/PositionCard';
import { AiCommentary } from '@/components/chart/AiCommentary';
import { useNamesVersion, useQuote, useRelay, useWant } from '@/hooks/market';
import { coinBase, coinExOf, coinListsKnown, EX_NAME, useCoinsReady, venuesOf, type CoinEx } from '@/lib/coins';
import { analyze, series } from '@/lib/indicators';
import { applyLiveQuote } from '@/lib/liveCandle';
import { digits, fmt, fmtPrice, fmtPct, dirShown } from '@/lib/format';
import {
  candles as fetchCandles, DAILY, INTERVALS, isValidSym, IV_LABEL, IV_SEC, IV_UNIT, kimp, MARKETS, nameOf, newsMoreUrl, predictSymbol,
  refreshKimpRef, split, Store, type Candle, type Interval, type Market, type Sym,
} from '@/lib/market';
import { href, navigate } from '@/lib/router';
import { indStore, isWatched, toggleWatch, watchStore, type IndToggles } from '@/stores';

const TOGGLES: [keyof IndToggles, string][] = [['ma', '이동평균'], ['bb', '볼린저밴드'], ['vol', '거래량'], ['rsi', 'RSI'], ['macd', 'MACD'], ['cross', '골든/데드크로스'], ['forecast', 'AI 예측 경로 (일봉)']];
type Tab = 'book' | 'analysis' | 'forecast' | 'news';
const OTHER_EX: Record<CoinEx, string> = { upbit: '바이낸스 시세는 없어요', binance: '업비트 원화 마켓에는 없어요' };

/** 코인 거래소 전환 — 이 코인을 볼 수 있는 거래소만. 한 곳뿐이면 버튼 대신 이름표와 안내 */
function ExchangeSwitch({ sym, iv }: { sym: Sym; iv: Interval }) {
  const ready = useCoinsReady(); // 거래소 목록(coins.json)이 와야 어디서 거래되는지 안다
  const ex = coinExOf(sym);
  if (!ex) return null;
  if (!ready) return <div className="mt-3 h-9" aria-hidden />; // 목록이 오기 전엔 자리만 (잘못된 '없어요' 안내가 깜빡이지 않게)
  const list = venuesOf(sym);
  if (list.length > 1) {
    return (
      <div className="mt-3" role="group" aria-label="거래소">
        <Segmented size="sm" items={list.map((s) => ({ value: s, label: EX_NAME[coinExOf(s)!] }))} value={sym} onChange={(s) => navigate('chart', s, iv)} />
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="inline-flex rounded-xl bg-secondary p-1">
        <span className="rounded-[10px] bg-background px-2.5 py-1 text-[13px] font-semibold shadow-[0_1px_3px_rgba(0,0,0,0.12)] dark:bg-popover">{EX_NAME[ex]}</span>
      </span>
      {coinListsKnown() && <span className="text-[12.5px] break-keep text-muted-foreground">{OTHER_EX[ex]}</span>}
    </div>
  );
}

/** 큰 가격 — 늘 한 줄. 단위(원·USDT)는 작게 붙이고(토스식), 그래도 폭이 모자라면(긴 소수 가격·큰 글꼴 설정) 글자를 폭에 맞춰 줄인다 */
function BigPrice({ price, market }: { price: number | null; market: Market }) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const num = price == null ? '–' : (market === 'us' ? '$' : '') + fmtPrice(price, market);
  const unit = price == null || market === 'us' ? '' : market === 'binance' ? 'USDT' : '원';
  useLayoutEffect(() => {
    const b = box.current, t = text.current;
    if (!b || !t) return;
    const fit = () => {
      t.style.fontSize = ''; // CSS 크기(30px · md 34px)로 재 보고
      const avail = b.clientWidth;
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
    ro.observe(b);
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) fit(); }); // 웹 글꼴이 늦게 오면 폭이 달라진다
    return () => { alive = false; ro.disconnect(); };
  }, [num, unit]);
  return (
    <div ref={box} className="mt-2 min-w-0">
      <div ref={text} className="w-max text-[30px] leading-tight font-bold tracking-tight whitespace-nowrap tabular md:text-[34px]">
        <Flash value={price} className="px-0.5">
          {num}{unit && <span className={cn('font-semibold', unit === '원' ? 'ml-0.5 text-[0.7em]' : 'ml-1.5 text-[0.6em]')}>{unit}</span>}
        </Flash>
      </div>
    </div>
  );
}

export default function ChartPage({ args }: PageProps) {
  const sym = args[0] && isValidSym(args[0]) ? args[0] : Store.get('ml.lastSym', 'upbit:KRW-BTC');
  const [market] = split(sym);
  const ivs = INTERVALS[MARKETS[market].coin ? 'coin' : 'stock'];
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
  const [tab, setTab] = useState<Tab>('book');
  const [waitMsg, setWaitMsg] = useState<string | null>(null);
  useEffect(() => { document.title = `${name} ${q?.price != null ? fmtPrice(q.price, market) : ''} — 마켓렌즈`; }, [name, q?.price, market]);
  useEffect(() => { if (market === 'upbit') void refreshKimpRef(); }, [market]);

  // 캔들: 종목·주기별로 기억해 두었다가 다시 열면 바로 보여 준다
  const fast = !DAILY.has(iv) && (market === 'binance' || relayOk);
  const cq = useQuery({
    queryKey: ['candles', sym, iv, relayOk],
    queryFn: () => fetchCandles(sym, iv, (sec) => setWaitMsg(`업비트 요청 제한 때문에 ${sec}초 뒤 불러와요`)),
    refetchInterval: fast ? ((IV_SEC[iv] ?? 3600) <= 300 ? 20_000 : 30_000) : 60_000,
    staleTime: 10_000,
  });
  useEffect(() => { if (cq.data || cq.error) setWaitMsg(null); }, [cq.data, cq.error]);

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

  const price = q?.price ?? merged?.[merged.length - 1]?.c ?? null;
  const prevClose = q?.prevClose;
  const chgAmt = price != null && prevClose ? price - prevClose : null;
  const k = market === 'upbit' ? kimp(n.sub, price) : null;
  const watched = isWatched(watch, sym);
  // 지금 거래 중인가 (차트 끝점 깜빡임) — 코인은 실시간 시세가 오면, 주식은 실시간이면서 장 마감이 아닐 때
  const liveNow = MARKETS[market].coin ? !!q?.live : !!(q?.live && q.status !== 'CLOSE');
  // 등락 방향 (라인 색) — 머리의 등락률과 같은 규칙(0.00% 는 보합). 시세가 오기 전엔 차트가 스스로 계산
  const dirNow = q?.chg == null ? undefined : Math.sign(dirShown(q.chg) === 'flat' ? 0 : q.chg);
  const err = cq.error as (Error & { needRelay?: boolean }) | null;

  const intervalBar = (
    <Segmented size="sm" items={ivs.map((x) => ({ value: x, label: IV_LABEL[x] }))} value={iv} onChange={(v) => navigate('chart', sym, v)} />
  );
  const indicatorPop = (
    <Popover>
      <PopoverTrigger asChild>
        <button className="press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-secondary px-3 text-[13px] font-semibold text-secondary-foreground"><SlidersHorizontal className="size-4" />지표</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 rounded-2xl p-2">
        {TOGGLES.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-[14px] hover:bg-hover">
            {label}
            <Switch checked={!!toggles[key]} onCheckedChange={(v) => indStore.set((t) => ({ ...t, [key]: v }))} />
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="space-y-3">
      {/* 가격 헤더 */}
      <section className="rounded-[20px] bg-card px-5 py-5 md:px-6">
        {/* 이름 줄 — 관심 버튼을 같은 줄 오른쪽에 두어 가격이 폭을 다 쓰게 한다 (휴대폰에선 별 아이콘만) */}
        <div className="flex items-center gap-2.5">
          <SymbolLogo sym={sym} size={32} />
          <h1 className="min-w-0 truncate text-[19px] font-bold tracking-tight">{name}</h1>
          {/* 코인은 거래소와 상관없이 한 이름 (업비트에 있으면 한글 이름) + 티커 — 거래소는 아래 전환 버튼이 말해 준다 */}
          {base ? (name !== base && <span className="shrink-0 text-[13px] text-muted-foreground">{base}</span>) : (
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {n.sub}{n.ex ? ` · ${n.ex}` : ''}<span className="max-sm:hidden"> · {MARKETS[market].name}</span>
            </span>
          )}
          <button
            onClick={() => toggleWatch(sym)} aria-pressed={watched} aria-label="관심 종목"
            className={cn('press ml-auto inline-flex size-10 shrink-0 items-center justify-center gap-1.5 rounded-xl text-[14px] font-semibold sm:w-auto sm:px-3.5', watched ? 'bg-foreground text-background' : 'bg-secondary text-secondary-foreground')}
          >
            <Star className={cn('size-4', watched && 'fill-current')} /><span className="max-sm:hidden">{watched ? '관심 종목' : '관심 추가'}</span>
          </button>
        </div>
        <ExchangeSwitch sym={sym} iv={iv} />
        <BigPrice price={price} market={market} />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
          <span className={cn('font-semibold tabular', dirShown(q?.chg) === 'up' ? 'text-up-text' : dirShown(q?.chg) === 'down' ? 'text-down-text' : 'text-muted-foreground')}>
            <span className="mr-1 text-muted-foreground">{market === 'binance' ? '24시간 전보다' : '어제보다'}</span>
            {/* 변동폭은 가격과 같은 자릿수로 (1,345원이 1원 내리면 -1.000 이 아니라 -1) */}
            {chgAmt != null && <>{chgAmt > 0 ? '+' : ''}{fmt(chgAmt, digits(price, market))} </>}({fmtPct(q?.chg)})
          </span>
          {k != null && <span className="rounded-md bg-secondary px-2 py-0.5 text-[12px] font-semibold text-secondary-foreground">김프 {fmtPct(k)}</span>}
          {q?.live ? <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><span className="size-1.5 rounded-full bg-good" />{q.status === 'CLOSE' ? '장 마감' : '실시간'}</span>
            : q ? <span className="text-[12px] text-muted-foreground">지연 시세</span> : null}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* 차트 */}
        <section className="overflow-hidden rounded-[20px] bg-card">
          <div className="flex items-center gap-2 px-3 pt-3 md:px-4">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">{intervalBar}</div>
            {indicatorPop}
          </div>
          <div className="relative h-[440px] md:h-[560px]">
            {merged && ind ? (
              <CandleChart market={market} iv={iv} candles={merged} ind={ind} toggles={toggles} forecast={forecast.data} live={liveNow} dir={dirNow} className="h-full" />
            ) : null}
            {(cq.isLoading || waitMsg) && !merged && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[14px] text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />{waitMsg || '차트 불러오는 중…'}
              </div>
            )}
            {err && !merged && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-muted-foreground">
                <p>{err.message}</p>
                {err.needRelay ? <a href={href('chart', sym, '1d')} className="press rounded-xl bg-primary px-4 py-2 font-semibold text-primary-foreground">일봉 보기</a>
                  : <button onClick={() => cq.refetch()} className="press rounded-xl bg-secondary px-4 py-2 font-semibold">다시 시도</button>}
              </div>
            )}
          </div>
        </section>

        {/* 호가 — PC 오른쪽 */}
        <section className="hidden rounded-[20px] bg-card p-4 lg:block">
          <CardTitle className="mb-2" right={<span className="text-[12px] text-muted-foreground">{market === 'krx' ? '5단계 · 1.5초' : market === 'us' ? '' : '실시간'}</span>}>호가</CardTitle>
          <OrderBook sym={sym} market={market} maxHeight={market === 'krx' ? undefined : 470} />
        </section>
      </div>

      {/* 내 평단 진단 — 차트 바로 아래 전체 폭 (휴대폰 탭 밖이라 들어오자마자 보인다). 평단은 sym 별(거래소마다 단위가 다름) */}
      <PositionCard sym={sym} />

      {/* 휴대폰: 탭 */}
      <div className="lg:hidden">
        <Segmented full items={[{ value: 'book', label: '호가' }, { value: 'analysis', label: '분석' }, { value: 'forecast', label: 'AI 예측' }, { value: 'news', label: '뉴스' }]} value={tab} onChange={setTab} />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <Card className={cn(tab !== 'book' && 'hidden', 'lg:hidden')}>
            <OrderBook sym={sym} market={market} />
          </Card>
          <Card className={cn(tab !== 'forecast' && 'hidden lg:block')}>
            <CardTitle sub="하루 한 번 전 종목을 학습해 상대 순위를 매겨요">AI 예측</CardTitle>
            <ForecastPanel sym={sym} market={market} />
          </Card>
          <Card className={cn(tab !== 'analysis' && 'hidden lg:block')}>
            <CardTitle>기술적 분석</CardTitle>
            <AnalysisPanel a={analysis} market={market} iv={iv} />
            <AiCommentary sym={sym} title="AI가 본 흐름 · 일봉" className="mt-6" />
          </Card>
        </div>
        <Card className={cn('self-start', tab !== 'news' && 'hidden lg:block')}>
          <CardTitle right={<a href={newsMoreUrl(sym)} target="_blank" rel="noopener" className="text-[13px] font-semibold text-muted-foreground">더보기</a>}>{name} 뉴스</CardTitle>
          <NewsPanel sym={sym} market={market} />
        </Card>
      </div>
    </div>
  );
}
