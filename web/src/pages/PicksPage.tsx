// 전체 순위 — '다른 종목보다 나을까?' 매일 전 종목을 같은 기준(엔진 점수)으로 줄 세우고, 점수 상위 10% 안에서
// 'H 뒤 예상 %'(코인 24시간)가 높은 순으로 보여 준다. 숫자 원칙: 종목마다 다른 예상·범위(그 종목 변동성), 빼는 건 하드 제외만,
// 과열·급변동·거래 적음은 '주의'로. 예측 성적은 실제 기록(채점)과 되짚어 본 성적(백테스트)을 나눈다.
// 데이터: data/rank.json(매 실행 — 최신 가격·주의·채점) + data/predict/summary.json(하루 1번 — 검증·자세히) + 실시간 가격(보이는 카드만)
import { memo, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ShieldAlert, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageProps } from '@/App';
import { AiMark, Card, CARD_CLS, CardTitle, Empty, PageTitle } from '@/components/common/Card';
import { Segmented } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { Sparkline } from '@/components/common/Sparkline';
import { Skeleton } from '@/components/ui/skeleton';
import { ReasonText } from '@/components/chart/ForecastPanel';
import { minusFix } from '@/components/picks/fmt';
import { CoinExSwitch } from '@/components/market/CoinVenues';
import { dayUnit, GradeBadge } from '@/components/picks/score';
import { EquityChart } from '@/components/picks/EquityChart';
import { CautionChips, expDigits, fcWarn, fpct, fpp, MiniRange, MKT_ALL, p0, ScoreLines, toneOf, useMove, whenText } from '@/components/picks/rank';
import { useWant } from '@/hooks/market';
import { isCoinEx, settleCoinArg, tickerOf, type CoinEx } from '@/lib/coins';
import { fmtPrice, timeAgo } from '@/lib/format';
import {
  MARKET_KEYS, MARKETS, predictSummary, rankData, remember, Store,
  type Market, type PredictMarket, type PredictPick, type RankItem, type RankMarket,
} from '@/lib/market';
import { href, navigate } from '@/lib/router';

type Group = 'coin' | 'krx' | 'us';
const GROUPS: { value: Group; label: string }[] = [{ value: 'coin', label: '코인' }, { value: 'krx', label: '국내주식' }, { value: 'us', label: '미국주식' }];
const FIRST_N = 9; // 처음엔 9개(넓은 화면 3줄)만, 나머지는 '더 보기'
const isMarketKey = (x: unknown): x is Market => typeof x === 'string' && (MARKET_KEYS as string[]).includes(x);
/** 주소의 시장 → 없으면 마지막으로 본 시장. 코인은 업비트 원화가 기본(바이낸스는 보조 탭) */
function pickMarket(arg: string | undefined): Market {
  if (arg === 'coin') return 'upbit';
  if (isMarketKey(arg)) return arg;
  const s = Store.get<unknown>('ml.picksM', 'upbit');
  return isMarketKey(s) ? s : 'upbit';
}
/** '24시간 뒤 예상' · '다음 거래일 예상' · '20거래일 뒤 예상' */
const expLabel = (hLabel: string | undefined) => (!hLabel ? '예상' : hLabel === '다음 거래일' ? '다음 거래일 예상' : `${hLabel} 뒤 예상`);

/** 예측력이 뚜렷하지 않으면(엔진 판정이 strong 이 아니면) 숨기지 말고 먼저 알린다 — 글은 수집기가 쓴 판정(notes 첫 줄)의 쉬운 말 부분 */
function honesty(m: PredictMarket): { title: string; body: string } | null {
  const b = m.backtest;
  const v = b.verdict ?? (b.rankIC == null || b.rankIC < 0.015 || (b.topExcess ?? 0) <= 0 ? 'weak' : 'strong');
  if (v === 'strong') return null;
  const first = (m.notes[0] ?? '').replace(/^판정:\s*/, '');
  const plain = first.split(/\s검증 \d{4}-\d{2}-\d{2}/)[0].trim().replace(/^약한 편이에요\((.+?)\)\.\s*/, '$1. ');
  return v === 'none'
    ? { title: '과거 검증에서 순위 효과가 없었어요', body: plain || '점수 위쪽 종목이 평균보다 낫다는 근거가 거의 없어요. 순위는 믿기 어려워요.' }
    : { title: '과거 검증 성적이 약해요', body: plain || '통계적으로 뚜렷하지 않았어요. 순위는 참고 정도로만 보세요.' };
}

function Note({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'info' }) {
  return (
    <div role="note" className={cn(CARD_CLS, 'flex gap-3 px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
      <ShieldAlert className={cn('mt-0.5 size-5 shrink-0', tone === 'warn' ? 'text-warn' : 'text-muted-foreground')} aria-hidden />
      <div className="min-w-0 break-keep text-secondary-foreground">{children}</div>
    </div>
  );
}

const RankCard = memo(function RankCard({ it, market, hLabel, poor }: { it: RankItem; market: Market; hLabel: string; poor?: boolean }) {
  const { price, move, chg } = useMove(it.sym, it.base, it.price);
  const top = it.pct != null ? Math.max(1, Math.round(100 - it.pct)) : null;
  const lines = [...(it.ai ? [it.ai] : []), ...it.why].slice(0, 2);
  const d = expDigits(it.mid);
  return (
    <a href={href('chart', it.sym, '1d')} className={cn(CARD_CLS, 'press flex min-w-0 flex-col px-4 pt-5 pb-4 transition-colors hover:bg-hover sm:p-5 sm:pb-4')}>
      <div className="grid grid-cols-[auto_40px_minmax(0,1fr)_auto] items-center gap-x-2.5">
        <span className="min-w-3.5 text-center text-[15px] font-bold text-text-3 tabular">{it.rank}</span>
        <SymbolLogo sym={it.sym} size={40} />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-[16px] leading-[22px] font-bold">{it.name}</b>
          <span className="truncate text-[13px] text-muted-foreground">{tickerOf(market, it.sub)}{top != null ? <span className="tabular"> · 점수 상위 {top}%</span> : null}</span>
        </div>
        <span className="flex flex-col items-end">
          <b className="text-[16px] leading-[22px] font-bold tabular">{fmtPrice(price, market)}</b>
          {move != null ? (
            <span className="text-[12.5px] text-muted-foreground tabular whitespace-nowrap" title="예측 기준가(엔진 기준일 종가)에서 지금까지">기준가 뒤 <b className={cn('font-semibold', toneOf(move))}>{fpct(move)}</b></span>
          ) : chg != null ? <span className="text-[12.5px] text-muted-foreground tabular">{fpct(chg / 100)}</span> : null}
        </span>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-muted-foreground">{expLabel(hLabel)}</div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <b className={cn('text-[26px] leading-8 font-bold tracking-[-0.02em] tabular', poor ? 'text-muted-foreground' : toneOf(it.mid, d))}
              title={poor ? '과거 검증에서 0% 라고 하는 것보다 잘 맞지 않았어요' : undefined}>{fpct(it.mid, d)}</b>
            {poor ? <span className="text-[12px] font-semibold text-muted-foreground">참고 낮음</span> : null}
            {it.edge != null ? <span className="text-[12.5px] text-muted-foreground tabular" title="같은 시장 전체(가운데 종목) 예상과의 차이">다른 종목보다 <span className={toneOf(it.edge, 2)}>{fpp(it.edge)}</span></span> : null}
          </div>
        </div>
        {it.spark?.length ? <Sparkline data={it.spark} width={88} height={36} area={false} className="shrink-0" /> : null}
      </div>
      {it.lo != null && it.hi != null ? (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-muted-foreground">10번 중 8번은</span>
            <span className="font-semibold tabular"><span className={toneOf(it.lo)}>{fpct(it.lo)}</span> ~ <span className={toneOf(it.hi)}>{fpct(it.hi)}</span></span>
          </div>
          <MiniRange className="mt-2" lo={it.lo} hi={it.hi} mid={it.mid} now={move} />
          {move != null ? (
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {move > it.hi ? '지금 범위 위로 벗어났어요' : move < it.lo ? '지금 범위 아래로 벗어났어요' : '지금 범위 안이에요'}
              <span className="tabular"> (기준가 뒤 {fpct(move)})</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {lines.length ? (
        <ul className="mt-2.5 space-y-0.5">
          {lines.map((t, i) => (
            <li key={i} className="relative pl-3.5 text-[13.5px] leading-5 break-keep text-secondary-foreground before:absolute before:top-[8px] before:left-0.5 before:size-1 before:rounded-full before:bg-muted-foreground/70">
              {i === 0 && it.ai ? minusFix(t) : <ReasonText text={t} />}
            </li>
          ))}
        </ul>
      ) : null}
      {it.cau.length ? <CautionChips className="mt-2.5" cau={it.cau} max={4} /> : null}
    </a>
  );
});

/** 예상 구간별 실제 — 예상이 높았던 묶음이 실제로도 높았나 (워크포워드, 학습에 안 쓴 날짜) */
function CalibTable({ bins }: { bins: { pred: number; mean: number; median: number }[] }) {
  if (!bins?.length) return null;
  const vals = bins.flatMap((b) => [b.pred, b.mean]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-3 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-ai" />예상</span>
        <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-foreground" />실제 평균</span>
      </div>
      <ul className="space-y-1">
        {bins.map((b, i) => (
          <li key={i} className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-2 text-[12px] tabular">
            <span className="relative block h-3">
              <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
              <span className="absolute -inset-y-0.5 w-px bg-muted-foreground/50" style={{ left: x(0) }} />
              <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ai" style={{ left: x(b.pred) }} />
              <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: x(b.mean) }} />
            </span>
            <span className="text-right text-muted-foreground"><span className={toneOf(b.pred, 2)}>{fpct(b.pred, 2)}</span> → <span className={toneOf(b.mean, 2)}>{fpct(b.mean, 2)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScoreCard({ rm, market, sumM }: { rm: RankMarket; market: Market; sumM?: PredictMarket }) {
  const sc = rm.score;
  const chk = sc?.check;
  const a = chk?.all, h = chk?.hold;
  const list = sc?.past?.list ?? [];
  return (
    <Card>
      <CardTitle sub={chk ? `${chk.from} ~ ${chk.to} · 학습에 안 쓴 날짜로 되짚어 봄 + 실제 기록` : '실제 기록'}>예측 성적</CardTitle>
      <ScoreLines market={market} last={sc?.last} real={sc?.real} past={sc?.past} pending={sc?.pending} h={rm.h}
        dd={a?.top5 ? { mdd: a.top5.mdd, uniMdd: a.top5.uniMdd } : null} className="rounded-[14px] bg-tile px-3.5 py-1" />
      {list.length > 1 ? (
        <div className="mt-3">
          <p className="text-[12.5px] text-muted-foreground">되짚어 본 최근 {list.length}회 — 고른 5개 평균(빨강·파랑 막대) vs {MKT_ALL[market]}(회색 점)</p>
          <PastBars list={list} />
        </div>
      ) : null}
      {a ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="범위 안 (목표 80%)">{p0(a.coverage)}</Tile>
          <Tile label="방향 맞힘" sub={a.upShare != null ? `실제 오른 비율 ${p0(a.upShare)}` : undefined}>{p0(a.dirHit)}</Tile>
          <Tile label="기울기 (1이면 딱 맞음)">{a.slope == null ? '–' : a.slope.toFixed(2)}</Tile>
          <Tile label="0% 예상보다 오차" sub="음수면 더 잘 맞힘"><span className={a.mseVsZero != null && a.mseVsZero < 0 ? 'text-foreground' : 'text-muted-foreground'}>{a.mseVsZero == null ? '–' : `${(a.mseVsZero * 100).toFixed(2)}%`}</span></Tile>
        </div>
      ) : null}
      {a?.bins?.length ? (
        <details className="group mt-3">
          <summary className="press flex h-10 cursor-pointer list-none items-center justify-between rounded-xl text-[13.5px] font-semibold text-text-3 [&::-webkit-details-marker]:hidden">
            예상이 높을수록 실제도 높았나<ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <p className="text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
            과거 예상(학습에 안 쓴 날짜)을 낮은 것부터 10묶음으로 나눠 실제 평균과 견줬어요. 점이 가까울수록 숫자를 믿을 만해요
            {h ? <> · 최근 30%({chk?.holdFrom}~)만 보면 범위 안 {p0(h.coverage)}, 기울기 {h.slope?.toFixed(2) ?? '–'}</> : null}.
          </p>
          <CalibTable bins={a.bins} />
        </details>
      ) : null}
      {sumM?.expCheck ? (
        <p className="mt-2 text-[12px] leading-[1.5] break-keep text-muted-foreground">
          예상 % = 시장 전체 몫(그동안 시장이 보통 움직인 만큼{sumM.expCheck.method?.startsWith('zero') ? ' — 이 시장은 0%로 둠' : ''}) + 종목 몫(점수·변동성·최근 움직임). ‘10번 중 8번’은 그 종목 변동성에 비례해요.
        </p>
      ) : null}
    </Card>
  );
}

function PastBars({ list }: { list: { d: string; pred: number; act: number; mkt: number }[] }) {
  const vals = list.flatMap((x) => [x.act, x.mkt]);
  const m = Math.max(0.005, ...vals.map((v) => Math.abs(v)));
  const W = 300, H = 64, n = list.length, bw = W / n;
  const y = (v: number) => H / 2 - (v / m) * (H / 2 - 3);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1.5 h-16 w-full" role="img"
      aria-label={`최근 ${n}회 중 고른 5개가 시장보다 나은 회차 ${list.filter((x) => x.act > x.mkt).length}회`}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--border)" />
      {list.map((x, i) => {
        const top = Math.min(y(x.act), H / 2), hgt = Math.abs(y(x.act) - H / 2);
        return (
          <g key={x.d}>
            <rect x={i * bw + bw * 0.2} width={bw * 0.6} y={top} height={Math.max(1, hgt)} fill={x.act >= 0 ? 'var(--up)' : 'var(--down)'} opacity={0.75} />
            <circle cx={i * bw + bw / 2} cy={y(x.mkt)} r={1.8} fill="var(--muted-foreground)" />
          </g>
        );
      })}
    </svg>
  );
}

const Tile = ({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) => (
  <div className="rounded-[14px] bg-tile px-2 py-2.5 text-center">
    <div className="text-[12px] leading-4 break-keep text-muted-foreground">{label}</div>
    <div className="mt-0.5 text-[17px] font-bold tabular">{children}</div>
    {sub ? <div className="text-[11.5px] leading-4 text-muted-foreground">{sub}</div> : null}
  </div>
);

const BtTile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="rounded-[14px] bg-tile px-1 py-2.5 text-center">
    <div className="text-[12.5px] whitespace-nowrap text-muted-foreground">{label}</div>
    <div className="text-[17px] font-bold tabular">{children}</div>
  </div>
);

/** 자세히 — 시장 이길 확률(가격이 오를 확률 아님) · 엔진 검증 · 점수가 가장 낮은 종목 */
function Details({ rm, m, market }: { rm: RankMarket; m: PredictMarket; market: Market }) {
  const unit = dayUnit(market);
  return (
    <details className={cn(CARD_CLS, 'group px-4 py-1 sm:px-5')}>
      <summary className="press flex h-12 cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
        자세히 — 시장 이길 확률 · 엔진 검증<ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 pb-5">
        <section>
          <h3 className="text-[15px] font-bold">시장 이길 확률</h3>
          <p className="mt-1 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
            과거 검증 구간에서 같은 점수 구간 종목들이 {m.horizon}{unit} 동안 같은 시장 중앙값을 실제로 이긴 비율이에요(검증 등급이 약하면 50% 쪽으로 줄였어요).
            가격이 오를 확률이 아니에요.
          </p>
          <table className="mt-2 w-full text-[13px]">
            <thead><tr className="text-[12px] text-muted-foreground"><th className="pb-1 text-left font-normal">종목</th><th className="pb-1 text-right font-normal">시장 이길 확률</th><th className="pb-1 text-right font-normal">점수 백분위</th></tr></thead>
            <tbody>
              {rm.items.slice(0, 15).map((it) => (
                <tr key={it.sym} className="border-t border-border"><td className="py-1.5">{it.rank}. {it.name}</td><td className="py-1.5 text-right font-semibold tabular">{p0(it.pb)}</td><td className="py-1.5 text-right text-muted-foreground tabular">{it.pct ?? '–'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-bold">순위 엔진의 과거 성적 <GradeBadge grade={m.grade ?? m.backtest.verdict} /></h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{m.backtest.from} ~ {m.backtest.to} · 겹치지 않게 {m.backtest.periods}번 · 점수 상위 10% 전체를 샀다면</p>
          <div className="mt-2"><EquityChart data={m.backtest.equity} /></div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <BtTile label="상위 10% 승률">{m.backtest.topHitRate == null ? '–' : Math.round(m.backtest.topHitRate * 100) + '%'}</BtTile>
            <BtTile label="평균 초과수익"><span className={toneOf(m.backtest.topExcess ?? 0, 2)}>{fpp(m.backtest.topExcess)}</span></BtTile>
            <BtTile label="순위 상관(IC)">{m.backtest.rankIC == null ? '–' : m.backtest.rankIC.toFixed(3)}</BtTile>
          </div>
          {m.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-[1.55] break-keep text-muted-foreground">{m.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          <p className="mt-3 text-[12.5px] text-muted-foreground">모델 {m.model.kind} · 학습 {m.model.trainRows.toLocaleString('ko-KR')}행 · 지표 {m.model.features}개 · {timeAgo(Date.parse(m.model.trainedAt))} 학습 · {m.asOf} 기준 {m.universe}개 종목</p>
        </section>
        {m.avoid.length ? (
          <section>
            <h3 className="text-[15px] font-bold">점수가 가장 낮은 종목</h3>
            <p className="mt-1 text-[12.5px] text-muted-foreground">다른 종목보다 못할 쪽으로 점수가 낮게 나온 곳이에요</p>
            <ul className="mt-1">{m.avoid.slice(0, 8).map((p) => <AvoidRow key={p.sym} p={p} market={market} />)}</ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}

const AvoidRow = memo(function AvoidRow({ p, market }: { p: PredictPick; market: Market }) {
  const er = p.expRet;
  return (
    <li>
      <a href={href('chart', p.sym, '1d')} className="press -mx-2 flex items-center gap-3 rounded-[14px] px-2 py-2 transition-colors hover:bg-hover">
        <SymbolLogo sym={p.sym} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold">{p.name}</div>
          <div className="truncate text-[12.5px] text-muted-foreground">{p.why?.[0]?.text ? <ReasonText text={p.why[0].text} /> : tickerOf(market, p.sub)}</div>
        </div>
        <div className="text-right text-[12.5px] tabular">
          {er ? <b className={cn('block text-[14px] font-semibold', toneOf(er.mid, expDigits(er.mid)))}>{fpct(er.mid, expDigits(er.mid))}</b> : null}
          <span className="text-muted-foreground">점수 하위 {Math.max(1, Math.round(p.pctRank ?? 0))}%</span>
        </div>
      </a>
    </li>
  );
});

export default function PicksPage({ args }: PageProps) {
  const market = pickMarket(args[0]);
  const group: Group = isCoinEx(market) ? 'coin' : market === 'krx' ? 'krx' : 'us';
  useEffect(() => { Store.set('ml.picksM', market); }, [market]);
  useEffect(() => { if (isCoinEx(market)) settleCoinArg('picks', args, market); }, [args, market]);
  const goGroup = (g: Group) => { if (g !== group) navigate('picks', g === 'coin' ? 'upbit' : g); };
  const goEx = (ex: CoinEx) => { if (ex !== market) navigate('picks', ex); };
  const rq = useQuery({ queryKey: ['rank'], queryFn: rankData, staleTime: 3 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });
  const sq = useQuery({ queryKey: ['predict-summary'], queryFn: predictSummary, staleTime: 10 * 60e3, retry: false });
  const rm = rq.data?.markets?.[market];
  const m = sq.data?.markets?.[market];
  const items = useMemo(() => rm?.items ?? [], [rm]);
  const [all, setAll] = useState(false);
  useEffect(() => { setAll(false); }, [market]);
  const shown = useMemo(() => (all ? items : items.slice(0, FIRST_N)), [all, items]);
  // 실시간 가격은 보이는 카드만 구독한다
  const syms = useMemo(() => shown.map((p) => p.sym), [shown]);
  useEffect(() => { items.forEach((p) => remember(p.sym, { name: p.name, sub: p.sub })); }, [items]);
  useWant(syms.length ? syms : null);
  useEffect(() => { document.title = `전체 순위 · ${MARKETS[market].name} — 마켓`; return () => { document.title = '마켓'; }; }, [market]);
  const warn = m ? honesty(m) : null;
  const fw = fcWarn(rm?.fcGrade, rm?.hLabel);
  const grid = 'grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4';
  const loading = rq.isLoading;

  return (
    <div>
      <PageTitle sub={<span className="break-keep">다른 종목보다 나을까? 매일 전 종목을 같은 기준으로 줄 세우고, 점수 상위 10% 안에서 예상이 높은 순으로 보여 줘요</span>}>
        전체 순위<AiMark big />
      </PageTitle>
      <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 sm:mx-0 sm:mb-4">
        <Segmented items={GROUPS} value={group} onChange={goGroup} className="max-sm:flex max-sm:w-full max-sm:[&>button]:flex-1" />
        {isCoinEx(market) && <CoinExSwitch value={market} onChange={goEx} className="w-full sm:w-auto" />}
      </div>

      {loading && <div className={grid}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-72 rounded-[20px] bg-card max-sm:rounded-none" />)}</div>}
      {!loading && (rq.isError || !rm) && (
        <Card><Empty icon={<Sparkles />} title="순위를 준비하고 있어요">수집할 때마다 새로 계산해요. 잠시 뒤 다시 확인해 주세요.</Empty></Card>
      )}
      {rm && (
        <div className="space-y-2 sm:space-y-3 lg:space-y-4">
          {warn && <Note><b className="font-semibold text-foreground">{warn.title}.</b> {warn.body}</Note>}
          {rm.stale && <Note>예측 기준일({rm.asOf})이 오래됐어요 — 엔진이 며칠 돌지 못했어요. 숫자를 그대로 믿지 마세요.</Note>}
          {fw && <Note>{fw}</Note>}

          <div className={cn(CARD_CLS, 'px-4 py-3.5 text-[13.5px] leading-[1.55] sm:px-5')}>
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <b className="font-semibold">{MARKETS[market].name} · {expLabel(rm.hLabel)}</b>
              {rm.baseAt ? <span className="text-muted-foreground tabular">{whenText(rm.baseAt)} 가격 기준</span> : null}
              <span className="text-muted-foreground tabular">· 점수 상위 10% {items.length}개</span>
            </p>
            <p className="mt-1 break-keep text-muted-foreground">
              {rm.mkt.mid != null ? <>{MKT_ALL[market]}(가운데 종목) 예상은 <b className={cn('font-semibold tabular', toneOf(rm.mkt.mid, 2))}>{fpct(rm.mkt.mid, 2)}</b>예요. </> : null}
              시장 전체 방향은 거의 못 맞혀 예상 % 는 0% 근처가 정상이에요 — 순위의 힘은 ‘다른 종목보다 나을 몫’에 있어요.
              금·비트코인에 묶인 토큰·투자유의·상폐/해킹 소식만 빼고, 과열·급변동·거래가 적은 종목은 ‘주의’로 표시해요.
            </p>
            {rm.common ? <p className="mt-2 rounded-xl bg-tile px-3 py-2 break-keep text-secondary-foreground">{rm.common} 카드에는 종목마다 다른 점을 적었어요.</p> : null}
            {rm.notes.map((n, i) => <p key={i} className="mt-1 break-keep text-warn">{n}</p>)}
          </div>

          {items.length ? (
            <>
              <div className={grid}>{shown.map((it) => <RankCard key={it.sym} it={it} market={market} hLabel={rm.hLabel} poor={rm.fcGrade === 'poor'} />)}</div>
              {items.length > shown.length ? (
                <button type="button" onClick={() => setAll(true)}
                  className={cn(CARD_CLS, 'press flex h-12 w-full items-center justify-center gap-1 text-[14.5px] font-semibold text-text-3 hover:bg-hover')}>
                  나머지 {items.length - shown.length}개 더 보기<ChevronDown aria-hidden className="size-4" />
                </button>
              ) : null}
            </>
          ) : (
            <Card><Empty icon={<Sparkles />} title="이번엔 보여 줄 종목이 없어요">{rm.notes[0] ?? '점수 상위 10% 안에서 빼야 하는 종목을 빼니 남은 게 없어요. 억지로 채우지 않았어요.'}</Empty></Card>
          )}

          <div className="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-4">
            <ScoreCard rm={rm} market={market} sumM={m} />
            {rm.excluded.length ? (
              <Card className="self-start">
                <CardTitle sub="점수는 높았지만 순위에서 뺀 종목">뺀 종목</CardTitle>
                <ul className="space-y-1.5 text-[13.5px]">
                  {rm.excluded.map((e) => (
                    <li key={e.sym} className="flex items-baseline justify-between gap-3">
                      <a href={href('chart', e.sym, '1d')} className="min-w-0 truncate font-semibold hover:underline">{e.name}</a>
                      <span className="shrink-0 text-[12.5px] text-muted-foreground">{e.why}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>

          {m ? <Details rm={rm} m={m} market={market} /> : null}
          <p className="mx-4 text-[12.5px] leading-[1.6] break-keep text-muted-foreground sm:mx-1">
            ‘{expLabel(rm.hLabel)}’은 학습에 안 쓴 과거 날짜로 되돌려 맞혀 본 방법으로 만든 값이고, ‘10번 중 8번’은 그 종목 변동성에 맞춘 범위예요.
            순위는 하루 1번(엔진) 바뀌고, 가격·범위 안 위치·주의 표시는 실시간 가격과 수집할 때마다(보통 40~70분) 바뀌어요.
            {rm.aiBy ? ` 위쪽 5개의 첫 줄 이유는 ${rm.aiBy === 'claude' ? '클로드' : 'AI'}가 숫자를 보고 쓴 문장이에요.` : ''}
            {' '}과거 데이터로 만든 통계일 뿐 미래 수익을 보장하지 않으며 투자 권유가 아니에요.
          </p>
        </div>
      )}
    </div>
  );
}
