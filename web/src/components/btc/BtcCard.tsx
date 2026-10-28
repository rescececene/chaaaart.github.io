// 비트코인 카드 — 첫 화면 맨 위. 업비트 원화 비트코인의 '24시간 뒤 예상 %' · 10번 중 8번 범위 · 갈림길 · 1시간 뒤 · 예측 성적
// 데이터 (중계 Worker 요청 없음):
//   data/btc.json      24시간·갈림길·결론·성적 (collector/btc_forecast.py, 수집할 때마다 · 수 KB)
//   data/btc_h1.json   1시간 계수 (하루 1번 학습 · 약 40KB) + 업비트 60분봉 200개 직접(정시마다 1번) → 브라우저가 바로 계산(useH1)
//   업비트 웹소켓 실시간 가격(useQuote) — '지금' 위치
// 정직: 방향 예측력이 약하면 먼저 알리고, '지난 1년 되짚어 본 성적'(백테스트)과 '실제 기록'(채점)을 나눠 보인다.
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { Card } from '@/components/common/Card';
import { ChangeText, Flash } from '@/components/common/Change';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuote, useWant } from '@/hooks/market';
import { fmtPriceUnit } from '@/lib/format';
import { BTC_SYM, btcForecast, UPBIT_BTC_URL, type BtcBacktest, type BtcData, type BtcHorizon, type BtcScored } from '@/lib/market/btc';
import { cn } from '@/lib/utils';
import { frac, hourLabel, krw, pct, prob, relDay, toneCls, ymd } from './fmt';
import { FanLegend, ForecastFan } from './ForecastFan';
import { useBtcH1 } from './useH1';

/** 기준 시각이 이만큼 지나면 '오래된 예측' (수집이 40~70분마다라 2시간은 정상 범위) */
const STALE_MS = 3 * 3600e3;
const SYMS = [BTC_SYM];

function useNow(ms = 30e3) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** 작은 회색 칸 안의 '이름 · 값' 줄 */
function Line({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1.5 text-[13.5px] leading-5', className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-keep">{children}</span>
    </div>
  );
}

/** 방향 예측력 한 줄 — 등급(edge)은 2021년부터의 긴 기간 기준이라 그 숫자를 먼저, 지난 1년을 옆에 */
function edgeNote(h: BtcHorizon, bt: BtcBacktest | null | undefined) {
  const key = h.h === 24 ? 'h24' : 'h1';
  const lg = bt?.long?.[key], y1 = bt?.[key];
  const nums = [lg ? `${ymd(bt!.long!.from).slice(0, 4)}년부터 ${prob(lg.hit)}` : '', y1 ? `지난 1년 ${prob(y1.hit)}` : ''].filter(Boolean).join(' · ');
  const tail = nums ? ` (방향 맞힘 ${nums})` : '';
  if (h.edge === 'none') return `방향은 과거에도 동전 던지기와 거의 같았어요${tail} — 범위를 더 믿어 주세요.`;
  if (h.edge === 'weak') return `방향은 아주 조금 맞혀요${tail}.`;
  return `방향을 조금 맞혀요${tail}.`;
}

function Verdict({ s }: { s: BtcScored }) {
  const chip = (ok: boolean | null, yes: string, no: string, none: string) => (
    <span className={cn('inline-flex h-[22px] items-center rounded-md px-1.5 text-[12px] font-semibold whitespace-nowrap',
      ok == null ? 'bg-secondary text-muted-foreground' : ok ? 'bg-secondary text-secondary-foreground' : 'bg-secondary text-muted-foreground')}>
      {ok == null ? none : ok ? yes : no}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {chip(s.inRange, '범위 안', '범위 밖', '–')}
      {chip(s.dirHit, '방향 맞음', '방향 틀림', '반반이라 방향 없음')}
    </span>
  );
}

function StatCell({ v, of }: { v: number | null | undefined; of: [number, number] | null | undefined }) {
  if (!of || !of[1]) return <span className="text-muted-foreground">–</span>;
  return <><b className="font-semibold tabular">{prob(v ?? of[0] / of[1])}</b> <span className="text-[12px] text-muted-foreground tabular">({frac(of)})</span></>;
}

/** '자세히' — 되짚어 본 성적(백테스트) vs 실제 기록(채점) */
function Record({ d }: { d: BtcData }) {
  const bt = d.backtest, lv = d.live;
  const liveDays = lv?.days ?? 0;
  return (
    <details className="group mt-3">
      <summary className="press flex h-11 cursor-pointer list-none items-center justify-center gap-1 rounded-xl text-[14px] font-semibold text-text-3 hover:bg-secondary [&::-webkit-details-marker]:hidden">
        예측 성적 자세히<ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-3 rounded-[14px] bg-tile p-3.5 text-[13px] leading-[1.6] text-secondary-foreground sm:p-4">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-muted-foreground">
              <th scope="col" className="pb-1 font-normal" />
              <th scope="col" className="pb-1 text-right font-normal">지난 1년 되짚어 봄</th>
              <th scope="col" className="pb-1 pl-3 text-right font-normal">실제 기록 {liveDays ? `${liveDays}일째` : '시작 전'}</th>
            </tr>
          </thead>
          <tbody>
            {([
              ['24시간 방향', bt?.h24.hit, bt?.h24.dir, lv?.dir],
              ['24시간 범위 안', bt?.h24.cov, bt?.h24.range, lv?.range],
              ['1시간 방향', bt?.h1.hit, bt?.h1.dir, lv?.h1?.dir],
              ['1시간 범위 안', bt?.h1.cov, bt?.h1.range, lv?.h1?.range],
            ] as const).map(([label, v, of, live]) => (
              <tr key={label} className="border-t border-border align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal text-muted-foreground">{label}</th>
                <td className="py-1.5 text-right"><StatCell v={v} of={of} /></td>
                <td className="py-1.5 pl-3 text-right"><StatCell v={null} of={live} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {bt ? (
          <p className="text-[12.5px] text-muted-foreground">
            되짚어 본 성적은 {ymd(bt.from)} ~ {ymd(bt.to)}의 매 시각에 그때까지의 데이터로만 다시 예측해 맞춰 본 거예요(24시간은 매일 오전 9시 예측 1개씩).
            늘 ‘50%’라고 한 것보다 확률이 나았는지: 24시간 <b className="font-semibold text-secondary-foreground">{(bt.h24.bss * 100).toFixed(2)}%</b>,
            1시간 <b className="font-semibold text-secondary-foreground">{(bt.h1.bss * 100).toFixed(2)}%</b> (0 이하면 나을 게 없다는 뜻).
            실제로 오른 날은 {prob(bt.h24.upRate)}였어요.
          </p>
        ) : null}
        {([['24시간', bt?.calib24, bt?.slope24], ['1시간', bt?.calib1, bt?.slope1]] as const).map(([name, rows, slope]) => rows?.length ? (
          <div key={name}>
            <p className="mb-1 text-[12.5px] font-semibold">예상 %가 맞았나 — {name}, 지난 1년 예상 구간별 실제</p>
            <ul className="space-y-0.5 text-[12.5px] tabular">
              {rows.map((r, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">예상 {pct(r.pred, 2)}</span>
                  <span>실제 중앙 <span className={toneCls(r.actMed, 2)}>{pct(r.actMed, 2)}</span> · 평균 <span className={toneCls(r.actMean, 2)}>{pct(r.actMean, 2)}</span> · 오름 {prob(r.up)}</span>
                </li>
              ))}
            </ul>
            {slope != null ? (
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                예상과 실제 중앙의 기울기 {slope.toFixed(2)} (1 에 가까울수록 예상 크기가 맞아요{Math.abs(slope - 1) > 0.5 ? ' — 예상 폭이 아주 작아 들쭉날쭉해요' : ''})
              </p>
            ) : null}
          </div>
        ) : null)}
        {bt?.long ? (
          <p className="text-[12.5px] text-muted-foreground">
            {ymd(bt.long.from)}부터 길게 보면 24시간 방향 {prob(bt.long.h24.hit)} · 범위 안 {prob(bt.long.h24.cov)}, 1시간 방향 {prob(bt.long.h1.hit)} · 범위 안 {prob(bt.long.h1.cov)}였어요.
          </p>
        ) : null}
        {bt ? <p className="text-[12px] text-muted-foreground">모델: 24시간 {bt.model24} · 1시간 {bt.model1}</p> : null}
        {lv?.recent?.length ? (
          <div>
            <p className="mb-1 text-[12.5px] font-semibold">최근 실제 기록 (매일 오전 9시 예측)</p>
            <ul className="space-y-0.5 text-[12.5px] tabular">
              {lv.recent.slice().reverse().map((r) => (
                <li key={r.t} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{relDay(r.t)}</span>
                  <span>예상 <span className={toneCls(r.m)}>{pct(r.m)}</span> → 실제 <span className={toneCls(r.a)}>{pct(r.a)}</span>{r.lo != null && r.hi != null && r.a != null ? (r.a >= r.lo && r.a <= r.hi ? ' · 범위 안' : ' · 범위 밖') : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function BtcCard({ className }: { className?: string }) {
  useWant(SYMS);
  const q = useQuote(BTC_SYM);
  const now = useNow();
  const { data: d, isLoading, isError } = useQuery({ queryKey: ['btc'], queryFn: btcForecast, staleTime: 2 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });

  if (isLoading) {
    return (
      <Card className={className}>
        <Skeleton className="h-6 w-40 bg-secondary" />
        <Skeleton className="mt-4 h-12 w-48 bg-secondary" />
        <Skeleton className="mt-4 h-16 w-full bg-secondary" />
        <Skeleton className="mt-4 h-24 w-full bg-secondary" />
      </Card>
    );
  }
  if (isError || !d || !d.h24) {
    return (
      <Card className={className}>
        <Head live={q?.price ?? null} chg={q?.chg ?? null} asOf={null} stale={false} />
        <p className="mt-3 text-[14px] leading-[1.55] break-keep text-muted-foreground">비트코인 예측을 준비하고 있어요. 수집할 때마다(보통 1시간 안팎) 새로 계산해요.</p>
        <UpbitLink />
      </Card>
    );
  }

  // '지금' 위치는 실시간(웹소켓)이거나 20분 안의 시세일 때만 — 오래된 지연 시세로 그리면 엉뚱한 자리에 찍힌다
  const live = q?.price != null && (q.live || now - q.ts < 20 * 60e3) ? q.price : null;
  const h24 = d.h24, h1 = d.h1, pv = d.pivot, bt = d.backtest;
  const asOfMs = Date.parse(d.asOf);
  const stale = Number.isFinite(asOfMs) && now - asOfMs > STALE_MS;
  const fromBase = live != null ? live / d.price - 1 : null;
  const side = pv && live != null ? (live >= pv.price ? 'above' : 'below') : pv?.side;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <Head live={q?.price ?? null} chg={q?.chg ?? null} asOf={d.asOf} stale={stale} delayed={!!q && !q.live} />

      <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* 왼쪽: 24시간 — 예상 % · 결론 · 10번 중 8번 · 그림 */}
        <section aria-label="24시간 뒤 예상" className="min-w-0">
          <p className="text-[13.5px] text-muted-foreground">24시간 뒤 예상 <span className="tabular">· {relDay(h24.target, now)} {hourLabel(h24.target)}</span></p>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <b className={cn('text-[34px] leading-10 font-bold tracking-[-0.03em] tabular', toneCls(h24.med))}>{pct(h24.med)}</b>
            <span className="text-[15px] font-semibold text-secondary-foreground tabular">약 {krw(h24.medPrice)}</span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
            <span className="inline-flex h-6 items-center rounded-md bg-secondary px-2 text-[13px] font-bold text-secondary-foreground">{h24.lean}</span>
            <span className="text-muted-foreground">오를 확률 <b className="font-semibold text-foreground tabular">{prob(h24.pUp)}</b></span>
          </p>
          {d.summary?.text ? (
            <div className="mt-3 border-l-2 border-foreground/15 pl-3">
              <p className="text-[14.5px] leading-[1.55] font-semibold break-keep">{d.summary.text}</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {d.summary.by === 'ai'
                  ? `${d.summary.provider === 'gemma' ? 'AI(Gemma)' : d.summary.provider === 'claude' ? '클로드' : 'AI'}가 ${hourLabel(d.summary.at)}에 숫자를 보고 쓴 결론이에요`
                  : '숫자로 정해진 규칙 결론이에요'}
              </p>
            </div>
          ) : null}

          <div className="mt-4">
            <p className="text-[13.5px] text-muted-foreground">10번 중 8번은</p>
            <p className="mt-0.5 text-[17px] font-bold tracking-[-0.01em] tabular">
              <span className={toneCls(h24.lo)}>{pct(h24.lo)}</span> ~ <span className={toneCls(h24.hi)}>{pct(h24.hi)}</span>
            </p>
            <p className="text-[13.5px] text-secondary-foreground tabular">{krw(h24.loPrice)} ~ {krw(h24.hiPrice)}</p>
          </div>
          <ForecastFan className="mt-4" spark={d.spark} base={d.price} lo={h24.loPrice} hi={h24.hiPrice} med={h24.medPrice}
            pivot={pv?.price} live={live} hoursSince={(now - asOfMs) / 3600e3} />
          <FanLegend pivot={!!pv} live={live != null} />
          {fromBase != null ? (
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">
              지금은 기준 가격({krw(d.price)})보다 <span className={cn('font-semibold tabular', toneCls(fromBase, 2))}>{pct(fromBase, 2)}</span>
            </p>
          ) : null}
          <p className="mt-2 text-[12.5px] leading-[1.5] break-keep text-muted-foreground">{edgeNote(h24, bt)}</p>
        </section>

        {/* 오른쪽: 갈림길 · 1시간 · 예측 성적 */}
        <div className="min-w-0 space-y-4">
          {pv ? (
            <section aria-label="갈림길" className="rounded-[14px] bg-tile px-3.5 py-3">
              <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-[13.5px]">
                <span className="font-bold">갈림길 <span className="tabular">{krw(pv.price)}</span></span>
                <span className="text-[12.5px] text-muted-foreground" title={pv.desc}>{pv.label}</span>
              </p>
              <p className="mt-1 text-[13.5px] leading-[1.5] break-keep text-secondary-foreground">
                이 아래로 가면 <b className="font-semibold text-down-text">약세 쪽</b>, 위면 <b className="font-semibold text-up-text">강세 쪽</b>이에요.
                {side ? <> 지금은 <b className="font-semibold">{side === 'above' ? '위' : '아래'}</b>{live != null ? <span className="tabular"> ({pct(live / pv.price - 1)})</span> : null}.</> : null}
                {!pv.inRange ? <> 24시간 범위 밖이라 하루 안에 닿기는 쉽지 않아요.</> : null}
              </p>
              {pv.ev ? (
                <p className="mt-1 text-[12.5px] leading-[1.5] break-keep text-muted-foreground">
                  {ymd(pv.ev.from).slice(0, 4)}년부터 이 선 위에선 24시간 뒤 {prob(pv.ev.above)}, 아래에선 {prob(pv.ev.below)}가 올랐어요
                  {pv.ev.above2y != null && pv.ev.below2y != null ? <> (최근 2년 {prob(pv.ev.above2y)} · {prob(pv.ev.below2y)})</> : null}.
                  {Math.abs(pv.ev.above - pv.ev.below) < 0.03 ? ' 차이가 크지 않아요.' : ''}
                </p>
              ) : null}
            </section>
          ) : null}

          <H1Section live={live} edge={h1.edge} bt={bt} now={now} />

          {/* 예측 성적 */}
          <section aria-label="예측 성적" className="rounded-[14px] bg-tile px-3.5 pt-2.5 pb-1.5">
            <h3 className="text-[13.5px] font-bold">예측 성적</h3>
            {d.yesterday ? (
              <Line label={`어제 ${hourLabel(d.yesterday.t)} 예측`}>
                <span className="tabular">예상 <span className={toneCls(d.yesterday.m)}>{pct(d.yesterday.m)}</span> → 실제 <b className={cn('font-semibold', toneCls(d.yesterday.actual))}>{pct(d.yesterday.actual)}</b></span>
                <span className="mt-1 flex justify-end"><Verdict s={d.yesterday} /></span>
              </Line>
            ) : null}
            {d.live && d.live.n >= 7 ? (
              <Line label={`실제 기록 최근 ${d.live.n}일`} className={d.yesterday ? 'border-t border-border' : ''}>
                <span className="tabular">방향 {frac(d.live.dir)} · 범위 안 {frac(d.live.range)}</span>
              </Line>
            ) : bt ? (
              <Line label="지난 30일 되짚어 봄" className={d.yesterday ? 'border-t border-border' : ''}>
                <span className="tabular">방향 {frac(bt.d30.dir)} · 범위 안 {frac(bt.d30.range)}</span>
                <span className="block text-[12px] text-muted-foreground">실제 기록은 {d.live?.days ? `${d.live.days}일째` : '이제 시작'}예요</span>
              </Line>
            ) : null}
          </section>
        </div>
      </div>
      <Record d={d} />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <UpbitLink />
        <p className="text-[12px] text-muted-foreground">지난 데이터로 만든 참고 자료예요 · 투자 권유가 아니에요</p>
      </div>
    </Card>
  );
}

/** 1시간 뒤 예상 — 브라우저가 정시마다 업비트 시간봉으로 바로 계산 (수집기 결과는 볼 때 이미 지난 시간이기 쉬워서) */
function H1Section({ live, edge, bt, now }: { live: number | null; edge: BtcHorizon['edge']; bt: BtcBacktest | null | undefined; now: number }) {
  const { f, loading, failed } = useBtcH1();
  const head = (
    <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-[13.5px] text-muted-foreground">
      <span>1시간 뒤 예상{f ? <span className="tabular"> · {hourLabel(new Date(f.target * 1000).toISOString())}까지</span> : null}</span>
      {f ? <span className="text-[12px]">{hourLabel(new Date(f.asOf * 1000).toISOString())} 종가 기준 · 정시마다 새로</span> : null}
    </p>
  );
  if (!f) {
    return (
      <section aria-label="1시간 뒤 예상">
        {head}
        {loading && !failed ? <Skeleton className="mt-1.5 h-7 w-56 bg-secondary" />
          : <p className="mt-1 text-[13.5px] text-muted-foreground">1시간 예측은 잠시 뒤에 보여 드려요.</p>}
      </section>
    );
  }
  const over = now / 1000 > f.target + 60;
  const sofar = live != null && !over ? live / f.price - 1 : null;
  const h = { h: 1 as const, edge } as BtcHorizon;
  return (
    <section aria-label="1시간 뒤 예상">
      {head}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <b className={cn('text-[22px] leading-7 font-bold tracking-[-0.02em] tabular', toneCls(f.med, 2))}>{pct(f.med, 2)}</b>
        <span className="text-[13.5px] text-secondary-foreground tabular">10번 중 8번 {pct(f.lo)} ~ {pct(f.hi)}</span>
        <span className="text-[13.5px] text-muted-foreground">오를 확률 <b className="font-semibold text-foreground tabular">{prob(f.pUp)}</b></span>
      </div>
      {sofar != null ? (
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          이번 시간 지금까지 <span className={cn('font-semibold tabular', toneCls(sofar, 2))}>{pct(sofar, 2)}</span>
          {sofar < f.lo || sofar > f.hi ? ' · 이미 범위 밖' : ''}
        </p>
      ) : null}
      <p className="mt-1 text-[12.5px] leading-[1.5] break-keep text-muted-foreground">{edgeNote(h, bt)}</p>
    </section>
  );
}

function Head({ live, chg, asOf, stale, delayed }: { live: number | null; chg: number | null; asOf: string | null; stale: boolean; delayed?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <SymbolLogo sym={BTC_SYM} size={40} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[18px] leading-6 font-bold tracking-[-0.02em] md:text-[20px]">비트코인 <span className="text-muted-foreground">· 다음 24시간</span></h2>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
          {asOf ? <span className="tabular">{relDay(asOf)} {hourLabel(asOf)} 기준</span> : <span>업비트 원화</span>}
          {stale ? <span className="inline-flex h-5 items-center rounded-md bg-secondary px-1.5 text-[12px] font-semibold text-warn">오래된 예측</span> : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <Flash value={live} mode="text"><b className="block text-[17px] leading-6 font-bold tabular">{live != null ? fmtPriceUnit(live, 'upbit') : '–'}</b></Flash>
        <span className="inline-flex items-center gap-1.5">
          {delayed ? <span className="text-[12px] text-muted-foreground">지연</span> : null}
          <ChangeText value={chg} className="text-[13px] font-semibold" />
        </span>
      </div>
    </div>
  );
}

function UpbitLink() {
  return (
    <a href={UPBIT_BTC_URL} target="_blank" rel="noopener noreferrer"
      className="press inline-flex h-10 items-center gap-1 rounded-xl px-1 text-[14px] font-semibold text-secondary-foreground hover:text-foreground">
      업비트에서 보기<ExternalLink aria-hidden className="size-4" />
    </a>
  );
}
