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
import { beatProb, dayUnit, GradeBadge, outlookName, topText, useHourly, withHourly } from '@/components/picks/score';
import { EquityChart } from '@/components/picks/EquityChart';
import { useQuote, useWant } from '@/hooks/market';
import { isCoinEx, saveCoinEx, settleCoinArg, storedCoinEx, tickerOf, type CoinEx } from '@/lib/coins';
import { fmtPrice, timeAgo } from '@/lib/format';
import { MARKET_KEYS, MARKETS, predictSummary, remember, split, Store, type Market, type PredictHourly, type PredictMarket, type PredictPick } from '@/lib/market';
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

/** 예측력이 뚜렷하지 않으면(검증 판정이 strong 이 아니면) 숨기지 말고 먼저 알린다 — 글은 수집기가 쓴 판정(notes 첫 줄)의 쉬운 말 부분 */
function honesty(m: PredictMarket): { title: string; body: string } | null {
  const b = m.backtest;
  // 판정이 없는 옛 파일: 순위 상관·초과수익으로 대신 본다
  const v = b.verdict ?? (b.rankIC == null || b.rankIC < 0.015 || (b.topExcess ?? 0) <= 0 ? 'weak' : 'strong');
  if (v === 'strong') return null;
  const first = (m.notes[0] ?? '').replace(/^판정:\s*/, '');
  // 숫자 묶음('검증 2025-04-06~…: 순위 IC …')은 아래 '이 모델의 과거 성적'에 있으므로 앞의 쉬운 말만
  const plain = first.split(/\s검증 \d{4}-\d{2}-\d{2}/)[0].trim().replace(/^약한 편이에요\((.+?)\)\.\s*/, '$1. ');
  return v === 'none'
    ? { title: '과거 검증에서 효과가 없었어요', body: plain || '점수 상위 종목이 평균보다 낫다는 근거가 거의 없어요. 순위·추천은 믿기 어려워요.' }
    : { title: '과거 검증 성적이 약해요', body: plain || '통계적으로 뚜렷하지 않았어요. 순위는 참고 정도로만 보세요.' };
}

type Outlook = NonNullable<PredictPick['outlook']>[number];
const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

/** 1시간·1일·1주 — 지금과 비슷했던 과거 자리의 실제 결과(중간값 · 오른 비율). 과거로 되돌려 검증한 등급이 good 이 아니면 '참고 낮음' */
function OutlookStrip({ items, coin }: { items: Outlook[]; coin: boolean }) {
  const allLow = items.every((o) => o.grade !== 'good');
  return (
    <div className="rounded-xl bg-tile px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-[12px] leading-4 text-muted-foreground">
        <span className="min-w-0 break-keep">비슷했던 과거 자리에서 샀다면 <span className="whitespace-nowrap">(중간값)</span></span>
        {allLow && <LowTag />}
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2">
        {items.map((o) => (
          <div key={o.label} className="min-w-0">
            <div className="truncate text-[12px] leading-4 text-muted-foreground">{outlookName(o, coin)} 뒤</div>
            <div className={cn('text-[15px] leading-[22px] font-bold tabular', o.q50 == null ? 'text-muted-foreground' : DIR(o.q50))}>{o.q50 == null ? '–' : ratioText(o.q50)}</div>
            <div className="text-[12px] leading-4 text-faint tabular">오른 비율 {pct(o.win)}</div>
            {!allLow && o.grade !== 'good' && <LowTag className="mt-1" />}
          </div>
        ))}
      </div>
    </div>
  );
}
const LowTag = ({ className }: { className?: string }) => (
  <span title="과거로 되돌려 같은 방식으로 맞혀 보니 '같은 종목을 아무 날이나 샀을 때'보다 낫다는 근거가 약했어요"
    className={cn('inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-secondary px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-muted-foreground', className)}>
    참고 낮음
  </span>
);

const PickCard = memo(function PickCard({ p, market, horizon, hourly }: { p: PredictPick; market: Market; horizon: number; hourly?: PredictHourly }) {
  const q = useQuote(p.sym);
  const unit = dayUnit(market);
  const prob = beatProb(p);
  const top = topText(p.pctRank);
  const ex = p.expEx;
  const outlook = useMemo(() => (p.outlook?.length ? withHourly(p.outlook, hourly, split(p.sym)[1]) : null), [p.outlook, p.sym, hourly]);
  return (
    <a href={href('chart', p.sym, '1d')} className={cn(CARD_CLS, 'press flex flex-col px-4 pt-5 pb-4 transition-colors hover:bg-hover sm:p-[22px] sm:pb-[18px]')}>
      {/* 머리: 순위 · 로고 · 이름/티커 — 오른쪽 지금 가격 */}
      <div className="grid grid-cols-[auto_40px_minmax(0,1fr)_auto] items-center gap-x-2.5">
        <span className="min-w-3.5 text-center text-[15px] font-bold text-text-3 tabular">{p.rank}</span>
        <SymbolLogo sym={p.sym} size={40} />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-[16px] leading-[22px] font-bold">{p.name}</b>
          <span className="truncate text-[13px] text-muted-foreground">{tickerOf(market, p.sub)}</span>
        </div>
        <span className="flex flex-col items-end">
          <b className="text-[16px] leading-[22px] font-bold tabular">{fmtPrice(q?.price ?? p.spark[p.spark.length - 1], market)}</b>
          <ChangeText value={q?.chg} className="text-[13px] font-semibold" />
        </span>
      </div>
      {/* 시장 이길 확률(가격이 오를 확률 아님) · 검증 등급 · 시장 안 순위 — 판단 보류면 그렇게 */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-muted-foreground" title={`${horizon}${unit} 동안 같은 시장 종목들의 중앙값보다 더 오를 확률 — 가격이 오를 확률이 아니에요`}>시장 이길 확률</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {prob != null
              ? <b className="text-[24px] leading-[30px] font-bold tracking-[-0.02em] tabular">{Math.round(prob * 100)}%</b>
              : <b className="text-[18px] leading-[30px] font-bold text-muted-foreground" title="과거 검증 근거가 부족해 이번엔 확률을 내지 않았어요">판단 보류</b>}
            <GradeBadge grade={p.grade} />
          </div>
          {top ? <div className="text-[12.5px] text-muted-foreground tabular">{top}</div> : null}
        </div>
        <Sparkline data={p.spark} width={104} height={40} area={false} className="shrink-0" />
      </div>
      {ex ? (
        <AiRange className="mt-3.5" q10={ex.q10} q50={ex.q50} q90={ex.q90} label={`${horizon}${unit} 동안 시장 대비 예상 (10번 중 8번)`} />
      ) : p.q10 != null && p.q50 != null && p.q90 != null ? (
        <AiRange className="mt-3.5" q10={p.q10} q50={p.q50} q90={p.q90} label={`${horizon}${unit} 뒤 예상 범위`} />
      ) : null}
      {p.reasons.length > 0 && <DotList className="mt-2.5" itemClass="py-[3px] text-[13.5px] leading-5 before:top-[11px]" items={p.reasons.slice(0, 3).map((r) => r.text)} />}
      {/* 1시간·1일·1주 (비슷했던 과거 자리 최대 100곳) — 없으면 예전처럼 비슷했던 차트 10개 요약 */}
      {outlook ? (
        <div className="mt-auto pt-3"><OutlookStrip items={outlook} coin={MARKETS[market].coin} /></div>
      ) : p.analog && (
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
        <div className="text-[13px] whitespace-nowrap text-muted-foreground tabular">{(() => { const b = beatProb(p); return b == null ? '판단 보류' : `이길 확률 ${Math.round(b * 100)}%`; })()}</div>
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
  const unit = dayUnit(market);
  const hourly = useHourly(m ? market : null).data;
  const grid = 'grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4';
  const warn = m ? honesty(m) : null;

  return (
    <div>
      <PageTitle sub={<span>매일 전 종목 차트를 학습해, 앞으로 {m?.horizon ?? 1}{unit} 동안 시장을 이길 확률이 높은 순서예요</span>}>
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
          {warn && (
            <div role="note" className={cn(CARD_CLS, 'flex gap-3 px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              <p className="break-keep text-secondary-foreground"><b className="font-semibold text-foreground">{warn.title}.</b> {warn.body}</p>
            </div>
          )}
          {/* grid-cols-1: 칸을 화면 폭에 묶는다 (안 그러면 한 줄로 자르는 긴 이유 글이 칸을 밀어 휴대폰에서 가로로 넘친다) */}
          <div className={grid}>
            {m.picks.map((p) => <PickCard key={p.sym} p={p} market={market} horizon={m.horizon} hourly={hourly} />)}
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
          <p className="mx-4 text-[12.5px] leading-[1.6] break-keep text-muted-foreground sm:mx-1">
            ‘시장 이길 확률’은 과거 검증 구간에서 같은 점수 구간 종목들이 {m.horizon}{unit} 동안 같은 시장 중앙값을 실제로 이긴 비율이에요(검증 등급이 약하면 50% 쪽으로 줄였어요). 가격이 오를 확률이 아니고, 대부분 35~60% 사이예요.
            범위는 그 종목들이 낸 시장 대비 초과수익의 10~90% 구간, ‘시장 상위 x%’는 같은 시장 안 순위예요. 근거가 부족하면 ‘판단 보류’로 두었어요.
            1시간·1일·1주는 지금과 비슷했던 과거 자리에서 실제로 난 결과의 중간값과 오른 비율이고, 과거로 되돌려 맞혀 본 성적이 약하면 ‘참고 낮음’을 붙였어요.
            과거 데이터로 만든 통계일 뿐 미래 수익을 보장하지 않으며 투자 권유가 아니에요.
          </p>
        </div>
      )}
    </div>
  );
}
