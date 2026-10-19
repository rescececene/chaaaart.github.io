// 기술적 분석 — 종합 의견(5칸 게이지 · 표 수) · 판단 근거(긍정 · 부정 · 객관) / 주요 지표(별도 카드)
// 분석은 차트에 보이는 주기(1분~월봉)로 계산된다 — 문장의 봉 단위는 IV_UNIT (일 · 주 · 개월, 분·시간봉은 '봉')
import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SIGNALS, type Analysis, type Tally, type Vote } from '@/lib/indicators';
import { fmt, fmtPrice } from '@/lib/format';
import { IV_UNIT, type Interval, type Market } from '@/lib/market';
import { roundTick } from '@/components/chart/OrderBook';

type Tone = 'up' | 'down' | 'flat';
const MINUS = '−';
const TONE_TEXT = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;
const ICON = { up: '▲', down: '▼', flat: '●' } as const;
const opTone = (label: string): Tone => (label.includes('매수') ? 'up' : label.includes('매도') ? 'down' : 'flat');
const voteTone = (v: number): Tone => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const VOTE_WORD = { up: '매수', down: '매도', flat: '중립' } as const;
const compacts = [3, 4, 5].map((d) => new Intl.NumberFormat('ko-KR', { notation: 'compact', minimumSignificantDigits: d, maximumSignificantDigits: d }));
/** 큰 수를 '1.23억' 꼴로 — 두 값이 같아 보이면 자릿수를 늘린다 (OBV 와 그 평균) */
function fmtCompactPair(x: number | null, y: number | null): [string, string] {
  if (x == null || y == null) return [x == null ? '–' : compacts[0].format(x), y == null ? '–' : compacts[0].format(y)];
  for (const c of compacts) { const a = c.format(x), b = c.format(y); if (a !== b || c === compacts[2]) return [a, b]; }
  return ['–', '–'];
}
const fix = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d).replace('-', MINUS));
/** 부호 값 '+0.2%' · '−2.0%' (괴리율 — ▲ 없이 방향색) */
const sgn = (x: number, d = 1) => { const r = Math.round(x * 10 ** d) / 10 ** d; return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(d)}%`; };
/** 큰 값은 단위를 붙여 짧게 — '−28.5만' · '+1.2억' (MACD 처럼 양·음이 오가는 값) */
function fmtBig(x: number | null | undefined, d: number, signed = false) {
  if (x == null || !Number.isFinite(x)) return '–';
  const a = Math.abs(x), s = x > 0 ? (signed ? '+' : '') : x < 0 ? MINUS : '';
  if (a >= 1e8) return `${s}${fmt(a / 1e8, 1)}억`;
  if (a >= 1e4) return `${s}${fmt(a / 1e4, 1)}만`;
  return `${s}${fmt(a, d)}`;
}
/** '제목 — 설명' → [제목, 설명] */
const splitReason = (s: string): [string, string] => { const i = s.indexOf(' — '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 3)]; };
const LIMIT = 4;
/** 기간은 정해진 수로 — 데이터 길이(199일)를 그대로 쓰지 않는다 */
const FIXED = [20, 30, 60, 90, 120, 200, 250];
const niceSpan = (n: number) => FIXED.reduce((b, x) => (Math.abs(x - n) < Math.abs(b - n) ? x : b), FIXED[0]);

/** 신호 태그 — 무채색 바탕 + 방향색 글머리 (바탕을 칠하지 않는다) */
export function SignalTag({ k, size = 'md' }: { k: string; size?: 'sm' | 'md' }) {
  const s = SIGNALS[k];
  if (!s) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md bg-secondary font-semibold whitespace-nowrap text-foreground', size === 'sm' ? 'h-[22px] px-1.5 text-[12px]' : 'h-6 px-2 text-[12.5px]')}>
      <span aria-hidden className={cn('text-[8px]', TONE_TEXT[s[1]])}>{ICON[s[1]]}</span>{s[0]}
    </span>
  );
}

// ── 종합 의견: 5칸 게이지 ──
/** 칸 경계 −1 · −0.5 · −0.15 · 0.15 · 0.5 · 1 (적극 매도 · 매도 · 중립 · 매수 · 적극 매수) */
const ZONES = [
  { name: '적극 매도', grow: 25, off: 'bg-down/22', on: 'bg-down' },
  { name: '매도', grow: 17.5, off: 'bg-down/22', on: 'bg-[color-mix(in_srgb,var(--down)_60%,var(--card))]' },
  { name: '중립', grow: 15, off: 'bg-border', on: 'bg-faint' },
  { name: '매수', grow: 17.5, off: 'bg-up/22', on: 'bg-[color-mix(in_srgb,var(--up)_60%,var(--card))]' },
  { name: '적극 매수', grow: 25, off: 'bg-up/22', on: 'bg-up' },
] as const;
const zoneOf = (score: number) => (score >= 0.5 ? 4 : score >= 0.15 ? 3 : score <= -0.5 ? 0 : score <= -0.15 ? 1 : 2);

export function OpinionGauge({ score, label }: { score: number; label: string }) {
  const z = zoneOf(score);
  const pos = ((Math.max(-1, Math.min(1, score)) + 1) / 2) * 100;
  return (
    <div>
      <div className={cn('text-[24px] leading-[32px] font-bold tracking-[-0.03em] sm:text-[28px] sm:leading-9', opTone(label) === 'flat' ? 'text-foreground' : TONE_TEXT[opTone(label)])}>{label}</div>
      <p className="mt-0.5 text-[14px] text-muted-foreground tabular">점수 <b className="font-semibold text-secondary-foreground">{fix(score, 2)}</b> · {MINUS}1 적극 매도 ~ +1 적극 매수</p>
      <div className="relative mt-5" role="img" aria-label={`의견 점수 ${score.toFixed(2)} — ${label}`}>
        <div className="flex h-2.5 gap-[3px]">
          {ZONES.map((x, i) => (
            <i key={x.name} className={cn('block first:rounded-l-full first:rounded-r-[3px] last:rounded-l-[3px] last:rounded-r-full [&:not(:first-child):not(:last-child)]:rounded-[3px]', i === z ? x.on : x.off)} style={{ flexGrow: x.grow, flexBasis: 0 }} />
          ))}
        </div>
        <span className="absolute -top-[5px] -ml-2.5 size-5 rounded-full bg-card shadow-[0_0_0_1px_var(--border),0_2px_6px_rgba(0,0,0,.16)] transition-[left] duration-500 motion-reduce:transition-none" style={{ left: `${pos}%` }}>
          <span className="absolute inset-1.5 rounded-full bg-foreground" />
        </span>
      </div>
      <div className="mt-2.5 flex gap-[3px] text-[12px] font-medium text-muted-foreground" aria-hidden>
        {ZONES.map((x, i) => (
          <span key={x.name} className={cn('min-w-0 text-center whitespace-nowrap first:text-left last:text-right', i === z && 'font-bold text-foreground')} style={{ flexGrow: x.grow, flexBasis: 0 }}>{x.name}</span>
        ))}
      </div>
    </div>
  );
}

/** 매도 · 중립 · 매수 개수 — ▼3 ●2 ▲7 */
function TallyText({ g, className }: { g: Tally; className?: string }) {
  return (
    <span className={cn('inline-flex gap-2 text-[12px] font-semibold tabular whitespace-nowrap', className)}>
      <span className={TONE_TEXT.down}>▼ 매도 {g.sell}</span>
      <span className="text-muted-foreground">● 중립 {g.neutral}</span>
      <span className={TONE_TEXT.up}>▲ 매수 {g.buy}</span>
    </span>
  );
}
const lean = (g: Tally) => Math.sign(g.buy - g.sell);

const HEAD = {
  up: ['긍정 근거', '오를 수 있는 이유', '지금은 눈에 띄는 긍정적 신호가 없어요'],
  down: ['부정 근거', '내릴 수 있는 이유', '지금은 눈에 띄는 부정적 신호가 없어요'],
  flat: ['객관 지표', '방향과 상관없는 사실', '따로 짚을 사실이 없어요'],
} as const;
const HEAD_ICON = { up: 'bg-up-soft text-up-text', down: 'bg-down-soft text-down-text', flat: 'bg-secondary text-muted-foreground' } as const;

/** 판단 근거 한 묶음 — 처음 LIMIT 줄 + 더 보기 */
function ReasonGroup({ tone, items }: { tone: Tone; items: string[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open ? items : items.slice(0, LIMIT);
  const more = items.length - LIMIT;
  const [title, sub, empty] = HEAD[tone];
  return (
    <section className="py-4 first:pt-0 last:pb-0" aria-label={title}>
      <h3 className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span aria-hidden className={cn('inline-flex size-[22px] items-center justify-center rounded-full text-[9px]', HEAD_ICON[tone])}>{ICON[tone]}</span>
        <span className="text-[15px] font-bold">{title}</span>
        <span className="text-[13px] font-bold text-muted-foreground tabular">{items.length}</span>
        <span className="text-[13px] text-muted-foreground">{sub}</span>
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 pl-[30px] text-[14px] text-muted-foreground break-keep">{empty}</p>
      ) : (
        <ul id={id} className="mt-2 space-y-1.5 pl-[30px]">
          {shown.map((s, i) => {
            const [t, desc] = splitReason(s);
            return (
              <li key={i} className="relative text-[14.5px] leading-[21px] break-keep wrap-break-word text-secondary-foreground">
                <span aria-hidden className="absolute top-[9px] -left-3.5 size-1 rounded-full bg-faint" />
                {t}{desc ? <> — {desc}</> : null}
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && (
        <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id}
          className="press mt-2 ml-[22px] inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-muted-foreground hover:bg-hover hover:text-foreground">
          {open ? '접기' : `${more}개 더 보기`}<ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </button>
      )}
    </section>
  );
}

export function AnalysisPanel({ a }: { a: Analysis | null; market: Market; iv: Interval }) {
  if (!a) return <p className="py-8 text-center text-[14px] text-muted-foreground">분석하려면 30봉 이상의 데이터가 필요해요.</p>;
  const op = a.opinion;
  // 종합 의견 아래 '묶음끼리 엇갈림' 문장 — analyze() 의 '의견 —' 줄을 쓴다
  const tl = lean(a.groups.trend), ol = lean(a.groups.osc);
  const conflict = tl !== 0 && ol !== 0 && tl !== ol;
  const opinionLine = splitReason(a.reasons.neutral.find((s) => splitReason(s)[0] === '의견') ?? '')[1];
  const neutral = a.reasons.neutral.filter((s) => splitReason(s)[0] !== '의견');

  return (
    <div className="@container">
      <div className="grid gap-6 @[640px]:grid-cols-[264px_minmax(0,1fr)] @[640px]:gap-8">
        {/* 종합 의견 */}
        <div className="min-w-0">
          <OpinionGauge score={op.score} label={op.label} />
          <div className="mt-5 grid grid-cols-3 gap-2 text-center">
            {([['매도', op.sell, 'down'], ['중립', op.neutral, 'flat'], ['매수', op.buy, 'up']] as const).map(([k, v, t]) => (
              <div key={k} className="flex flex-col items-center rounded-[14px] bg-[var(--tile,var(--hover))] pt-2.5 pb-2 max-sm:flex-row max-sm:justify-center max-sm:gap-1.5 max-sm:py-2.5">
                <b className={cn('text-[22px] leading-7 font-bold tabular max-sm:text-[18px] max-sm:leading-6', t === 'flat' ? 'text-foreground' : TONE_TEXT[t])}>{v}</b>
                <span className="text-[13px] text-muted-foreground">{k}</span>
              </div>
            ))}
          </div>
          {opinionLine ? (
            <p className={cn('mt-3 text-[13.5px] leading-[1.5] break-keep', conflict ? 'rounded-xl bg-[var(--tile,var(--hover))] px-3 py-2.5 font-semibold text-foreground' : 'text-secondary-foreground')}>{opinionLine}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-muted-foreground">추세 지표 <TallyText g={a.groups.trend} className="ml-1" /></span>
            <span className="text-[12.5px] text-muted-foreground">과열·침체 <TallyText g={a.groups.osc} className="ml-1" /></span>
          </div>
          {a.signals.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{a.signals.map((k) => <SignalTag key={k} k={k} />)}</div>}
        </div>

        {/* 판단 근거 — 긍정 · 부정 · 객관 */}
        <div className="min-w-0 divide-y divide-border">
          <ReasonGroup tone="up" items={a.reasons.pos} />
          <ReasonGroup tone="down" items={a.reasons.neg} />
          <ReasonGroup tone="flat" items={neutral} />
        </div>
      </div>
      <p className="mt-6 text-[12.5px] leading-relaxed text-muted-foreground break-keep">기술적 신호는 지난 가격으로 계산한 참고 자료예요. 투자 권유가 아니에요.</p>
    </div>
  );
}

// ── 주요 지표 (별도 카드) ──
interface KV { key: string; name: ReactNode; value: ReactNode; sub?: ReactNode }

function VotePill({ v }: { v: number }) {
  const t = voteTone(v);
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-card px-1.5 text-[12px] leading-5 font-semibold whitespace-nowrap text-foreground">
      <span aria-hidden className={cn('text-[8px]', TONE_TEXT[t])}>{ICON[t]}</span>{VOTE_WORD[t]}
    </span>
  );
}
interface StatDef { key?: string; name: string; value: ReactNode; sub?: ReactNode; state?: ReactNode }
function Stat({ d, vote }: { d: StatDef; vote?: Vote }) {
  const state = d.state === undefined ? vote?.state : d.state;
  return (
    <div className="flex min-w-0 flex-col rounded-[14px] bg-[var(--tile,var(--hover))] px-3.5 py-3">
      <div className="flex items-start justify-between gap-1.5">
        <span className="min-w-0 text-[12.5px] leading-[20px] text-muted-foreground">{d.name}</span>
        {vote ? <VotePill v={vote.v} /> : null}
      </div>
      <div className="mt-0.5 text-[15px] leading-snug font-bold tabular wrap-break-word">{d.value}</div>
      {d.sub ? <div className="text-[12px] leading-snug tabular text-muted-foreground wrap-break-word">{d.sub}</div> : null}
      {state ? <div className="mt-auto pt-1.5 text-[12.5px] leading-snug font-medium text-secondary-foreground break-keep">{state}</div> : null}
    </div>
  );
}
function StatGroup({ title, note, g, children }: { title: string; note: string; g?: Tally; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="text-[14px] font-bold">{title} <span className="text-[12.5px] font-normal text-muted-foreground break-keep">{note}</span></div>
        {g ? <TallyText g={g} /> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 @[520px]:grid-cols-3 @[720px]:grid-cols-4">{children}</div>
    </div>
  );
}

export function KeyStats({ a, market, iv }: { a: Analysis | null; market: Market; iv: Interval }) {
  const [all, setAll] = useState(false);
  const id = useId();
  if (!a) return <p className="py-6 text-center text-[14px] text-muted-foreground">지표를 계산하려면 30봉 이상의 데이터가 필요해요.</p>;
  const unit = IV_UNIT[iv] || '봉';
  const f = (x: number | null | undefined) => fmtPrice(x, market);
  const ft = (x: number | null | undefined) => (x == null ? '–' : fmtPrice(roundTick(x, market), market)); // 계산값은 호가 단위로
  const V: Record<string, Vote> = Object.fromEntries(a.votes.map((x) => [x.key, x]));
  const macdDg = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(Math.max(Math.abs(a.macd || 0), Math.abs(a.macdSignal || 0), 1e-9)))));
  const gapTo = (x: number | null | undefined) => {
    if (x == null || !x) return null;
    const d = (a.price / x - 1) * 100;
    const t = Math.round(d * 10) === 0 ? 'flat' : d > 0 ? 'up' : 'down'; // 보이는 자리(0.1%)에서 0 이면 색을 주지 않는다
    return <span className={TONE_TEXT[t]}>괴리율 {sgn(d)}</span>;
  };
  const span = niceSpan(a.lookback + 1);
  const rsiWord = a.rsi == null ? null : a.rsi >= 70 ? '과매수' : a.rsi <= 30 ? '과매도' : a.rsi >= 50 ? '중립 위쪽' : '중립 아래쪽';
  const hist = a.macdHist;
  const maKey = (n: 5 | 20 | 60 | 120, k: number) => (
    <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-[3px] w-2.5 rounded-full" style={{ background: `var(--chart-${k})` }} />MA{n}</span>
  );
  const main: KV[] = [
    { key: 'ma5', name: maKey(5, 1), value: ft(a.ma[5]), sub: gapTo(a.ma[5]) },
    { key: 'ma20', name: maKey(20, 2), value: ft(a.ma[20]), sub: gapTo(a.ma[20]) },
    { key: 'ma60', name: maKey(60, 3), value: ft(a.ma[60]), sub: gapTo(a.ma[60]) },
    { key: 'ma120', name: maKey(120, 4), value: ft(a.ma[120]), sub: gapTo(a.ma[120]) },
    { key: 'rsi', name: 'RSI (14)', value: fix(a.rsi), sub: rsiWord ? <span className="text-muted-foreground">{rsiWord}</span> : null },
    { key: 'vol', name: '거래량 배수', value: a.volRatio == null ? '–' : `${a.volRatio.toFixed(2)}배`, sub: <span className="text-muted-foreground">20{unit} 평균 대비</span> },
    { key: 'macd', name: 'MACD', value: fmtBig(a.macd, macdDg, true), sub: hist != null ? <span className={TONE_TEXT[hist > 0 ? 'up' : hist < 0 ? 'down' : 'flat']}>히스토그램 {fmtBig(hist, macdDg, true)}</span> : null },
    { key: 'signal', name: '시그널', value: fmtBig(a.macdSignal, macdDg, true), sub: <span className="text-muted-foreground">MACD 9{unit} 평균</span> },
    { key: 'bbUp', name: '볼린저 상단', value: ft(a.bb.up), sub: gapTo(a.bb.up) },
    { key: 'bbLo', name: '볼린저 하단', value: ft(a.bb.lo), sub: gapTo(a.bb.lo) },
    { key: 'hi', name: `${span}${unit} 최고`, value: f(a.high), sub: gapTo(a.high) },
    { key: 'lo', name: `${span}${unit} 최저`, value: f(a.low), sub: gapTo(a.low) },
  ];

  // 지표 전체 (표를 던지는 지표 · 참고 지표) — 펼쳐서 본다
  const [obvTxt, obvMaTxt] = fmtCompactPair(a.obv, a.obvMa);
  const cloudLo = a.ichiA != null && a.ichiB != null ? Math.min(a.ichiA, a.ichiB) : null;
  const cloudHi = a.ichiA != null && a.ichiB != null ? Math.max(a.ichiA, a.ichiB) : null;
  const bbWord = a.bbPos == null ? '–' : a.bbPos > 1 ? '상단 위' : a.bbPos < 0 ? '하단 아래' : `밴드 안 ${Math.round(a.bbPos * 100)}%`;
  const gapWord = (x: number) => `${Math.abs((x / a.price - 1) * 100).toFixed(1)}%`;
  const trend: StatDef[] = [
    ...[5, 10, 20, 60, 120].map((n) => ({ key: `ma${n}`, name: `${n}${unit} 이동평균`, value: ft(a.ma[n]), sub: gapTo(a.ma[n]), state: null })),
    { key: 'macd', name: 'MACD (12·26·9)', value: fmtBig(a.macd, macdDg, true), sub: `시그널 ${fmtBig(a.macdSignal, macdDg, true)}` },
    { key: 'adx', name: 'ADX (14)', value: fix(a.adx), sub: `+DI ${fix(a.pdi)} · ${MINUS}DI ${fix(a.mdi)}` },
    { key: 'cloud', name: '일목 구름', value: V.cloud?.state ?? '–', sub: cloudLo != null ? `${ft(cloudLo)} ~ ${ft(cloudHi)}` : null, state: null },
    { key: 'tk', name: '일목 전환선', value: ft(a.ichiConv), sub: `기준선 ${ft(a.ichiBase)}` },
    { key: 'sar', name: '파라볼릭 SAR', value: ft(a.sar), sub: a.sar != null ? `현재가보다 ${gapWord(a.sar)} ${a.sar < a.price ? '아래' : '위'}` : null },
    { key: 'roc', name: `ROC (12${unit})`, value: a.roc == null ? '–' : sgn(a.roc, 2) },
    { key: 'obv', name: 'OBV', value: obvTxt, sub: `20${unit} 평균 ${obvMaTxt}` },
  ];
  const osc: StatDef[] = [
    { key: 'rsi', name: 'RSI (14)', value: fix(a.rsi) },
    { key: 'stoch', name: '스토캐스틱 (14·3·3)', value: `%K ${fix(a.stochK)}`, sub: `%D ${fix(a.stochD)}` },
    { key: 'willr', name: '윌리엄스 %R (14)', value: fix(a.willr) },
    { key: 'cci', name: 'CCI (20)', value: fix(a.cci) },
    { key: 'mfi', name: 'MFI (14)', value: fix(a.mfi) },
    { key: 'bb', name: '볼린저밴드 (20·2)', value: bbWord, sub: a.bbWidth != null ? `밴드 폭 ${a.bbWidth.toFixed(1)}%${a.squeeze ? ' · 수축 중' : ''}` : null },
    { key: 'disparity', name: `이격도 (20${unit})`, value: fix(a.disparity) },
  ];
  const vr = a.volRatio;
  const ref: StatDef[] = [
    { name: 'ATR (14)', value: ft(a.atr), sub: a.atrPct != null ? `가격의 ${a.atrPct.toFixed(a.atrPct < 1 ? 2 : 1)}%` : null, state: a.atrLevel ? `변동성 ${a.atrLevel}` : null },
    { name: '거래량', value: vr == null ? '–' : `${vr.toFixed(2)}배`, sub: `20${unit} 평균 대비`,
      state: vr == null ? null : vr >= 3 ? '평소보다 크게 늘었어요' : vr >= 1.5 ? '많은 편' : vr <= 0.5 ? '적은 편' : '평소 수준' },
  ];
  const tiles = (list: StatDef[]) => list.filter((d) => !d.key || V[d.key]).map((d) => <Stat key={d.key ?? d.name} d={d} vote={d.key ? V[d.key] : undefined} />);

  return (
    <div className="@container">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 @[330px]:grid-cols-3 @[500px]:grid-cols-4 @[700px]:grid-cols-6">
        {main.map((x) => (
          <div key={x.key} className="min-w-0">
            <dt className="truncate text-[13px] text-muted-foreground">{x.name}</dt>
            <dd className="mt-0.5 truncate text-[16px] leading-[22px] font-semibold tabular">{x.value}</dd>
            {x.sub ? <dd className="mt-0.5 truncate text-[12px] font-semibold tabular">{x.sub}</dd> : null}
          </div>
        ))}
      </dl>
      <button onClick={() => setAll(!all)} aria-expanded={all} aria-controls={id}
        className="press mt-5 flex h-11 w-full items-center justify-center gap-1 rounded-xl bg-[var(--tile,var(--hover))] text-[14px] font-semibold text-secondary-foreground hover:text-foreground">
        {all ? '지표 전체 접기' : `지표 ${a.votes.length + 2}개 모두 보기`}
        <ChevronDown aria-hidden className={cn('size-4 transition-transform', all && 'rotate-180')} />
      </button>
      {all ? (
        <div id={id} className="mt-5 space-y-5">
          <p className="text-[13px] text-muted-foreground break-keep">각 지표가 던진 표가 위 종합 의견이 돼요 ({a.votes.length}표)</p>
          <StatGroup title="추세 지표" note="흐름이 어느 쪽인지" g={a.groups.trend}>{tiles(trend)}</StatGroup>
          <StatGroup title="과열·침체 지표" note="많이 올랐는지 · 내렸는지" g={a.groups.osc}>{tiles(osc)}</StatGroup>
          <StatGroup title="변동성 · 거래량" note="표는 던지지 않아요">{tiles(ref)}</StatGroup>
        </div>
      ) : null}
    </div>
  );
}
