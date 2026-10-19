// 유망 종목 — 하루 한 번 전 종목을 학습한 순위 모델의 상위·하위 종목과, 그 모델의 과거 성적
// 시장은 코인 · 국내주식 · 미국주식, 코인은 거래소(업비트 원화 | 바이낸스 USDT)를 따로 고른다 — 모델은 거래소별 그대로
import { memo, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { AiMark, Card, CARD_CLS, CardTitle, Empty, PageTitle } from '@/components/common/Card';
import { Segmented } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { Sparkline } from '@/components/common/Sparkline';
import { AiRange } from '@/components/common/RangeBar';
import { Skeleton } from '@/components/ui/skeleton';
import { DotList, ratioText, ReasonText } from '@/components/chart/ForecastPanel';
import { CoinExSwitch } from '@/components/market/CoinVenues';
import { EquityChart } from '@/components/picks/EquityChart';
import { useQuote, useWant } from '@/hooks/market';
import { isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, tickerOf, type CoinEx } from '@/lib/coins';
import { fmtPrice, timeAgo } from '@/lib/format';
import { MARKET_KEYS, MARKETS, predictSummary, remember, Store, type Market, type PredictMarket, type PredictPick } from '@/lib/market';
import { href, navigate } from '@/lib/router';

const DIR = (x: number) => (x > 0 ? 'text-up-text' : x < 0 ? 'text-down-text' : 'text-foreground');
type Group = 'coin' | 'krx' | 'us';
const GROUPS: { value: Group; label: string }[] = [{ value: 'coin', label: '코인' }, { value: 'krx', label: '국내주식' }, { value: 'us', label: '미국주식' }];
const isMarketKey = (x: unknown): x is Market => typeof x === 'string' && (MARKET_KEYS as string[]).includes(x);
/** 주소의 시장 → 없으면 마지막으로 본 시장 (코인이면 마지막으로 고른 거래소 · #/picks/coin 도 그쪽) */
function pickMarket(arg: string | undefined): Market {
  if (arg === 'coin') return storedCoinEx();
  if (isMarketKey(arg)) return arg;
  const s = Store.get<unknown>('ml.picksM', 'upbit');
  return isMarketKey(s) && !isCoinEx(s) ? s : storedCoinEx();
}

/** 예측력이 약하면 숨기지 말고 먼저 알린다 */
function weak(m: PredictMarket) {
  const b = m.backtest;
  return b.rankIC == null || b.rankIC < 0.015 || (b.topExcess ?? 0) <= 0;
}

const PickCard = memo(function PickCard({ p, market, horizon }: { p: PredictPick; market: Market; horizon: number }) {
  const q = useQuote(p.sym);
  const unit = MARKETS[market].coin ? '일' : '거래일';
  return (
    <a href={href('chart', p.sym, '1d')} className={cn(CARD_CLS, 'press flex flex-col px-4 pt-5 pb-4 transition-colors hover:bg-hover sm:p-[22px] sm:pb-[18px]')}>
      {/* 머리: 순위 · 로고 · 이름/티커 — 오른쪽 점수 · 이길 확률(방향이 아닌 값이라 회색) */}
      <div className="grid grid-cols-[auto_40px_minmax(0,1fr)_auto] items-center gap-x-2.5">
        <span className="min-w-3.5 text-center text-[15px] font-bold text-text-3 tabular">{p.rank}</span>
        <SymbolLogo sym={p.sym} size={40} />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-[16px] leading-[22px] font-bold">{p.name}</b>
          <span className="truncate text-[13px] text-muted-foreground">{tickerOf(market, p.sub)}</span>
        </div>
        <div className="flex flex-col items-end">
          <b className="text-[24px] leading-[30px] font-bold tracking-[-0.02em] tabular">{Math.round(p.score)}<small className="ml-px text-[14px] font-semibold text-text-3">점</small></b>
          {p.probUp != null && <span className="text-[12.5px] whitespace-nowrap text-muted-foreground tabular" title={`${horizon}${unit} 뒤 시장 중앙값보다 오를 확률`}>이길 확률 {Math.round(p.probUp * 100)}%</span>}
        </div>
      </div>
      <div className="mt-3.5 flex items-end justify-between gap-2">
        <span className="flex flex-col">
          <b className="text-[18px] font-bold tabular">{fmtPrice(q?.price ?? p.spark[p.spark.length - 1], market)}</b>
          <ChangeText value={q?.chg} className="text-[14px] font-semibold" />
        </span>
        <Sparkline data={p.spark} width={112} height={40} area={false} />
      </div>
      {p.q10 != null && p.q50 != null && p.q90 != null && (
        <AiRange className="mt-3.5" q10={p.q10} q50={p.q50} q90={p.q90} label={`${horizon}${unit} 뒤 예상 범위`} />
      )}
      {p.reasons.length > 0 && <DotList className="mt-2.5" itemClass="py-[3px] text-[13.5px] leading-5 before:top-[11px]" items={p.reasons.slice(0, 3).map((r) => r.text)} />}
      {p.analog && (
        <p className="mt-auto pt-3">
          <span className="block rounded-xl bg-tile px-3 py-2.5 text-[13px] leading-[19px] text-text-3">
            비슷했던 과거 차트 {p.analog.n}번 중 <b className="text-foreground">{Math.round(p.analog.winRate * 100)}%</b>가 올랐고 평균 <b className={DIR(p.analog.avg)}>{ratioText(p.analog.avg)}</b>
          </span>
        </p>
      )}
    </a>
  );
});

const AvoidRow = memo(function AvoidRow({ p, market }: { p: PredictPick; market: Market }) {
  const q = useQuote(p.sym);
  return (
    <a href={href('chart', p.sym, '1d')} className="press -mx-2 flex items-center gap-3 rounded-[14px] px-2 py-2.5 transition-colors hover:bg-hover">
      <SymbolLogo sym={p.sym} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{p.name}</div>
        <div className="truncate text-[13px] text-muted-foreground">{p.reasons[0]?.text ? <ReasonText text={p.reasons[0].text} /> : tickerOf(market, p.sub)}</div>
      </div>
      <div className="text-right">
        <div className="text-[15px] font-semibold tabular">{fmtPrice(q?.price ?? p.spark[p.spark.length - 1], market)}</div>
        <div className="text-[13px] text-muted-foreground tabular">{Math.round(p.score)}점</div>
      </div>
    </a>
  );
});

const BtTile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="rounded-[14px] bg-tile px-1 py-2.5 text-center">
    <div className="text-[12.5px] whitespace-nowrap text-muted-foreground">{label}</div>
    <div className="text-[17px] font-bold tabular">{children}</div>
  </div>
);

export default function PicksPage({ args }: PageProps) {
  const market = pickMarket(args[0]);
  const group: Group = isCoinEx(market) ? 'coin' : market === 'krx' ? 'krx' : 'us';
  useEffect(() => { Store.set('ml.picksM', market); if (isCoinEx(market)) saveCoinEx(market); }, [market]);
  useEffect(() => { if (isCoinEx(market)) settleCoinArg('picks', args, market); }, [args, market]);
  const goGroup = (g: Group) => { if (g !== group) navigate('picks', g === 'coin' ? storedCoinEx() : g); };
  const goEx = (ex: CoinEx) => { if (ex !== market) { saveCoinEx(ex); navigate('picks', ex); } };
  const { data, isLoading, isError } = useQuery({ queryKey: ['predict-summary'], queryFn: predictSummary, staleTime: 10 * 60e3, retry: false });
  const m = data?.markets?.[market];
  const syms = useMemo(() => (m ? [...m.picks, ...m.avoid].map((p) => p.sym) : []), [m]);
  useEffect(() => { if (m) [...m.picks, ...m.avoid].forEach((p) => remember(p.sym, { name: p.name, sub: p.sub })); }, [m]);
  useWant(syms);
  useEffect(() => { document.title = `유망 종목 · ${MARKETS[market].name} — 마켓`; return () => { document.title = '마켓'; }; }, [market]);
  const unit = MARKETS[market].coin ? '일' : '거래일';
  const grid = 'grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4';

  return (
    <div>
      <PageTitle sub={<span>매일 전 종목 차트를 학습해, 앞으로 {m?.horizon ?? (MARKETS[market].coin ? 14 : 20)}{unit} 동안 시장보다 나을 가능성이 높은 순서예요</span>}>
        유망 종목<AiMark big />
      </PageTitle>
      {/* 회색 바탕 위 세그먼트 — 홈이 바탕과 같은 색이라 흰 손잡이만 보인다 (휴대폰은 각각 폭 가득) */}
      <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 sm:mx-0 sm:mb-4">
        <Segmented items={GROUPS} value={group} onChange={goGroup} className="max-sm:flex max-sm:w-full max-sm:[&>button]:flex-1" />
        {isCoinEx(market) && <CoinExSwitch value={market} onChange={goEx} className="w-full sm:w-auto" />}
      </div>

      {isLoading && <div className={grid}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-72 rounded-[20px] bg-card max-sm:rounded-none" />)}</div>}
      {!isLoading && (isError || !m) && (
        <Card><Empty icon={<Sparkles />} title="예측 데이터를 준비하고 있어요">하루 한 번 새로 계산되니 잠시 뒤 다시 확인해 주세요.</Empty></Card>
      )}
      {m && (
        <div className="space-y-2 sm:space-y-3 lg:space-y-4">
          {weak(m) && (
            <div className={cn(CARD_CLS, 'flex gap-3 px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              <p className="text-secondary-foreground"><b className="font-semibold text-foreground">이 시장에서는 과거 검증 성적이 약해요.</b> 상위 종목이 시장보다 확실히 나았다고 보기 어려워서, 아래 결과는 참고 정도로만 보세요.</p>
            </div>
          )}
          {/* grid-cols-1: 칸을 화면 폭에 묶는다 (안 그러면 한 줄로 자르는 긴 이유 글이 칸을 밀어 휴대폰에서 가로로 넘친다) */}
          <div className={grid}>
            {m.picks.map((p) => <PickCard key={p.sym} p={p} market={market} horizon={m.horizon} />)}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-4">
            <Card>
              <CardTitle sub={`${m.backtest.from} ~ ${m.backtest.to} · 겹치지 않게 ${m.backtest.periods}번 리밸런싱한 결과`}>이 모델의 과거 성적</CardTitle>
              <EquityChart data={m.backtest.equity} />
              <div className="mt-4 grid grid-cols-3 gap-2">
                <BtTile label="상위 10% 승률">{m.backtest.topHitRate == null ? '–' : Math.round(m.backtest.topHitRate * 100) + '%'}</BtTile>
                <BtTile label="평균 초과수익"><span className={DIR(m.backtest.topExcess ?? 0)}>{ratioText(m.backtest.topExcess)}</span></BtTile>
                <BtTile label="순위 상관(IC)">{m.backtest.rankIC == null ? '–' : m.backtest.rankIC.toFixed(3)}</BtTile>
              </div>
              {m.notes.length > 0 && <ul className="mt-4 list-disc space-y-1 pl-5 text-[13px] leading-[1.55] text-muted-foreground">{m.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              <p className="mt-3 text-[12.5px] text-muted-foreground">모델 {m.model.kind} · 학습 {m.model.trainRows.toLocaleString('ko-KR')}행 · 지표 {m.model.features}개 · {timeAgo(Date.parse(m.model.trainedAt))} 학습 · {m.asOf} 기준 {m.universe}개 종목</p>
            </Card>
            <Card className="self-start">
              <CardTitle sub="점수가 가장 낮은 종목 — 피하거나 조심해서 볼 만한 곳">주의 종목</CardTitle>
              {m.avoid.length ? m.avoid.map((p) => <AvoidRow key={p.sym} p={p} market={market} />) : <Empty>없어요</Empty>}
            </Card>
          </div>
          <p className="mx-4 text-[12.5px] leading-[1.6] text-muted-foreground sm:mx-1">
            점수는 같은 시장 안에서의 상대 순위(0~100)이고, '이길 확률'은 시장 중앙값보다 나을 확률의 추정치예요. 과거 데이터로 검증한 통계 모델일 뿐 미래 수익을 보장하지 않으며 투자 권유가 아니에요.
          </p>
        </div>
      )}
    </div>
  );
}
