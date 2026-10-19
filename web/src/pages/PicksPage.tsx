// 유망 종목 — 하루 한 번 전 종목을 학습한 순위 모델의 상위·하위 종목과, 그 모델의 과거 성적
// 시장은 코인 · 국내주식 · 미국주식, 코인은 거래소(업비트 원화 | 바이낸스 USDT)를 따로 고른다 — 모델은 거래소별 그대로
import { memo, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { Card, CardTitle, Empty, PageTitle } from '@/components/common/Card';
import { Segmented } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { Sparkline } from '@/components/common/Sparkline';
import { Skeleton } from '@/components/ui/skeleton';
import { RangeBar } from '@/components/chart/ForecastPanel';
import { CoinExSwitch } from '@/components/market/CoinVenues';
import { EquityChart } from '@/components/picks/EquityChart';
import { useQuote, useWant } from '@/hooks/market';
import { isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, tickerOf, type CoinEx } from '@/lib/coins';
import { fmtPrice, fmtRatio, timeAgo } from '@/lib/format';
import { MARKET_KEYS, MARKETS, predictSummary, remember, Store, type Market, type PredictMarket, type PredictPick } from '@/lib/market';
import { href, navigate } from '@/lib/router';

const TONE_TEXT = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;
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
  return (
    <a href={href('chart', p.sym, '1d')} className="press flex flex-col gap-3 rounded-[20px] bg-card p-5 transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
      <div className="flex items-start gap-3">
        <div className="relative">
          <SymbolLogo sym={p.sym} size={40} />
          <span className="absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-background">{p.rank}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold">{p.name}</div>
          <div className="text-[12.5px] text-muted-foreground">{tickerOf(market, p.sub)}</div>
        </div>
        <div className="text-right">
          <div className="text-[22px] leading-none font-bold tracking-tight tabular">{Math.round(p.score)}<span className="text-[13px] font-semibold text-muted-foreground">점</span></div>
          {p.probUp != null && <div className={cn('mt-1 text-[12px] font-semibold tabular', p.probUp >= 0.5 ? 'text-up-text' : 'text-down-text')}>이길 확률 {Math.round(p.probUp * 100)}%</div>}
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[15px] font-bold tabular">{fmtPrice(q?.price ?? p.spark[p.spark.length - 1], market)}</div>
          <ChangeText value={q?.chg} className="text-[12.5px] font-semibold" />
        </div>
        <Sparkline data={p.spark} width={120} height={40} />
      </div>
      {p.q10 != null && p.q50 != null && p.q90 != null && (
        <div>
          <div className="mb-0.5 text-[12px] text-muted-foreground">{horizon}{MARKETS[market].coin ? '일' : '거래일'} 예상 범위</div>
          <RangeBar q10={p.q10} q50={p.q50} q90={p.q90} />
        </div>
      )}
      {p.reasons.length > 0 && (
        <ul className="space-y-1">
          {p.reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-snug">
              <span className={cn('mt-[3px] text-[9px]', TONE_TEXT[r.tone])} aria-hidden>{r.tone === 'up' ? '▲' : r.tone === 'down' ? '▼' : '●'}</span>
              <span className="break-keep text-secondary-foreground">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      {p.analog && (
        <div className="mt-auto rounded-xl bg-secondary/60 px-3 py-2 text-[12.5px] text-secondary-foreground">
          비슷했던 과거 차트 {p.analog.n}번 중 <b>{Math.round(p.analog.winRate * 100)}%</b>가 올랐고 평균 <b className={TONE_TEXT[p.analog.avg >= 0 ? 'up' : 'down']}>{fmtRatio(p.analog.avg)}</b>
        </div>
      )}
    </a>
  );
});

const AvoidRow = memo(function AvoidRow({ p, market }: { p: PredictPick; market: Market }) {
  const q = useQuote(p.sym);
  return (
    <a href={href('chart', p.sym, '1d')} className="press flex items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-hover">
      <SymbolLogo sym={p.sym} size={34} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{p.name}</div>
        <div className="truncate text-[12px] text-muted-foreground">{p.reasons[0]?.text || tickerOf(market, p.sub)}</div>
      </div>
      <div className="text-right">
        <div className="text-[14px] font-semibold tabular">{fmtPrice(q?.price ?? p.spark[p.spark.length - 1], market)}</div>
        <div className="text-[12px] text-down-text tabular">{Math.round(p.score)}점</div>
      </div>
    </a>
  );
});

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
  const unit = MARKETS[market].coin ? '일' : '거래일';

  return (
    <div>
      <PageTitle sub={<span className="break-keep">전 종목의 수년 치 차트를 매일 학습해, 앞으로 {m?.horizon ?? (MARKETS[market].coin ? 14 : 20)}{unit} 동안 시장보다 나을 가능성이 높은 순서로 매긴 결과예요.</span>}>
        <span className="inline-flex items-center gap-2">유망 종목 <Sparkles className="size-5 text-primary" /></span>
      </PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <Segmented items={GROUPS} value={group} onChange={goGroup} />
        {isCoinEx(market) && <CoinExSwitch value={market} onChange={goEx} onPage className="w-full sm:w-auto" />}
      </div>

      {isLoading && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-[20px]" />)}</div>}
      {!isLoading && (isError || !m) && (
        <Card><Empty icon={<Sparkles className="size-9" />}><span className="break-keep">예측 데이터를 준비하고 있어요.<br />하루 한 번 새로 계산되니 잠시 뒤 다시 확인해 주세요.</span></Empty></Card>
      )}
      {m && (
        <div className="space-y-3">
          {weak(m) && (
            <div className="flex gap-3 rounded-[20px] bg-card p-4 text-[13.5px]">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" />
              <p className="break-keep text-secondary-foreground"><b>이 시장에서는 과거 검증 성적이 약해요.</b> 상위 종목이 시장보다 확실히 나았다고 보기 어려워서, 아래 결과는 참고 정도로만 보세요.</p>
            </div>
          )}
          {/* grid-cols-1: 칸을 화면 폭에 묶는다 (안 그러면 한 줄로 자르는 긴 이유 글이 칸을 밀어 휴대폰에서 가로로 넘친다) */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {m.picks.map((p) => <PickCard key={p.sym} p={p} market={market} horizon={m.horizon} />)}
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card>
              <CardTitle sub={`${m.backtest.from} ~ ${m.backtest.to} · 겹치지 않게 ${m.backtest.periods}번 리밸런싱한 결과`}>이 모델의 과거 성적</CardTitle>
              <EquityChart data={m.backtest.equity} />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-secondary/60 py-2.5"><div className="text-[12px] text-muted-foreground">상위 10% 승률</div><div className="text-[17px] font-bold tabular">{m.backtest.topHitRate == null ? '–' : Math.round(m.backtest.topHitRate * 100) + '%'}</div></div>
                <div className="rounded-2xl bg-secondary/60 py-2.5"><div className="text-[12px] text-muted-foreground">평균 초과수익</div><div className={cn('text-[17px] font-bold tabular', TONE_TEXT[(m.backtest.topExcess ?? 0) >= 0 ? 'up' : 'down'])}>{fmtRatio(m.backtest.topExcess)}</div></div>
                <div className="rounded-2xl bg-secondary/60 py-2.5"><div className="text-[12px] text-muted-foreground">순위 상관(IC)</div><div className="text-[17px] font-bold tabular">{m.backtest.rankIC == null ? '–' : m.backtest.rankIC.toFixed(3)}</div></div>
              </div>
              {m.notes.length > 0 && <ul className="mt-4 list-disc space-y-1 pl-5 text-[12.5px] break-keep text-muted-foreground">{m.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              <p className="mt-3 text-[12px] text-subtle">모델 {m.model.kind} · 학습 {m.model.trainRows.toLocaleString('ko-KR')}행 · 지표 {m.model.features}개 · {timeAgo(Date.parse(m.model.trainedAt))} 학습 · {m.asOf} 기준 {m.universe}개 종목</p>
            </Card>
            <Card className="self-start">
              <CardTitle sub="점수가 가장 낮은 종목 — 피하거나 조심해서 볼 만한 곳">주의 종목</CardTitle>
              {m.avoid.length ? m.avoid.map((p) => <AvoidRow key={p.sym} p={p} market={market} />) : <Empty>없어요</Empty>}
            </Card>
          </div>
          <p className="px-1 text-[12px] leading-relaxed break-keep text-subtle">
            점수는 같은 시장 안에서의 상대 순위(0~100)이고, '이길 확률'은 시장 중앙값보다 나을 확률의 추정치예요. 과거 데이터로 검증한 통계 모델일 뿐 미래 수익을 보장하지 않으며 투자 권유가 아닙니다.
          </p>
        </div>
      )}
    </div>
  );
}
