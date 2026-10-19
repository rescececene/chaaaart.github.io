// 기술적 분석 — 종합 의견 · 판단 근거(긍정 · 부정 · 객관) · 지금 위치 · 주요 지표
// 분석은 차트에 보이는 주기(1분~월봉)로 계산된다 — 문장의 봉 단위는 IV_UNIT (일 · 주 · 개월, 분·시간봉은 '봉')
import { useState, type ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SIGNALS, type Analysis, type Tally, type Vote } from '@/lib/indicators';
import { fmt, fmtPct, fmtPrice } from '@/lib/format';
import { IV_LABEL, IV_UNIT, type Interval, type Market } from '@/lib/market';

type Tone = 'up' | 'down' | 'flat';
const TONE_TEXT = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;
const TONE_BG = { up: 'bg-up-soft text-up-text', down: 'bg-down-soft text-down-text', flat: 'bg-secondary text-secondary-foreground' } as const;
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
const fix = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
/** '제목 — 설명' → [제목, 설명] */
const splitReason = (s: string): [string, string] => { const i = s.indexOf(' — '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 3)]; };
/** 객관적 관점 중 위쪽 칸(종합 의견 · 지금 위치)에서 이미 보여 주는 줄 */
const SHOWN_ELSEWHERE = new Set(['의견', '위치', '지지·저항', '변동성', '밴드 수축']);
const LIMIT = 4;

export function SignalTag({ k, size = 'md' }: { k: string; size?: 'sm' | 'md' }) {
  const s = SIGNALS[k];
  if (!s) return null;
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-md font-semibold whitespace-nowrap', size === 'sm' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-[12px]', TONE_BG[s[1]])}>
      {ICON[s[1]]} {s[0]}
    </span>
  );
}

export function OpinionGauge({ score, label }: { score: number; label: string }) {
  const pos = ((score + 1) / 2) * 100;
  return (
    <div>
      <div className={cn('text-[26px] font-bold tracking-tight', TONE_TEXT[opTone(label)])}>{label}</div>
      <div className="relative mt-3 h-2 rounded-full" style={{ background: 'linear-gradient(90deg, var(--down) 0%, color-mix(in srgb, var(--down) 30%, var(--secondary)) 30%, var(--secondary) 50%, color-mix(in srgb, var(--up) 30%, var(--secondary)) 70%, var(--up) 100%)' }} role="img" aria-label={`의견 점수 ${score}`}>
        <span className="absolute -top-1.5 h-5 w-1.5 -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--card)] transition-[left] duration-500" style={{ left: `${pos}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11.5px] text-subtle"><span>적극 매도</span><span>중립</span><span>적극 매수</span></div>
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

/** 지표 묶음 하나의 표 막대 (왼쪽 매도 · 가운데 중립 · 오른쪽 매수 — 게이지와 같은 방향) */
function GroupRow({ name, g }: { name: string; g: Tally }) {
  const n = g.buy + g.sell + g.neutral;
  if (!n) return null;
  const t = voteTone(lean(g));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">{name} <span className="font-normal text-muted-foreground tabular">{n}개</span></span>
        <span className={cn('text-[13px] font-bold', TONE_TEXT[t])}>{t === 'flat' ? '중립' : `${VOTE_WORD[t]} 쪽`}</span>
      </div>
      <div className="mt-1.5 flex h-2 gap-px overflow-hidden rounded-full bg-secondary" role="img" aria-label={`${name} 매도 ${g.sell} · 중립 ${g.neutral} · 매수 ${g.buy}`}>
        {g.sell ? <span className="bg-down" style={{ width: `${(g.sell / n) * 100}%` }} /> : null}
        {g.neutral ? <span className="bg-faint/70" style={{ width: `${(g.neutral / n) * 100}%` }} /> : null}
        {g.buy ? <span className="bg-up" style={{ width: `${(g.buy / n) * 100}%` }} /> : null}
      </div>
      <TallyText g={g} className="mt-1.5" />
    </div>
  );
}

function VotePill({ v }: { v: number }) {
  const t = voteTone(v);
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-px text-[11px] font-semibold whitespace-nowrap', TONE_BG[t])}>
      <span aria-hidden className="text-[9px]">{ICON[t]}</span>{VOTE_WORD[t]}
    </span>
  );
}

const HEAD = { up: '긍정적 이유', down: '부정적 이유', flat: '객관적 관점' } as const;
const EMPTY = { up: '지금은 눈에 띄는 긍정적 신호가 없어요.', down: '지금은 눈에 띄는 부정적 신호가 없어요.', flat: '' } as const;

/** 판단 근거 한 묶음 — 처음 LIMIT 줄 + 더 보기 */
function ReasonGroup({ tone, items, wide }: { tone: Tone; items: string[]; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, LIMIT);
  const more = items.length - LIMIT;
  return (
    <section className="rounded-2xl bg-secondary/60 p-4">
      <h4 className={cn('flex items-center gap-1.5 text-[15px] font-bold', tone === 'flat' ? 'text-foreground' : TONE_TEXT[tone])}>
        <span aria-hidden className={cn('text-[11px]', TONE_TEXT[tone])}>{ICON[tone]}</span>
        {HEAD[tone]}
        <span className="text-[13px] font-semibold text-subtle tabular">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground break-keep">{EMPTY[tone]}</p>
      ) : (
        <ul className={cn('mt-3 space-y-3', wide && 'md:grid md:grid-cols-2 md:gap-x-6 md:gap-y-3 md:space-y-0')}>
          {shown.map((s, i) => {
            const [title, desc] = splitReason(s);
            return (
              <li key={i} className="flex gap-2">
                <span aria-hidden className={cn('mt-[5px] shrink-0 text-[9px] leading-none', tone === 'flat' ? 'text-faint' : TONE_TEXT[tone])}>{ICON[tone]}</span>
                <div className="min-w-0 break-keep wrap-break-word">
                  <div className="text-[14px] leading-snug font-semibold">{title}</div>
                  {desc ? <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{desc}</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && (
        <button onClick={() => setOpen(!open)} aria-expanded={open}
          className="press mt-3 w-full rounded-xl bg-card py-2 text-[13px] font-semibold text-secondary-foreground hover:text-foreground">
          {open ? '접기' : `더 보기 (${more}개)`}
        </button>
      )}
    </section>
  );
}

/** 0 ~ 1 위치 막대 (점이 현재 위치) */
function Meter({ pos, className, label }: { pos: number; className?: string; label: string }) {
  const x = Math.min(1, Math.max(0, pos)) * 100;
  return (
    <div className={cn('relative mt-2.5 h-1.5 rounded-full bg-foreground/10', className)} role="img" aria-label={label}>
      <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/20" style={{ width: `${x}%` }} />
      <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--card)]" style={{ left: `${x}%` }} />
    </div>
  );
}

function Tile({ label, className, children }: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0 rounded-2xl bg-secondary/60 px-3.5 py-3', className)}>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

const SoftChip = ({ children, strong }: { children: ReactNode; strong?: boolean }) => (
  <span className={cn('rounded-md px-1.5 py-px text-[11px] font-semibold whitespace-nowrap', strong ? 'bg-foreground text-background' : 'bg-foreground/10 text-secondary-foreground')}>{children}</span>
);

interface StatDef { key?: string; name: string; value: ReactNode; sub?: ReactNode; state?: ReactNode }

/** 주요 지표 칸 — 이름 · 매수/중립/매도 · 값 · 보조 값 · 쉬운 말 상태 */
function Stat({ d, vote }: { d: StatDef; vote?: Vote }) {
  const state = d.state === undefined ? vote?.state : d.state;
  return (
    <div className="flex min-w-0 flex-col rounded-2xl bg-secondary/60 px-3.5 py-3">
      <div className="flex items-start justify-between gap-1.5">
        <span className="min-w-0 text-[12px] leading-[18px] text-muted-foreground">{d.name}</span>
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
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-0.5">
        <div className="text-[13.5px] font-bold">{title} <span className="text-[12px] font-normal text-muted-foreground break-keep">{note}</span></div>
        {g ? <TallyText g={g} /> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </div>
  );
}

const SectionTitle = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <div className="mb-3">
    <h3 className="text-[16px] font-bold tracking-tight">{children}</h3>
    {sub ? <p className="mt-0.5 text-[12.5px] text-muted-foreground break-keep">{sub}</p> : null}
  </div>
);

export function AnalysisPanel({ a, market, iv }: { a: Analysis | null; market: Market; iv: Interval }) {
  if (!a) return <p className="py-8 text-center text-[14px] text-muted-foreground">분석하려면 30봉 이상의 데이터가 필요해요.</p>;
  const unit = IV_UNIT[iv] || '봉';
  const per = ({ 일: '하루', 주: '한 주', 개월: '한 달' } as Record<string, string>)[unit] ?? '한 봉';
  const f = (x: number | null | undefined) => fmtPrice(x, market);
  const op = a.opinion;
  const V: Record<string, Vote> = Object.fromEntries(a.votes.map((x) => [x.key, x]));
  const macdDg = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(Math.max(Math.abs(a.macd || 0), Math.abs(a.macdSignal || 0), 1e-9)))));
  const gap = (x: number) => Math.abs((x / a.price - 1) * 100).toFixed(1);

  // 종합 의견 아래 '묶음끼리 엇갈림' 문장 — analyze() 의 '의견 —' 줄을 쓴다
  const tl = lean(a.groups.trend), ol = lean(a.groups.osc);
  const conflict = tl !== 0 && ol !== 0 && tl !== ol;
  const opinionLine = splitReason(a.reasons.neutral.find((s) => splitReason(s)[0] === '의견') ?? '')[1];
  const neutral = a.reasons.neutral.filter((s) => !SHOWN_ELSEWHERE.has(splitReason(s)[0]));

  // ── 주요 지표 ──
  const maSub = (n: number) => {
    const v = a.ma[n];
    if (v == null) return null;
    const d = Math.round((a.price / v - 1) * 1000) / 10; // 보이는 자리(0.1%)에서 0 이면 색을 주지 않는다
    return <span className={TONE_TEXT[d > 0 ? 'up' : d < 0 ? 'down' : 'flat']}>현재가 {fmtPct(d, 1)}</span>;
  };
  const [obvTxt, obvMaTxt] = fmtCompactPair(a.obv, a.obvMa);
  const cloudLo = a.ichiA != null && a.ichiB != null ? Math.min(a.ichiA, a.ichiB) : null;
  const cloudHi = a.ichiA != null && a.ichiB != null ? Math.max(a.ichiA, a.ichiB) : null;
  const bbWord = a.bbPos == null ? '–' : a.bbPos > 1 ? '상단 위' : a.bbPos < 0 ? '하단 아래' : `밴드 안 ${Math.round(a.bbPos * 100)}%`;
  const trend: StatDef[] = [
    ...[5, 10, 20, 60, 120].map((n) => ({ key: `ma${n}`, name: `${n}${unit} 이동평균`, value: f(a.ma[n]), sub: maSub(n), state: null })),
    { key: 'macd', name: 'MACD (12·26·9)', value: fmt(a.macd, macdDg), sub: `시그널 ${fmt(a.macdSignal, macdDg)}` },
    { key: 'adx', name: 'ADX (14)', value: fix(a.adx), sub: `+DI ${fix(a.pdi)} · -DI ${fix(a.mdi)}` },
    { key: 'cloud', name: '일목 구름', value: V.cloud?.state ?? '–', sub: cloudLo != null ? `${f(cloudLo)} ~ ${f(cloudHi)}` : null, state: null },
    { key: 'tk', name: '일목 전환선', value: f(a.ichiConv), sub: `기준선 ${f(a.ichiBase)}` },
    { key: 'sar', name: '파라볼릭 SAR', value: f(a.sar), sub: a.sar != null ? `현재가보다 ${gap(a.sar)}% ${a.sar < a.price ? '아래' : '위'}` : null },
    { key: 'roc', name: `ROC (12${unit})`, value: fmtPct(a.roc, 2) },
    { key: 'obv', name: 'OBV', value: obvTxt, sub: `20${unit} 평균 ${obvMaTxt}` },
  ];
  const osc: StatDef[] = [
    { key: 'rsi', name: 'RSI (14)', value: fix(a.rsi) },
    { key: 'stoch', name: '스토캐스틱 (14·3·3)', value: `%K ${fix(a.stochK)}`, sub: `%D ${fix(a.stochD)}` },
    { key: 'willr', name: '윌리엄스 %R (14)', value: fix(a.willr) },
    { key: 'cci', name: 'CCI (20)', value: fix(a.cci) },
    { key: 'mfi', name: 'MFI (14)', value: fix(a.mfi) },
    { key: 'bb', name: '볼린저밴드 (20·2)', value: bbWord, sub: <>상단 {f(a.bb.up)}<br />하단 {f(a.bb.lo)}</> },
    { key: 'disparity', name: `이격도 (20${unit})`, value: fix(a.disparity) },
  ];
  const vr = a.volRatio;
  const ref: StatDef[] = [
    { name: 'ATR (14)', value: f(a.atr), sub: a.atrPct != null ? `가격의 ${a.atrPct.toFixed(a.atrPct < 1 ? 2 : 1)}%` : null, state: a.atrLevel ? `변동성 ${a.atrLevel}` : null },
    { name: '거래량', value: vr == null ? '–' : `${vr.toFixed(2)}배`, sub: `20${unit} 평균 대비`,
      state: vr == null ? null : vr >= 3 ? '평소보다 크게 늘었어요' : vr >= 1.5 ? '많은 편' : vr <= 0.5 ? '적은 편' : '평소 수준' },
  ];
  const tiles = (list: StatDef[]) => list.filter((d) => !d.key || V[d.key]).map((d) => <Stat key={d.key ?? d.name} d={d} vote={d.key ? V[d.key] : undefined} />);

  const rp = a.rangePos != null ? Math.round(a.rangePos * 100) : null;

  return (
    <div className="space-y-8">
      {/* 1. 종합 의견 */}
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[13px] text-muted-foreground">{IV_LABEL[iv]}봉 기준 · <b className="font-semibold text-secondary-foreground">{a.votes.length}개 지표</b> 종합</div>
          <OpinionGauge score={op.score} label={op.label} />
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {([['매도', op.sell, 'down'], ['중립', op.neutral, 'flat'], ['매수', op.buy, 'up']] as const).map(([k, v, t]) => (
              <div key={k} className="rounded-2xl bg-secondary/60 py-2.5">
                <div className={cn('text-[20px] font-bold tabular', TONE_TEXT[t])}>{v}</div>
                <div className="text-[12px] text-muted-foreground">{ICON[t]} {k}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <GroupRow name="추세 지표" g={a.groups.trend} />
          <GroupRow name="과열·침체 지표" g={a.groups.osc} />
          {opinionLine ? (
            conflict ? (
              <p className="flex items-start gap-2 rounded-xl bg-secondary px-3 py-2.5 text-[13px] leading-snug font-semibold break-keep">
                <ArrowLeftRight className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{opinionLine}</span>
              </p>
            ) : (
              <p className="text-[13px] leading-snug text-secondary-foreground break-keep">{opinionLine}</p>
            )
          ) : null}
          {a.signals.length > 0 && <div className="flex flex-wrap gap-1.5">{a.signals.map((k) => <SignalTag key={k} k={k} />)}</div>}
        </div>
      </div>

      {/* 2. 판단 근거 */}
      <div>
        <SectionTitle sub="지표 신호를 좋은 쪽 · 나쁜 쪽 · 방향과 상관없는 사실로 나눴어요">판단 근거</SectionTitle>
        <div className="grid gap-2.5 md:grid-cols-2">
          <ReasonGroup tone="up" items={a.reasons.pos} />
          <ReasonGroup tone="down" items={a.reasons.neg} />
          {neutral.length > 0 && <div className="md:col-span-2"><ReasonGroup tone="flat" items={neutral} wide /></div>}
        </div>
      </div>

      {/* 3. 지금 위치 */}
      <div>
        <SectionTitle>지금 위치</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {rp != null && (
            <Tile className="col-span-2" label={`최근 ${a.lookback}${unit} 가격 범위`}>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[17px] font-bold tabular">{rp}%</span>
                <span className="text-[13px] text-secondary-foreground">높이 · {rp >= 80 ? '꼭대기 근처' : rp <= 20 ? '바닥 근처' : '중간쯤'}</span>
              </div>
              <Meter pos={a.rangePos!} label={`최근 범위의 ${rp}% 높이`} />
              <div className="mt-1.5 flex justify-between gap-2 text-[11.5px] tabular text-muted-foreground"><span>최저 {f(a.low)}</span><span>최고 {f(a.high)}</span></div>
            </Tile>
          )}
          <Tile label="가까운 지지선">
            <div className="mt-0.5 text-[15px] font-bold tabular">{f(a.support)}</div>
            <div className="text-[12px] text-muted-foreground break-keep">{a.support != null ? <>현재가보다 <b className={cn('font-semibold', TONE_TEXT.down)}>{gap(a.support)}%</b> 아래</> : '아래쪽 최근 저점 없음'}</div>
          </Tile>
          <Tile label="가까운 저항선">
            <div className="mt-0.5 text-[15px] font-bold tabular">{f(a.resistance)}</div>
            <div className="text-[12px] text-muted-foreground break-keep">{a.resistance != null ? <>현재가보다 <b className={cn('font-semibold', TONE_TEXT.up)}>{gap(a.resistance)}%</b> 위</> : '위쪽 최근 고점 없음'}</div>
          </Tile>
          <Tile className="sm:col-span-2" label="변동성 (ATR)">
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-[15px] font-bold tabular">{a.atrPct != null ? `${a.atrPct.toFixed(a.atrPct < 1 ? 2 : 1)}%` : '–'}</span>
              {a.atrLevel ? <SoftChip strong={a.atrLevel === '높은 편'}>{a.atrLevel}</SoftChip> : null}
            </div>
            <div className="text-[12px] text-muted-foreground break-keep">{per} 평균 움직임</div>
          </Tile>
          <Tile className="sm:col-span-2" label="볼린저밴드 (20·2)">
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-[15px] font-bold tabular">{bbWord}</span>
              {a.squeeze ? <SoftChip strong>수축 중</SoftChip> : null}
            </div>
            {a.bbPos != null && <Meter pos={a.bbPos} label={bbWord} className="mt-2" />}
            <div className="mt-1.5 text-[12px] text-muted-foreground break-keep">
              {a.bbWidth != null ? `밴드 폭 ${a.bbWidth.toFixed(1)}%` : ''}{a.squeeze ? ' · 곧 크게 움직일 수 있어요' : ''}
            </div>
          </Tile>
        </div>
      </div>

      {/* 4. 주요 지표 */}
      <div>
        <SectionTitle sub={`각 지표가 던진 표가 위 종합 의견이 돼요 (${a.votes.length}표)`}>주요 지표</SectionTitle>
        <div className="space-y-5">
          <StatGroup title="추세 지표" note="흐름이 어느 쪽인지" g={a.groups.trend}>{tiles(trend)}</StatGroup>
          <StatGroup title="과열·침체 지표" note="많이 올랐는지 · 내렸는지" g={a.groups.osc}>{tiles(osc)}</StatGroup>
          <StatGroup title="변동성 · 거래량" note="표는 던지지 않아요">{tiles(ref)}</StatGroup>
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-subtle break-keep">기술적 신호는 과거 가격으로 계산한 참고 자료예요. 투자 판단과 책임은 본인에게 있어요.</p>
    </div>
  );
}
