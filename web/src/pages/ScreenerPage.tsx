// 종목 골라보기 (스크리너) — 일봉 기술적 신호(GitHub Actions 가 10분마다 계산) + 실시간 시세로 종목 고르기
// 시장은 코인 · 국내주식 · 미국주식, 코인은 그 아래에서 거래소(업비트 원화 | 바이낸스 USDT)를 고른다 — 데이터는 거래소별 그대로
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { CloudOff, Hourglass, SearchX } from 'lucide-react';
import type { PageProps } from '@/App';
import { Card, Empty, PageTitle, RowSkeleton } from '@/components/common/Card';
import { UnderlineTabs } from '@/components/common/Segmented';
import { CoinExSwitch } from '@/components/market/CoinVenues';
import { ScreenerRowItem } from '@/components/screener/ScreenerRow';
import { SignalChips, SignalHelp } from '@/components/screener/SignalChips';
import { SortHeader, SortMenu } from '@/components/screener/SortMenu';
import { useHeaderHeight, useMedia } from '@/components/screener/useMedia';
import { errorText, isNoData, loadSort, mergeLive, parseChips, pickMarket, saveSort, sortEntries, type Sort } from '@/components/screener/model';
import { useInterval, useQuotesTick, useWant } from '@/hooks/market';
import { isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, type CoinEx } from '@/lib/coins';
import { timeAgo } from '@/lib/format';
import { coinsLoaded, getQuote, loadCoins, MARKETS, remember, screener, Store, type HttpError } from '@/lib/market';
import { navigate } from '@/lib/router';

const LIMIT = 300; // 한 번에 그리는 최대 행 수 (이전 버전과 같다)
interface View { src: string; keys: string[]; all: boolean }
// 이 탭이 열려 있는 동안 기억 — 고른 신호·'더 보기' (이전 버전도 화면 객체에 들고 있었다), 마지막으로 누른 행
let lastView: View | null = null;
let anchor: { src: string; sym: string; y: number } | null = null;
type Group = 'coin' | 'krx' | 'us';
const TABS: { value: Group; label: string }[] = [{ value: 'coin', label: '코인' }, { value: 'krx', label: '국내주식' }, { value: 'us', label: '미국주식' }];
const textBtn = 'press rounded-xl bg-secondary px-4 py-2 text-[14px] font-semibold text-secondary-foreground';

export default function ScreenerPage({ args }: PageProps) {
  const market = pickMarket(args[0]);
  const coin = MARKETS[market].coin;
  useEffect(() => { Store.set('ml.scrM', market); if (isCoinEx(market)) saveCoinEx(market); }, [market]);
  useEffect(() => { if (isCoinEx(market)) settleCoinArg('screener', args, market); }, [args, market]);
  useEffect(() => { document.title = `종목 골라보기 · ${coin ? '코인 · ' : ''}${MARKETS[market].name} — 마켓렌즈`; }, [market, coin]);

  // 거래소 전체 시세('업비트:*')는 코인 목록이 온 다음에 구독해야 빠짐없이 붙는다
  const [coinsReady, setCoinsReady] = useState(coinsLoaded);
  useEffect(() => { if (!coinsReady) void loadCoins().then(() => setCoinsReady(true)); }, [coinsReady]);
  useWant(coin && !coinsReady ? null : [`${market}:*`]);

  const wide = useMedia('(min-width: 1024px)');
  const headerH = useHeaderHeight(wide);
  const sq = useQuery({
    queryKey: ['screener', market],
    queryFn: async () => {
      const d = await screener(market);
      for (const r of d.rows) remember(r.sym, { name: r.name, sub: r.sub, ex: r.ex ?? undefined });
      return d;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
    retry: (n, e) => !isNoData(e) && n < 1,
  });
  const data = sq.data;

  // 정렬·개수는 시세가 바뀌어도 최대 1초에 한 번만 다시 계산 (행은 각자 자기 시세로 바로 바뀐다)
  const prefix = `${market}:`;
  const tick = useQuotesTick(1000, (changed) => { for (const s of changed) if (s.startsWith(prefix)) return true; return false; });
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useInterval(rerender, 30_000); // 'n분 전 계산' 글자
  const entries = useMemo(() => {
    void tick;
    return data ? data.rows.map((r) => mergeLive(r, getQuote(r.sym))) : [];
  }, [data, tick]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) for (const s of e.sig) c[s] = (c[s] || 0) + 1;
    return c;
  }, [entries]);

  const [sort, setSort] = useState<Sort>(loadSort);
  const changeSort = (s: Sort) => { setSort(s); saveSort(s); };

  // 고른 신호 — 주소(#/screener/시장/신호)로 시작할 수 있고, 시장을 바꾸면 비운다.
  // 칩을 누를 때마다 주소를 바꾸면 화면이 맨 위로 올라가므로 누른 뒤의 상태는 화면 안에만 두고,
  // 차트를 보고 돌아와도 남아 있게 모듈 변수에도 적어 둔다.
  const chipArg = args[1] ?? '';
  const src = `${market}/${chipArg}`;
  const urlChips = useMemo(() => parseChips(chipArg), [chipArg]);
  const [view, setView] = useState<View>(() => (lastView?.src === src ? lastView : { src, keys: urlChips, all: false }));
  if (view.src !== src) setView({ src, keys: urlChips, all: false });
  useEffect(() => { lastView = view; }, [view]);
  const cur = view.src === src ? view : null;
  const chips = cur ? cur.keys : urlChips;
  const toggleChip = (k: string) => setView((v) => {
    const keys = v.src === src ? v.keys : urlChips;
    return { src, all: v.src === src && v.all, keys: keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k] };
  });
  const clearChips = () => setView((v) => ({ src, all: v.src === src && v.all, keys: [] }));
  // 코인 탭은 마지막으로 고른 거래소로. 거래소만 바꿀 때는 같은 코인 시장이니 고른 조건을 주소에 실어 그대로 잇는다
  const goGroup = (g: Group) => { if (g !== (coin ? 'coin' : market)) navigate('screener', g === 'coin' ? storedCoinEx() : g); };
  const goEx = (ex: CoinEx) => { if (ex !== market) { saveCoinEx(ex); navigate('screener', ex, chips.join(',')); } };

  const list = useMemo(
    () => sortEntries(chips.length ? entries.filter((e) => chips.every((c) => e.sig.includes(c))) : entries.slice(), sort),
    [entries, chips, sort],
  );
  const shown = cur?.all ? list : list.slice(0, LIMIT);

  // 행을 눌러 차트로 갔다가 돌아오면 그 행이 같은 높이에 오도록 맞춘다 (이 화면이 처음 그려질 때 한 번)
  const pending = useRef(anchor?.src === src ? anchor : null);
  useLayoutEffect(() => {
    anchor = null; // 다른 시장으로 돌아온 경우에도 묵은 위치는 버린다
    const a = pending.current;
    if (!a || !data) return;
    const el = document.querySelector<HTMLElement>(`a[data-sym="${CSS.escape(a.sym)}"]`);
    if (!el) { pending.current = null; return; }
    // 화면 밖 행은 어림 높이로 자리만 잡혀 있다가 보이는 순간 실제 높이가 되므로, 몇 프레임 동안 다시 맞춘다
    let tries = 0, raf = 0;
    const fix = () => {
      const d = el.getBoundingClientRect().top - a.y;
      if (Math.abs(d) > 1) window.scrollBy(0, d);
      if (++tries < 10) raf = requestAnimationFrame(fix);
      else pending.current = null;
    };
    fix();
    return () => cancelAnimationFrame(raf);
  }, [data, src]);
  const rememberRow = (ev: React.MouseEvent) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // 새 탭으로 열 때는 이 화면이 그대로 남는다
    const a = (ev.target as HTMLElement).closest<HTMLElement>('a[data-sym]');
    if (a?.dataset.sym) anchor = { src, sym: a.dataset.sym, y: a.getBoundingClientRect().top };
  };

  const firstLive = entries.find((e) => e.live);
  const closed = !coin && firstLive != null && getQuote(firstLive.row.sym)?.status === 'CLOSE';
  const updated = data ? Date.parse(data.updatedAt) : null;
  const err = sq.error as HttpError | null;
  const failed = !data && !!err;

  const status = updated ? (
    <div className="flex items-center gap-1.5 pb-0.5 text-[13px] text-muted-foreground">
      {firstLive && <><span className={closed ? 'size-1.5 rounded-full bg-faint' : 'size-1.5 rounded-full bg-good'} />{closed ? '장 마감' : '실시간 시세'}<span className="text-faint">·</span></>}
      <span title={new Date(updated).toLocaleString('ko-KR')}>{timeAgo(updated)} 계산</span>
    </div>
  ) : null;

  let body: React.ReactNode;
  if (data) {
    body = list.length ? (
      <>
        {shown.map((e) => <ScreenerRowItem key={e.row.sym} row={e.row} market={market} wide={wide} />)}
        {list.length > shown.length && (
          <div className="pt-3 pb-1 text-center">
            <button onClick={() => setView((v) => ({ src, keys: v.src === src ? v.keys : urlChips, all: true }))} className={textBtn}>나머지 {list.length - shown.length}종목 더 보기</button>
          </div>
        )}
      </>
    ) : (
      <Empty icon={<SearchX className="size-9" strokeWidth={1.6} />} action={chips.length ? <button onClick={clearChips} className={textBtn}>조건 선택 해제</button> : undefined}>
        {chips.length ? <span className="break-keep">고른 조건에 모두 맞는 종목이 없어요<br /><span className="text-[13px] text-subtle">조건을 하나씩 빼 보세요</span></span> : '계산된 종목이 없어요'}
      </Empty>
    );
  } else if (err) {
    body = isNoData(err) ? (
      <Empty icon={<Hourglass className="size-9" strokeWidth={1.6} />}>
        <span className="break-keep">아직 계산된 데이터가 없어요<br /><span className="text-[13px] text-subtle">첫 수집이 끝나면 10분마다 새로 계산돼요</span></span>
      </Empty>
    ) : (
      <Empty icon={<CloudOff className="size-9" strokeWidth={1.6} />} action={<button onClick={() => void sq.refetch()} className={textBtn}>다시 시도</button>}>
        <span className="break-keep">종목 데이터를 불러오지 못했어요<br /><span className="text-[13px] text-subtle">{errorText(err)}</span></span>
      </Empty>
    );
  } else {
    body = <div className="-mx-2"><RowSkeleton rows={8} /></div>;
  }

  return (
    <div className="space-y-3">
      <PageTitle sub="조건을 고르면 딱 맞는 종목만 골라 드려요" right={status}>종목 골라보기</PageTitle>

      <Card className="p-0 md:p-0">
        <div className="border-b border-border px-5 md:px-6">
          <UnderlineTabs items={TABS} value={coin ? 'coin' : (market as Group)} onChange={goGroup} />
        </div>
        {/* 코인 — 거래소만 바꾸고, 고른 조건은 그대로 이어서 본다 */}
        {isCoinEx(market) && <CoinExSwitch value={market} onChange={goEx} className="px-5 pt-4 md:px-6 md:pt-5" />}

        <div className="px-5 pt-4 md:px-6 md:pt-5">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <p className="min-w-0 text-[13px] break-keep text-muted-foreground">
              <span className="font-semibold text-foreground">조건</span><span className="text-faint"> · </span>여러 개 고르면 모두 맞는 종목만 보여요
            </p>
            {chips.length > 0 && (
              <button onClick={clearChips} className="press shrink-0 text-[13px] font-semibold text-muted-foreground hover:text-foreground">선택 해제</button>
            )}
          </div>
          <SignalChips selected={chips} counts={data ? counts : null} onToggle={toggleChip} />
          <SignalHelp selected={chips} />
        </div>

        <div className="px-5 pb-3 md:px-6 md:pb-4">
          <div className="mt-5 mb-1 flex min-h-9 items-center justify-between gap-3">
            <p className="min-w-0 text-[14px] text-muted-foreground tabular">
              {data ? (chips.length
                ? <>{entries.length}종목 중 <b className="font-bold text-foreground">{list.length}</b>종목</>
                : <><b className="font-bold text-foreground">{entries.length}</b>종목</>) : ' '}
            </p>
            {!wide && !failed && <SortMenu sort={sort} onChange={changeSort} />}
          </div>
          {wide && !failed && <SortHeader sort={sort} onChange={changeSort} top={headerH} />}
          <motion.div key={market} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }} className={wide ? 'pt-1' : undefined} onClick={rememberRow}>
            {body}
          </motion.div>
        </div>
      </Card>

      <p className="px-1 text-[12.5px] leading-relaxed break-keep text-subtle">
        일봉 기준으로 10분마다 다시 계산해요. 가격·등락률·급등/급락은 실시간 시세를 반영하고, 거래량 배수는 오늘 거래량 ÷ 최근 20일 평균이에요.
        조건은 과거 가격 움직임으로 계산한 참고 자료일 뿐, 오르거나 내린다는 보장은 아니에요.
      </p>
    </div>
  );
}
