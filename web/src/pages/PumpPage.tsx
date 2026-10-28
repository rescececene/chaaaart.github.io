// 펌핑 후보 — 업비트 원화 전 종목의 '72시간 안 +15%' 가능성 점수 (collector/pump.py)
// 맨 위: 과거 검증(워크포워드)을 쉬운 말로 먼저 — 효과가 약하거나 급락도 함께 늘면 숨기지 않는다.
// 목록: 점수 순 30개. 줄을 누르면 예상 %·근거·위험·영역 점수·점수 이력·매물대를 펼친다(펼칠 때만 그린다).
// 그 아래: 실제 신호 기록(백테스트와 구분) → 예측 성적(자세히) → 전 종목 점수 → 점수 없는 신규 상장 코인.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Info, Rocket } from 'lucide-react';
import type { PageProps } from '@/App';
import { cn } from '@/lib/utils';
import { AiMark, Card, CARD_CLS, CardTitle, Empty, PageTitle } from '@/components/common/Card';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { Segmented } from '@/components/common/Segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuote, useWant } from '@/hooks/market';
import { fmtPrice, timeAgo } from '@/lib/format';
import { remember } from '@/lib/market';
import {
  parseHist, pumpData, pumpLog, pumpStats, tickerOfCode, upbitUrl,
  type PumpBucket, type PumpData, type PumpItem, type PumpLog, type PumpLogItem, type PumpOrderStat, type PumpRow, type PumpStats,
} from '@/lib/market/pump';
import { href } from '@/lib/router';
import { DIR, eok, p0, PartBars, RiskChips, ScoreLine, sp, SpanBar, stampT, VpChart } from '@/components/pump/parts';

const pad = (n: number) => String(n).padStart(2, '0');
const stampIso = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(+d) ? `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
};
const DETAILS = cn(CARD_CLS, 'group px-4 py-1 sm:px-5');
const SUMMARY = 'press flex h-12 cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden';

// ── 맨 위: 과거 검증 요약 ─────────────────────────────────────────────
function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-[14px] bg-tile px-3 py-2.5">
      <div className="truncate text-[12.5px] text-muted-foreground">{label}</div>
      <div className={cn('text-[20px] leading-7 font-bold tracking-[-0.02em] tabular', tone)}>{value}</div>
      {sub ? <div className="truncate text-[12px] text-muted-foreground tabular">{sub}</div> : null}
    </div>
  );
}

/** '이럴 땐' 경고 — 지금이 과거에 펌핑 점수 상위 코인의 급락이 펌핑만큼 잦았던 국면이면 맨 위에 */
function RegimeWarn({ data }: { data: PumpData | undefined }) {
  const g = data?.regime;
  if (!g?.warn) return null;
  const why: string[] = [];
  if (g.hot && g.mktPump7 != null) why.push(`최근 7일 업비트 코인의 ${p0(g.mktPump7)}가 3일 안 +15%를 찍었고(지난 분포의 상위 1/3)`);
  if (g.btcDown && g.btc7 != null) why.push(`비트코인은 7일 동안 ${sp(g.btc7)}예요`);
  const rng = (xs: number[]) => {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return p0(lo) === p0(hi) ? p0(lo) : `${p0(lo)}~${p0(hi)}`;
  };
  const st = g.stats;
  return (
    <div role="alert" className={cn(CARD_CLS, 'mb-2 flex gap-3 border-l-4 border-warn px-4 py-3.5 text-[13.5px] leading-[1.6] sm:mb-3 sm:px-5 lg:mb-4')}>
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 break-keep">
        <p className="font-bold text-foreground">지금은 펌핑 후보가 급락도 잦은 때예요.</p>
        <p className="text-secondary-foreground">{why.join(', ')}.</p>
        {st.length ? (
          <p className="mt-0.5 text-muted-foreground tabular" title={st.map((r) => `${r.name} ${r.days}일`).join(' · ')}>
            과거 이런 때 펌핑 점수 상위 5개는 <b className="font-semibold text-down-text">급락 {rng(st.map((r) => r.score.dump))}</b>로
            펌핑({rng(st.map((r) => r.score.pump))})만큼 잦았어요. 그래서 지금은 목록을 ‘급락 위험 뺀 순’으로만 보여 줘요
            (같은 때 펌핑 {rng(st.map((r) => r.net.pump))} · 급락 {rng(st.map((r) => r.net.dump))}).
          </p>
        ) : <p className="mt-0.5 text-muted-foreground">그래서 지금은 목록을 ‘급락 위험 뺀 순’으로만 보여 줘요.</p>}
      </div>
    </div>
  );
}

function openRecord(e: React.MouseEvent) {
  const el = document.getElementById('pump-record') as HTMLDetailsElement | null;
  if (!el) return;
  e.preventDefault();
  el.open = true;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function Verdict({ data, stats }: { data: PumpData | undefined; stats: PumpStats | undefined }) {
  const top: PumpBucket | null | undefined = stats?.bucketsCand?.[0] ?? data?.summary?.top;
  const base = stats?.base ?? data?.summary?.base;
  const verdict = stats?.verdict ?? data?.summary?.verdict;
  if (!top || top.pump == null || !base) {
    return (
      <div role="note" className={cn(CARD_CLS, 'mb-2 px-4 py-3.5 text-[13.5px] leading-[1.55] sm:mb-3 sm:px-5')}>
        <p className="break-keep text-muted-foreground">과거 검증 결과를 준비하고 있어요. 검증이 끝나기 전 점수는 참고만 해 주세요.</p>
      </div>
    );
  }
  return (
    <section aria-label="과거 검증 요약" className={cn(CARD_CLS, 'mb-2 px-4 py-3.5 sm:mb-3 sm:px-5 sm:py-4 lg:mb-4')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-bold tracking-[-0.01em]">과거 검증 · 후보 점수 90 이상</h2>
        <span className={cn('inline-flex h-[22px] items-center rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap',
          verdict === 'ok' ? 'bg-secondary text-secondary-foreground' : 'bg-warn/15 text-[color-mix(in_srgb,var(--warn)_55%,var(--foreground))]')}>
          {verdict === 'ok' ? `펌핑 평소의 ${(top.lift ?? 0).toFixed(1)}배` : verdict === 'weak' ? '효과 약함' : '판단 보류'}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5 sm:gap-2">
        <Tile label="+15% 펌핑" value={p0(top.pump)} sub={`평소 ${p0(base.pump)}`} tone="text-up-text" />
        <Tile label="−15% 급락" value={p0(top.dump)} sub={`평소 ${p0(base.dump)}`} tone="text-down-text" />
        <Tile label="3일 뒤 중앙값" value={sp(top.medR72)} sub={`평소 ${sp(base.medR72)}`} tone={DIR(top.medR72)} />
      </div>
      <p className="mt-2.5 text-[13px] leading-[1.55] break-keep text-muted-foreground">
        크게 움직일 코인을 고르는 점수예요 — 오를 코인을 고르는 게 아니에요(과거 {top.n.toLocaleString('ko-KR')}번, 수수료 뺌, 투자 권유 아님).
        {' '}<a href="#pump-record" onClick={openRecord} className="font-semibold text-foreground underline-offset-2 hover:underline">예측 성적 자세히</a>
      </p>
    </section>
  );
}

// ── 후보 목록 ─────────────────────────────────────────────────────
function Reason({ text, tone }: { text: string; tone: 'up' | 'down' | 'flat' }) {
  const g = tone === 'up' ? { c: '+', cls: 'text-up-text', sr: '펌핑 가능성을 올린 근거: ' }
    : tone === 'down' ? { c: '−', cls: 'text-down-text', sr: '펌핑 가능성을 내린 근거: ' } : { c: '·', cls: 'text-muted-foreground', sr: '' };
  return (
    <li className="flex gap-2 py-[3px] text-[13.5px] leading-5 text-secondary-foreground">
      <span aria-hidden className={cn('w-2.5 shrink-0 text-center text-[15px] leading-5 font-bold', g.cls)}>{g.c}</span>
      <span className="min-w-0 break-keep"><span className="sr-only">{g.sr}</span>{text.replace(/(^|[\s(~])-(?=\d)/g, '$1−')}</span>
    </li>
  );
}

function PredictTile({ title, q, note, foot }: { title: string; q: [number, number, number]; note?: string; foot?: string }) {
  return (
    <div className="rounded-[14px] bg-tile px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-muted-foreground">{title}</span>
        {note ? <span className="text-[12px] text-muted-foreground">{note}</span> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <b className={cn('text-[22px] leading-8 font-bold tracking-[-0.02em] tabular', DIR(q[1]))}>{sp(q[1])}</b>
        <span className="text-[13.5px] font-semibold text-secondary-foreground">예상</span>
      </div>
      <div className="text-[12.5px] text-muted-foreground tabular">10번 중 8번은 {sp(q[0], 0)} ~ {sp(q[2], 0)}</div>
      <SpanBar q10={q[0]} q50={q[1]} q90={q[2]} />
      {foot ? <div className="mt-1 text-[12px] text-muted-foreground tabular">{foot}</div> : null}
    </div>
  );
}

function Predict({ it }: { it: PumpItem }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <PredictTile title="3일 안 최고" note="72시간 안 가장 높은 가격" q={it.mfe}
        foot={it.own != null ? `이 코인 평소(최근 60일) ${sp(it.own)}` : undefined} />
      <PredictTile title="3일 뒤" note="72시간 뒤 가격" q={it.r72} foot={it.r24 != null ? `하루 뒤 예상 ${sp(it.r24)}` : undefined} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[13px] text-muted-foreground sm:col-span-2">
        <span>72시간 안 <b className="font-semibold text-up-text">+15% 펌핑 {p0(it.pPump)}</b></span>
        <span>·</span>
        <span><b className="font-semibold text-down-text">−15% 급락 {p0(it.pDump)}</b></span>
        <span className="text-[12px]">(과거 같은 점수대의 실제 비율)</span>
      </div>
    </div>
  );
}

function Detail({ it, thr, mode }: { it: PumpItem; thr: number; mode: 'net' | 'score' }) {
  const [allParts, setAllParts] = useState(false);
  const hist = useMemo(() => parseHist(mode === 'net' ? it.hist : (it.histP ?? it.hist)), [it.hist, it.histP, mode]);
  const notes = it.reasons.filter((r) => r.g === 'notice');
  const reasons = it.reasons.filter((r) => r.g !== 'notice');
  return (
    <div className="space-y-4 px-1 pt-1 pb-4 sm:px-2">
      <Predict it={it} />
      {it.ai ? (
        <p className="rounded-[14px] border border-border px-3.5 py-3 text-[14px] leading-[1.6] break-keep text-secondary-foreground">
          {it.ai}{it.aiBy && it.aiBy !== 'rule' ? <span title={`${it.aiBy === 'claude' ? '클로드' : it.aiBy === 'gemma' ? 'Gemma' : 'AI'}가 위 숫자만 보고 쓴 문장이에요`}><AiMark /></span> : null}
        </p>
      ) : null}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-[14px] font-bold">영역별 점수 <span className="text-[12.5px] font-normal text-muted-foreground">50 = 보통</span></h4>
          <button type="button" onClick={() => setAllParts((v) => !v)} className="press text-[12.5px] font-semibold text-muted-foreground hover:text-foreground">
            {allParts ? '5개만' : '전부 보기'}
          </button>
        </div>
        <PartBars parts={it.parts} all={allParts} />
        <p className="mt-1.5 text-[12px] leading-[1.5] break-keep text-muted-foreground">막대는 설명용 로지스틱 부분에서 그 영역이 펌핑 확률을 올린 정도예요(학습 표 백분위).</p>
      </div>
      {reasons.length > 0 && (
        <div>
          <h4 className="mb-1 text-[14px] font-bold">근거</h4>
          <ul>{reasons.map((r, i) => <Reason key={i} text={r.t} tone={r.tone} />)}</ul>
          {notes.map((r, i) => <p key={i} className="mt-1 flex gap-1.5 text-[13px] leading-5 break-keep text-muted-foreground"><Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />{r.t}</p>)}
        </div>
      )}
      {it.risks.length > 0 && (
        <div>
          <h4 className="mb-1 text-[14px] font-bold">위험</h4>
          <ul className="space-y-1">
            {[...it.risks].sort((a, b) => b.lv - a.lv).map((r) => (
              <li key={r.k + r.t} className="flex gap-2 text-[13.5px] leading-5 break-keep text-secondary-foreground">
                <AlertTriangle aria-hidden className={cn('mt-0.5 size-4 shrink-0', r.lv >= 2 ? 'text-warn' : 'text-faint')} />
                <span className="min-w-0">{r.t}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-1.5 text-[14px] font-bold">{mode === 'net' ? '후보 점수' : '펌핑 점수'} 이력 <span className="text-[12.5px] font-normal text-muted-foreground">최근 14일 · 1시간마다 · 지금 후보 {Math.round(it.cand)} · 펌핑 {Math.round(it.score)}</span></h4>
          <ScoreLine hist={hist} thr={thr} />
        </div>
        {it.vp ? (
          <div>
            <h4 className="mb-1.5 text-[14px] font-bold">매물대 <span className="text-[12.5px] font-normal text-muted-foreground">최근 120일 가격대별 거래대금</span></h4>
            <VpChart vp={it.vp} />
            <p className="mt-1 text-[12px] leading-[1.5] break-keep text-muted-foreground">진한 막대 = 가장 많이 거래된 가격대. 지금 가격 위(+15% 점선까지) 막대가 짧을수록 위쪽 물량이 얇아요.</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={href('chart', it.sym, '1d')} className="press inline-flex h-10 items-center gap-1 rounded-xl bg-secondary px-3.5 text-[14px] font-semibold text-secondary-foreground hover:bg-border/60">
          차트 보기<ChevronRight aria-hidden className="size-4" />
        </a>
        <a href={upbitUrl(it.code)} target="_blank" rel="noopener noreferrer" className="press inline-flex h-10 items-center gap-1.5 rounded-xl bg-secondary px-3.5 text-[14px] font-semibold text-secondary-foreground hover:bg-border/60">
          업비트에서 보기<ExternalLink aria-hidden className="size-3.5" /><span className="sr-only">(새 창)</span>
        </a>
      </div>
      {it.stale ? <p className="text-[12px] text-muted-foreground">이 코인은 이번에 시간봉을 다 받지 못해 조금 전 기준이에요.</p> : null}
    </div>
  );
}

const Candidate = memo(function Candidate({ it, rank, mode, open, onToggle, thr }: {
  it: PumpItem; rank: number; mode: 'net' | 'score'; open: boolean; onToggle: (code: string) => void; thr: number;
}) {
  const q = useQuote(it.sym);
  const price = q?.price ?? it.price;
  const big = mode === 'net' ? it.cand : it.score;
  const d24 = mode === 'net' ? it.d24 : it.d24p;
  return (
    <li id={`pump-${it.code}`} className={cn('scroll-mt-20 border-b border-border last:border-b-0', open && 'bg-transparent')}>
      <button type="button" aria-expanded={open} onClick={() => onToggle(it.code)}
        className="press -mx-2 grid w-[calc(100%+16px)] grid-cols-[18px_36px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-xl px-2 py-3 text-left transition-colors hover:bg-hover sm:grid-cols-[22px_40px_minmax(0,1fr)_auto]">
        <span className="text-right text-[13px] font-semibold text-muted-foreground tabular">{rank}</span>
        <SymbolLogo sym={it.sym} size={36} className="sm:size-10" />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <b className="truncate text-[15.5px] leading-[21px] font-semibold tracking-[-0.01em]">{it.name}</b>
            <RiskChips risks={it.risks} max={2} className="max-sm:hidden" />
            <RiskChips risks={it.risks} max={1} className="sm:hidden" />
          </span>
          <span className="block truncate text-[15px] leading-[22px] font-semibold text-secondary-foreground">
            3일 안 최고 <b className="text-[16px] font-bold text-up-text tabular">{sp(it.mfe[1])}</b> 예상
          </span>
          <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground tabular">
            펌핑<span className="max-sm:hidden">(+15%)</span> <b className="font-semibold text-up-text">{p0(it.pPump)}</b> · 급락<span className="max-sm:hidden">(−15%)</span> <b className="font-semibold text-down-text">{p0(it.pDump)}</b>
            {q?.chg != null ? <> · 24h <ChangeText value={q.chg} className="text-[12.5px]" /></> : null}
            <span className="max-sm:hidden"> · {tickerOfCode(it.code)} · {fmtPrice(price, 'upbit')}원{it.val24 != null ? ` · 거래 ${eok(it.val24)}` : ''}</span>
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-flex flex-col items-end leading-none"
            title={mode === 'net' ? '후보 점수 = 펌핑 확률 − 2 × 급락 확률 이 과거 코인·시점 중 몇 % 보다 큰지' : '펌핑 점수 = 펌핑 확률이 과거 코인·시점 중 몇 % 보다 높은지 (급락 위험 반영 전)'}>
            <b className={cn('text-[24px] font-bold tracking-[-0.03em] tabular', big >= thr ? 'text-foreground' : 'text-secondary-foreground')}>{Math.round(big)}</b>
            <span className="mt-1 text-[11px] whitespace-nowrap text-muted-foreground tabular">
              {mode === 'net' ? '후보 점수' : '펌핑 점수'}
              {d24 != null && Math.abs(d24) >= 1 ? <span className="max-sm:hidden"> · 24시간 {d24 > 0 ? '+' : '−'}{Math.abs(Math.round(d24))}</span> : null}
            </span>
          </span>
          <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open ? <Detail it={it} thr={thr} mode={mode} /> : null}
    </li>
  );
});

// ── 실제 신호 기록 ─────────────────────────────────────────────────
const KIND: Record<NonNullable<PumpLogItem['res']>['kind'], { text: string; cls: string }> = {
  pump: { text: '펌핑', cls: 'bg-up-soft text-up-text' },
  dump: { text: '급락', cls: 'bg-down-soft text-down-text' },
  both: { text: '펌핑·급락 둘 다', cls: 'bg-secondary text-secondary-foreground' },
  none: { text: '그 외', cls: 'bg-secondary text-muted-foreground' },
};

function LogRow({ x }: { x: PumpLogItem }) {
  const left = Math.max(0, Math.ceil((x.t + 72 * 3600 - Date.now() / 1000) / 3600));
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-b border-border py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <a href={href('chart', `upbit:${x.code}`, '1d')} className="truncate text-[14.5px] font-semibold hover:underline">{x.name}</a>
          <span className="shrink-0 text-[12.5px] text-muted-foreground tabular">{stampT(x.t)} · 후보 점수 {Math.round(x.score)} · {fmtPrice(x.price, 'upbit')}원</span>
        </div>
        <p className="text-[13px] leading-5 break-keep text-secondary-foreground tabular">
          예상 최고 <b className="font-semibold text-up-text">{sp(x.mfe[1])}</b>
          {x.status === 'done' && x.res ? (
            <> → 실제 최고 <b className={cn('font-semibold', DIR(x.res.mfe))}>{sp(x.res.mfe)}</b>, 3일 뒤 <b className={cn('font-semibold', DIR(x.res.r72))}>{sp(x.res.r72)}</b>
              <span className="text-muted-foreground"> (최저 {sp(x.res.mae)})</span></>
          ) : x.status === 'na' ? <span className="text-muted-foreground"> → 결과를 확인하지 못했어요</span>
            : <span className="text-muted-foreground"> → 3일 뒤 채점 ({left}시간 남음)</span>}
        </p>
      </div>
      {x.status === 'done' && x.res ? (
        <span className={cn('mt-0.5 inline-flex h-[22px] items-center rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap', KIND[x.res.kind].cls)}>{KIND[x.res.kind].text}</span>
      ) : (
        <span className="mt-0.5 inline-flex h-[22px] items-center rounded-md bg-secondary px-1.5 text-[12px] font-semibold whitespace-nowrap text-muted-foreground">{x.status === 'na' ? '확인 불가' : '채점 대기'}</span>
      )}
    </li>
  );
}

function SignalLog({ log }: { log: PumpLog | undefined }) {
  const [more, setMore] = useState(false);
  if (!log) return null;
  const items = [...log.items].sort((a, b) => b.t - a.t);
  const s = log.summary, bt = log.backtest;
  const shown = more ? items.slice(0, 120) : items.slice(0, 12);
  return (
    <Card>
      <CardTitle sub={`후보 점수가 ${log.thr} 이상으로 올라선 순간의 가격을 적어 두고 72시간 뒤에 채점해요 (같은 코인은 72시간에 한 번)`}>실제 신호 기록</CardTitle>
      <div className="mb-2 rounded-[14px] bg-tile px-3.5 py-3 text-[13px] leading-[1.6] break-keep text-secondary-foreground">
        {s.graded > 0 ? (
          <p>
            채점된 <b className="font-semibold">{s.graded}번</b> 중 펌핑 <b className="font-semibold text-up-text">{p0(s.pump)}</b> · 급락 <b className="font-semibold text-down-text">{p0(s.dump)}</b>
            · 3일 뒤 중앙값 <b className={cn('font-semibold', DIR(s.medR72))}>{sp(s.medR72)}</b>
            {s.medMfe != null ? <> · 실제 최고 중앙값 {sp(s.medMfe)}(예상 {sp(s.predMfe)})</> : null}
          </p>
        ) : <p>아직 채점이 끝난 신호가 없어요 (신호 뒤 72시간이 지나야 채점해요). 지금까지 {s.n}번 기록했어요.</p>}
        {bt ? (
          <p className="mt-0.5 text-muted-foreground">
            같은 규칙을 과거에 적용했을 때(백테스트 {bt.n.toLocaleString('ko-KR')}번): 펌핑 {p0(bt.pump)} · 급락 {p0(bt.dump)} · 3일 뒤 중앙값 {sp(bt.medR72)}
          </p>
        ) : null}
      </div>
      {items.length ? (
        <>
          <ul>{shown.map((x) => <LogRow key={`${x.code}-${x.t}`} x={x} />)}</ul>
          {items.length > shown.length || more ? (
            <button type="button" onClick={() => setMore((v) => !v)} className="press mt-2 h-10 w-full rounded-xl bg-secondary text-[14px] font-semibold text-secondary-foreground hover:bg-border/60">
              {more ? '접기' : `더 보기 (${items.length}개)`}
            </button>
          ) : null}
        </>
      ) : <p className="py-6 text-center text-[13.5px] text-muted-foreground">아직 기록된 신호가 없어요.</p>}
    </Card>
  );
}

// ── 예측 성적 (자세히) ─────────────────────────────────────────────
function BucketTable({ rows, base }: { rows: PumpBucket[]; base: PumpStats['base'] }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[440px] text-[13px]">
        <thead>
          <tr className="text-[12px] text-muted-foreground">
            <th className="py-1.5 pl-1 text-left font-normal">점수</th>
            <th className="py-1.5 text-right font-normal">횟수</th>
            <th className="py-1.5 text-right font-normal">+15% 펌핑</th>
            <th className="py-1.5 text-right font-normal">−15% 급락</th>
            <th className="py-1.5 text-right font-normal">3일 안 최고<span className="block">실제(예상)</span></th>
            <th className="py-1.5 pr-1 text-right font-normal">3일 뒤<span className="block">중앙값</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.filter((r) => r.n > 0).map((r) => (
            <tr key={r.name} className="border-t border-border">
              <th scope="row" className="py-2 pl-1 text-left font-semibold">{r.name}</th>
              <td className="py-2 text-right text-muted-foreground tabular">{r.n.toLocaleString('ko-KR')}</td>
              <td className="py-2 text-right font-semibold tabular">{p0(r.pump)}<span className="block text-[11.5px] font-normal text-muted-foreground">{r.lift != null ? `${r.lift.toFixed(1)}배` : ''}</span></td>
              <td className="py-2 text-right font-semibold tabular">{p0(r.dump)}<span className="block text-[11.5px] font-normal text-muted-foreground">{r.dumpLift != null ? `${r.dumpLift.toFixed(1)}배` : ''}</span></td>
              <td className="py-2 text-right tabular">{sp(r.medMfe)}<span className="block text-[11.5px] text-muted-foreground">({sp(r.predMfe)})</span></td>
              <td className={cn('py-2 pr-1 text-right font-semibold tabular', DIR(r.medR72))}>{sp(r.medR72)}</td>
            </tr>
          ))}
          <tr className="border-t border-border text-muted-foreground">
            <th scope="row" className="py-2 pl-1 text-left font-normal">평소(전체)</th>
            <td className="py-2 text-right tabular">{base.n.toLocaleString('ko-KR')}</td>
            <td className="py-2 text-right tabular">{p0(base.pump)}</td>
            <td className="py-2 text-right tabular">{p0(base.dump)}</td>
            <td className="py-2 text-right tabular">{sp(base.medMfe)}</td>
            <td className="py-2 pr-1 text-right tabular">{sp(base.medR72)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CompareTable({ rows }: { rows: PumpStats['compare']['all'] }) {
  const f3 = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(3));
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[460px] text-[13px]">
        <thead>
          <tr className="text-[12px] text-muted-foreground">
            <th className="py-1.5 pl-1 text-left font-normal">방법</th>
            <th className="py-1.5 text-right font-normal" title="1 = 완벽, 0.5 = 동전 던지기">펌핑 AUC<span className="block">전체 · 같은 날</span></th>
            <th className="py-1.5 text-right font-normal">상위 10%<span className="block">펌핑</span></th>
            <th className="py-1.5 text-right font-normal">상위 10%<span className="block">급락</span></th>
            <th className="py-1.5 pr-1 text-right font-normal">3일 뒤<span className="block">중앙값</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={cn('border-t border-border', r.key === 'blend' && 'font-semibold')}>
              <th scope="row" className="py-2 pl-1 text-left font-[inherit]">{r.name}{r.note ? <span className="block text-[11.5px] font-normal text-muted-foreground">{r.note}</span> : null}</th>
              <td className="py-2 text-right tabular">{f3(r.auc)}<span className="block text-[11.5px] font-normal text-muted-foreground">{f3(r.dailyAuc)}</span></td>
              <td className="py-2 text-right tabular">{p0(r.top10Pump)}<span className="block text-[11.5px] font-normal text-muted-foreground">{r.lift != null ? `${r.lift.toFixed(2)}배` : ''}</span></td>
              <td className="py-2 text-right tabular">{p0(r.top10Dump)}</td>
              <td className={cn('py-2 pr-1 text-right tabular', DIR(r.top10R72))}>{sp(r.top10R72)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 맨 위에서 옮겨 온 검증 요약 문단 + '펌핑 확률만 높은 코인은 급락도 잦았어요' 비교 */
function TopFindings({ stats }: { stats: PumpStats }) {
  const ord: PumpOrderStat | undefined = stats.orders?.[0];
  return (
    <section className="space-y-2">
      {stats.lines.slice(0, 2).map((l, i) => (
        <p key={i} className={cn('text-[13.5px] leading-[1.6] break-keep', i === 1 ? 'font-semibold text-foreground' : 'text-secondary-foreground')}>{l}</p>
      ))}
      {ord ? (
        <p className="rounded-[14px] border border-border px-3.5 py-3 text-[13.5px] leading-[1.6] break-keep text-secondary-foreground">
          <b className="font-bold text-foreground">펌핑 확률만 높은 코인은 급락도 잦았어요.</b> 날마다 펌핑 점수 상위 {ord.k}개는
          {' '}펌핑 <b className="font-semibold text-up-text tabular">{p0(ord.score.pump)}</b> · 급락 <b className="font-semibold text-down-text tabular">{p0(ord.score.dump)}</b> ·
          3일 뒤 시장 대비 <b className={cn('font-semibold tabular', DIR(ord.score.ex))}>{sp(ord.score.ex)}p</b>였고,
          급락 확률을 뺀 순 상위 {ord.k}개는 펌핑 <b className="font-semibold text-up-text tabular">{p0(ord.net.pump)}</b> · 급락 <b className="font-semibold text-down-text tabular">{p0(ord.net.dump)}</b> ·
          시장 대비 <b className={cn('font-semibold tabular', DIR(ord.net.ex))}>{sp(ord.net.ex)}p</b>였어요. 그래서 목록 기본은 ‘급락 위험 뺀 순’이에요.
        </p>
      ) : null}
    </section>
  );
}

function TrackRecord({ stats }: { stats: PumpStats | undefined }) {
  const [period, setPeriod] = useState<'all' | 'recent'>('all');
  if (!stats) return null;
  const c = stats.calib;
  const rec = stats.recent;
  const buckets = period === 'recent' && rec ? (rec.bucketsCand ?? rec.buckets) : (stats.bucketsCand ?? stats.buckets);
  const bucketsP = period === 'recent' && rec ? rec.buckets : stats.buckets;
  const base = period === 'recent' && rec ? rec.base : stats.base;
  const cmp = period === 'recent' ? stats.compare.recent : stats.compare.all;
  return (
    <details id="pump-record" className={cn(DETAILS, 'scroll-mt-20')}>
      <summary className={SUMMARY}>
        예측 성적 <span className="text-[12.5px] font-normal text-muted-foreground">과거 검증 {stats.from} ~ {stats.to}</span>
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 pb-5">
        <TopFindings stats={stats} />
        {rec ? (
          <Segmented size="sm" value={period} onChange={setPeriod}
            items={[{ value: 'all', label: '검증 전체' }, { value: 'recent', label: `최근 (${rec.from.slice(0, 7)}~)` }]} />
        ) : null}
        <section>
          <h3 className="mb-1 text-[15px] font-bold">후보 점수 구간별 실제 결과</h3>
          <p className="mb-2 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
            그 시점까지의 데이터로만 학습한 모델이 매긴 점수예요(워크포워드). 같은 코인이 72시간 안에 다시 들어온 날은 겹치는 표본이라 뺐어요.
            {period === 'recent' ? ' 최근 구간은 특징·설정을 고를 때 보지 않고 남겨 둔 기간이에요.' : ''}
          </p>
          <BucketTable rows={buckets} base={base} />
          <h4 className="mt-4 mb-1 text-[14px] font-bold">펌핑 점수(급락 위험 빼기 전) 구간별</h4>
          <BucketTable rows={bucketsP} base={base} />
        </section>
        <section>
          <h3 className="mb-1 text-[15px] font-bold">예상 % 는 맞았나</h3>
          <ul className="space-y-1 text-[13.5px] leading-[1.6] break-keep text-secondary-foreground">
            {c.mfe.map((r) => (
              <li key={r.lo} className="tabular">
                ‘3일 안 최고 {sp(Math.max(0, r.lo), 0)}~{r.hi > 1 ? '' : sp(r.hi, 0)} 예상’ {r.n.toLocaleString('ko-KR')}번 → 실제 중앙값 <b className="font-semibold">{sp(r.act)}</b>
                <span className="text-muted-foreground"> (예상 {sp(r.pred)})</span>
              </li>
            ))}
            <li>‘10번 중 8번은 A ~ B’ 안에 실제 3일 뒤 수익이 들어온 비율 <b className="font-semibold">{p0(c.cover80)}</b> <span className="text-muted-foreground">(목표 80%)</span></li>
            <li>‘3일 뒤 예상 %’의 순위 상관 <b className="font-semibold tabular">{c.r72Ic >= 0 ? '+' : '−'}{Math.abs(c.r72Ic).toFixed(2)}</b>
              <span className="text-muted-foreground"> — {Math.abs(c.r72Ic) < 0.05 ? '방향은 거의 맞히지 못해요. 범위(흔들림 크기)를 보세요.' : '약해요.'}</span></li>
            <li>‘3일 안 최고’의 순위 상관 <b className="font-semibold tabular">{c.mfeIc.toFixed(2)}</b>, 그냥 평균값으로 맞힐 때보다 오차 {Math.round(c.mfeSkill * 100)}% 줄었어요.</li>
          </ul>
          {c.pump.length ? (
            <p className="mt-1.5 text-[12.5px] leading-[1.55] break-keep text-muted-foreground tabular">
              펌핑 확률 보정: {c.pump.map((r) => `예상 ${p0(r.pred)} → 실제 ${p0(r.act)}`).join(' · ')}
            </p>
          ) : null}
          {c.dump.length ? (() => {
            const n = c.dump.reduce((a, r) => a + r.n, 0);
            const over = n ? c.dump.reduce((a, r) => a + (r.pred - r.act) * r.n, 0) / n : 0;
            return (
              <p className="mt-1 text-[12.5px] leading-[1.55] break-keep text-muted-foreground tabular">
                급락 확률 보정: {c.dump.map((r) => `예상 ${p0(r.pred)} → 실제 ${p0(r.act)}`).join(' · ')}
                {over > 0.01 ? ' — 최근엔 급락이 예전보다 줄어서 급락 확률이 실제보다 높게 나오는 편이에요.' : ''}
              </p>
            );
          })() : null}
        </section>
        {stats.orders?.length ? (
          <section>
            <h3 className="mb-1 text-[15px] font-bold">목록 순서 비교</h3>
            <p className="mb-2 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
              날마다 상위 몇 개를 골랐다면 — ‘시장 대비’는 같은 날 전 종목 3일 수익 중앙값과의 차이예요(평균).
            </p>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[420px] text-[13px]">
                <thead>
                  <tr className="text-[12px] text-muted-foreground">
                    <th className="py-1.5 pl-1 text-left font-normal">순서</th>
                    <th className="py-1.5 text-right font-normal">+15% 펌핑</th>
                    <th className="py-1.5 text-right font-normal">−15% 급락</th>
                    <th className="py-1.5 text-right font-normal">3일 뒤 중앙값</th>
                    <th className="py-1.5 pr-1 text-right font-normal">시장 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.orders.flatMap((o) => (['net', 'score'] as const).map((k) => (
                    <tr key={`${o.k}-${k}`} className={cn('border-t border-border', k === 'net' && 'font-semibold')}>
                      <th scope="row" className="py-2 pl-1 text-left font-[inherit]">{k === 'net' ? '급락 위험 뺀 순' : '펌핑 점수 순'} {o.k}개</th>
                      <td className="py-2 text-right tabular">{p0(o[k].pump)}</td>
                      <td className="py-2 text-right tabular">{p0(o[k].dump)}</td>
                      <td className={cn('py-2 text-right tabular', DIR(o[k].medR72))}>{sp(o[k].medR72)}</td>
                      <td className={cn('py-2 pr-1 text-right tabular', DIR(o[k].ex))}>{sp(o[k].ex)}p</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
            {stats.orders[0].exDiffCi ? (
              <p className="mt-1.5 text-[12.5px] leading-[1.55] break-keep text-muted-foreground tabular">
                상위 {stats.orders[0].k}개 기준 두 순서의 시장 대비 차이 {sp(stats.orders[0].exDiff)}p (95% 구간 {sp(stats.orders[0].exDiffCi[0])}p ~ {sp(stats.orders[0].exDiffCi[1])}p, 5일 묶음 부트스트랩)
                {stats.orders[0].exDiffCi[0] <= 0 ? ' — 수익 차이는 확실하지 않고, 급락이 줄어든 게 분명한 차이예요.' : ''}
              </p>
            ) : null}
          </section>
        ) : null}
        <section>
          <h3 className="mb-1 text-[15px] font-bold">다른 방법과 비교</h3>
          <p className="mb-2 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
            같은 기간·같은 방식(표본 밖)으로 맞혀 본 결과예요. ‘같은 날’은 그날 코인끼리만 비교한 값이고, 상위 10%는 날마다 점수 상위 10% 코인이에요.
          </p>
          <CompareTable rows={cmp} />
        </section>
        {(stats.risk && Object.keys(stats.risk).length) || stats.events?.suspend ? (
          <section>
            <h3 className="mb-1 text-[15px] font-bold">위험 표시는 맞았나</h3>
            <ul className="space-y-1 text-[13.5px] leading-[1.6] break-keep text-secondary-foreground">
              {Object.entries(stats.risk).map(([k, r]) => r && (
                <li key={k} className="tabular">{r.name}: 급락 <b className="font-semibold text-down-text">{p0(r.dump)}</b> · 펌핑 {p0(r.pump)} · 3일 뒤 중앙값 {sp(r.medR72)} <span className="text-muted-foreground">({r.n.toLocaleString('ko-KR')}번, 평소 급락 {p0(stats.base.dump)})</span></li>
              ))}
              {stats.events?.suspend ? (
                <li className="tabular">업비트 입출금 일시 중단 공지 그날·다음 날: 펌핑 {p0(stats.events.suspend.pump)} <span className="text-muted-foreground">(점수가 말한 {p0(stats.events.suspend.pred)}, {stats.events.suspend.n}번) — 점수에는 넣지 않고 근거 줄로만 보여 줘요</span></li>
              ) : null}
            </ul>
          </section>
        ) : null}
        <section>
          <h3 className="mb-1 text-[15px] font-bold">어떻게 검증했나요</h3>
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-[1.6] break-keep text-muted-foreground">
            {stats.method.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
          <h3 className="mt-3 mb-1 text-[15px] font-bold">한계</h3>
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-[1.6] break-keep text-muted-foreground">
            {stats.limits.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
          <p className="mt-2 text-[12px] text-muted-foreground tabular">
            학습 데이터 {stats.data.from} ~ {stats.data.to} · 코인 {stats.data.coins}개 · {stats.data.rows.toLocaleString('ko-KR')}줄 · 검증 갱신 {stampIso(stats.updatedAt)}
          </p>
        </section>
      </div>
    </details>
  );
}

// ── 전 종목 · 신규 상장 ───────────────────────────────────────────
function AllCoins({ rows, young }: { rows: PumpRow[]; young: PumpData['young'] }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toUpperCase();
    return s ? rows.filter((r) => r[0].includes(s) || r[1].toUpperCase().includes(s)) : rows;
  }, [rows, q]);
  return (
    <details className={DETAILS}>
      <summary className={SUMMARY}>
        전 종목 점수 <span className="text-[12.5px] font-normal text-muted-foreground">{rows.length}개{young.length ? ` · 점수 없음 ${young.length}개` : ''}</span>
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="코인 이름·티커 찾기" aria-label="코인 찾기"
          className="mb-2 h-10 w-full rounded-xl bg-secondary px-3.5 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        <div className="grid grid-cols-[minmax(0,1fr)_44px_64px_64px] gap-x-2 border-b border-border pb-1.5 text-[12px] text-muted-foreground">
          <span>코인</span><span className="text-right">후보</span><span className="text-right">+15%</span><span className="text-right">−15%</span>
        </div>
        <ul className="max-h-[480px] overflow-y-auto">
          {list.map((r) => (
            <li key={r[0]}>
              <a href={href('chart', `upbit:${r[0]}`, '1d')} className="grid grid-cols-[minmax(0,1fr)_44px_64px_64px] items-center gap-x-2 border-b border-border py-2 text-[13.5px] last:border-b-0 hover:bg-hover">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-semibold">{r[1]}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{tickerOfCode(r[0])}</span>
                  {r[8] >= 2 ? <span aria-label="위험 높음" title="위험 높음" className="size-1.5 shrink-0 rounded-full bg-warn" /> : null}
                </span>
                <b className="text-right font-bold tabular">{Math.round(r[2])}</b>
                <span className="text-right text-up-text tabular">{p0(r[6])}</span>
                <span className="text-right text-down-text tabular">{p0(r[7])}</span>
              </a>
            </li>
          ))}
        </ul>
        {young.length ? (
          <p className="mt-3 text-[12.5px] leading-[1.6] break-keep text-muted-foreground">
            <b className="font-semibold text-secondary-foreground">점수를 매기지 않은 코인(상장 60일 미만, 특징을 만들 데이터가 모자라요)</b>:{' '}
            {young.map((y) => `${y.name}(${y.days}일)`).join(', ')} — 업비트 신규 상장 코인은 과거 7일 수익 중앙값이 −11%였어요.
          </p>
        ) : null}
      </div>
    </details>
  );
}

export default function PumpPage({ args }: PageProps) {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({ queryKey: ['pump'], queryFn: pumpData, staleTime: 3 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });
  const { data: stats } = useQuery({ queryKey: ['pump-stats'], queryFn: pumpStats, staleTime: 30 * 60e3, retry: 1 });
  const { data: log } = useQuery({ queryKey: ['pump-log'], queryFn: pumpLog, staleTime: 5 * 60e3, refetchInterval: 10 * 60e3, retry: 1 });
  const items = useMemo(() => data?.items ?? [], [data]);
  const syms = useMemo(() => items.map((it) => it.sym), [items]);
  useWant(syms.length ? syms : null);
  useEffect(() => { items.forEach((it) => remember(it.sym, { name: it.name, sub: tickerOfCode(it.code) })); }, [items]);
  useEffect(() => { document.title = '펌핑 후보 — 마켓'; return () => { document.title = '마켓'; }; }, []);
  const want = args[0] ? decodeURIComponent(args[0]) : null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(want ? [want] : []));
  const scrolled = useRef(false);
  useEffect(() => {
    if (!want || scrolled.current || !items.some((it) => it.code === want)) return;
    scrolled.current = true;
    setOpen((s) => new Set(s).add(want));
    requestAnimationFrame(() => document.getElementById(`pump-${want}`)?.scrollIntoView({ block: 'start' }));
  }, [want, items]);
  const toggle = useMemo(() => (code: string) => setOpen((s) => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; }), []);
  const [pick, setOrder] = useState<'net' | 'score'>('net');
  const locked = !!data?.regime?.warn;
  const order = locked ? 'net' : pick;
  const list = useMemo(() => {
    const key = order === 'net' ? 'rankNet' : 'rank';
    return items.filter((it) => (it[key] ?? 999) <= 30).sort((a, b) => (a[key] ?? 999) - (b[key] ?? 999));
  }, [items, order]);
  const thr = data?.def?.sigThr ?? 90;
  const updated = data ? Date.parse(data.updatedAt) : NaN;
  const late = Number.isFinite(updated) && Date.now() - updated > 3 * 3600e3;
  const mk = data?.market;

  return (
    <div>
      <PageTitle sub={<span className="break-keep">업비트 원화 전 종목을 ‘72시간 안 +15%’ 가능성 점수로 줄 세웠어요 (시총·거래대금과 상관없이)</span>}>
        펌핑 후보
      </PageTitle>

      <RegimeWarn data={data} />
      <Verdict data={data} stats={stats} />

      {isLoading && (
        <div className={cn(CARD_CLS, 'space-y-3 p-4')}>{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl bg-secondary" />)}</div>
      )}
      {!isLoading && (isError || !data || !items.length) && (
        <Card><Empty icon={<Rocket />} title="펌핑 후보를 준비하고 있어요">{data?.note ?? '수집기가 돌면(40~70분 간격) 채워져요. 잠시 뒤 다시 확인해 주세요.'}</Empty></Card>
      )}
      {data && items.length > 0 && (
        <div className="space-y-2 sm:space-y-3 lg:space-y-4">
          <section aria-labelledby="pump-list" className={cn(CARD_CLS, 'px-4 pt-4 pb-2 sm:px-5 sm:pt-5')}>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
              <h2 id="pump-list" className="text-[18px] font-bold tracking-[-0.02em] md:text-[20px]">후보 {list.length}개</h2>
              <span className="text-[12.5px] text-muted-foreground tabular" title={timeAgo(updated)}>
                {data.asOfKst ? `${data.asOfKst} 기준` : ''} · {stampIso(data.updatedAt)} 갱신{late ? ' · 늦어지고 있어요' : ''}
              </span>
            </div>
            {locked ? (
              <p className="inline-flex h-8 items-center rounded-[10px] bg-secondary px-3 text-[13.5px] font-semibold text-secondary-foreground">급락 위험 뺀 순 (지금은 고정)</p>
            ) : (
              <Segmented full size="sm" value={order} onChange={setOrder}
                items={[{ value: 'net', label: '급락 위험 뺀 순' }, { value: 'score', label: '펌핑 점수 순' }]} />
            )}
            <p className="mt-2 mb-1 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
              {order === 'net'
                ? <>큰 숫자 = 후보 점수(‘펌핑 확률 − {data.wNet ?? 2} × 급락 확률’의 과거 백분위).</>
                : <>큰 숫자 = 펌핑 점수(급락 위험 반영 전) — 크게 오를 가능성이 높은 만큼 급락도 잦아요.</>}
              <span className="max-sm:hidden"> 예상 %·확률은 과거 같은 점수였던 자리의 실제 결과예요.
                {mk?.mkt_pump3 != null ? ` 지금 시장: 3일 전 기준 코인의 ${p0(mk.mkt_pump3)}가 펌핑했어요(평소 약 ${p0(stats?.base.pump ?? data.summary?.base?.pump)}).` : ''}</span>
            </p>
            <ol>{list.map((it, k) => <Candidate key={it.code} it={it} rank={k + 1} mode={order} open={open.has(it.code)} onToggle={toggle} thr={thr} />)}</ol>
          </section>
          <SignalLog log={log} />
          <TrackRecord stats={stats} />
          <AllCoins rows={data.all ?? []} young={data.young ?? []} />
          <p className="mx-4 text-[12px] leading-[1.6] break-keep text-muted-foreground sm:mx-1">
            지난 데이터로 만든 참고 자료일 뿐 투자 권유가 아니에요. 거래가 적은 코인은 표시된 가격에 사고팔기 어려울 수 있어요.
            {data.model?.trainedAt ? ` 모델 학습 ${stampIso(data.model.trainedAt)} (데이터 ~${data.model.dataTo}).` : ''}
            {dataUpdatedAt ? ` ${timeAgo(dataUpdatedAt)} 받아 옴.` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
