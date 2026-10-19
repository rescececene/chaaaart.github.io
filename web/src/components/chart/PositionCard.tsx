// 내 평단 진단 — 이 종목의 평단가(이 기기에만 저장)를 넣으면 일봉 기술적 분석으로 손절 고려선·목표·대응을 짚고,
// GitHub Actions 가 하루 2번 만드는 종목 AI 해설을 함께 보여 준다. 요청마다 AI 를 부르지 않는다 (무료 한도·중계 보호).
// 일봉은 차트 화면과 같은 쿼리 키라 캐시를 같이 쓰고, 평단이 저장된 종목에서만 불러온다.
import { useCallback, useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Eye, HandCoins, OctagonAlert, Pencil, ShieldCheck, Sparkles, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { Skeleton } from '@/components/ui/skeleton';
import { AiCommentary, useStockAi } from '@/components/chart/AiCommentary';
import { useQuote, useRelay, useWant } from '@/hooks/market';
import { analyze } from '@/lib/indicators';
import { createLocalStore } from '@/lib/localStore';
import { arrow, dirShown, fmt, fmtPct, fmtPrice, fmtPriceUnit, fmtQty, round2 } from '@/lib/format';
import {
  aiAgreement, diagnose, farFromPrice, isPosition, parseAmount, pivots, placeLabels, roundSig, type Diagnosis, type LabelPos, type LineTone, type Position, type VerdictTone,
} from '@/lib/position';
import { candles as fetchCandles, MARKETS, split, type Market, type Sym } from '@/lib/market';

/** 종목별 내 평단 { sym: { avg, qty?, at } } — 코인은 거래소마다 통화가 달라(원·USDT) 종목 주소별로 따로 */
export const positionStore = createLocalStore<Record<Sym, Position>>('ml.pos', {});
export function usePosition(sym: Sym): Position | null {
  const all = positionStore.use();
  const p = all && typeof all === 'object' ? all[sym] : undefined;
  return isPosition(p) ? p : null;
}
function savePosition(sym: Sym, p: Position | null) {
  positionStore.set((prev) => {
    const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
    if (p) next[sym] = p;
    else delete next[sym];
    return next;
  });
}

const UNIT_WORD: Record<Market, string> = { upbit: '원', binance: 'USDT', krx: '원', us: '달러' };
const TONE_TEXT: Record<LineTone, string> = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' };
const MARK: Record<LineTone, string> = { up: '▲', down: '▼', flat: '●' };
const VERDICT: Record<VerdictTone, { box: string; text: string; Icon: LucideIcon }> = {
  hold: { box: 'bg-good/10', text: 'text-[color-mix(in_srgb,var(--good)_72%,var(--foreground))]', Icon: ShieldCheck },
  trim: { box: 'bg-primary/10', text: 'text-[color-mix(in_srgb,var(--primary)_80%,var(--foreground))]', Icon: HandCoins },
  watch: { box: 'bg-secondary', text: 'text-secondary-foreground', Icon: Eye },
  caution: { box: 'bg-warn/12', text: 'text-[color-mix(in_srgb,var(--warn)_62%,var(--foreground))]', Icon: TriangleAlert },
  exit: { box: 'bg-destructive/10', text: 'text-[color-mix(in_srgb,var(--destructive)_80%,var(--foreground))]', Icon: OctagonAlert },
};

/** 손익 금액 — '+634,000원' · '-$12.40' · '+1.25 USDT' */
function fmtMoney(x: number, market: Market) {
  const s = x > 0 ? '+' : x < 0 ? '-' : '';
  const v = fmt(Math.abs(x), market === 'upbit' || market === 'krx' ? 0 : 2);
  return market === 'us' ? `${s}$${v}` : `${s}${v}${market === 'binance' ? ' USDT' : '원'}`;
}
/** 입력칸에 다시 채울 때 — 쉼표를 넣고 소수는 그대로 */
const fmtInput = (x: number) => x.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
const pctTxt = (x: number) => fmtPct(x, Math.abs(x) < 1 ? 2 : 1);

export function PositionCard({ sym, className }: { sym: Sym; className?: string }) {
  const [market] = split(sym);
  useWant([sym]);
  const q = useQuote(sym);
  const pos = usePosition(sym);
  // 수정 중 · 지우기 확인은 그 종목에서만 (다른 종목으로 옮기면 저절로 풀린다)
  const [editSym, setEditSym] = useState<Sym | null>(null);
  const [delSym, setDelSym] = useState<Sym | null>(null);
  const editing = editSym === sym, confirmDel = delSym === sym;
  const setEditing = (on: boolean) => setEditSym(on ? sym : null);
  const setConfirmDel = (on: boolean) => setDelSym(on ? sym : null);

  // 일봉 — 차트 화면과 같은 키 (캐시 공유). 주기마다 다시 부르지 않는다 (중계 호출을 늘리지 않게)
  const { ok: relayOk } = useRelay();
  const cq = useQuery({ queryKey: ['candles', sym, '1d', relayOk], queryFn: () => fetchCandles(sym, '1d'), enabled: !!pos, staleTime: 5 * 60e3 });
  const daily = cq.data;
  const enough = !!daily && daily.length >= 30;
  const a = useMemo(() => (daily && daily.length >= 30 ? analyze(daily, undefined, '일') : null), [daily]);
  const piv = useMemo(() => (daily && daily.length >= 30 ? pivots(daily) : null), [daily]);
  const price = q?.price ?? daily?.[daily.length - 1]?.c ?? null;
  // 손익률은 실시간 그대로, 진단은 가격이 바뀌어도 가볍게 (급한 화면 갱신을 먼저)
  const dprice = useDeferredValue(price);
  const f = useCallback((x: number) => fmtPriceUnit(x, market), [market]);
  const d = useMemo(() => (daily && a && piv && pos && dprice != null && dprice > 0
    ? diagnose({ candles: daily, a, piv, avg: pos.avg, price: dprice, qty: pos.qty, f }) : null), [daily, a, piv, pos, dprice, f]);
  const ai = useStockAi(sym);

  const showForm = !pos || editing;
  const actions = pos && !editing ? (
    <div className="flex gap-1.5">
      <button onClick={() => { setEditing(true); setConfirmDel(false); }} className="press inline-flex h-8 items-center gap-1 rounded-lg bg-secondary px-2.5 text-[13px] font-semibold text-secondary-foreground"><Pencil aria-hidden className="size-3.5" />수정</button>
      <button onClick={() => setConfirmDel(true)} aria-expanded={confirmDel} className="press inline-flex h-8 items-center gap-1 rounded-lg bg-secondary px-2.5 text-[13px] font-semibold text-secondary-foreground"><Trash2 aria-hidden className="size-3.5" />지우기</button>
    </div>
  ) : null;
  const sub = pos && !editing
    ? <span className="tabular">평단 {f(pos.avg)}{pos.qty ? ` · ${fmtQty(pos.qty, market)}` : ''}</span>
    : <span className="break-keep">{editing ? '평단가·수량을 고쳐 주세요' : '평단가를 넣으면 기술적 분석과 AI 해설로 손절 고려선·목표를 짚어 드려요'}</span>;

  return (
    <Card className={cn('@container', className)}>
      <CardTitle sub={sub} right={actions}>내 평단 진단</CardTitle>
      {confirmDel && pos ? (
        <div role="alertdialog" aria-label="평단 지우기" className="-mt-1 mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-secondary px-4 py-3">
          <span className="mr-auto text-[14px] font-semibold break-keep">이 종목의 평단을 지울까요?</span>
          <button onClick={() => { savePosition(sym, null); setConfirmDel(false); }} className="press h-9 rounded-xl bg-destructive px-3.5 text-[14px] font-semibold text-white">지우기</button>
          <button onClick={() => setConfirmDel(false)} className="press h-9 rounded-xl bg-background px-3.5 text-[14px] font-semibold dark:bg-popover">취소</button>
        </div>
      ) : null}
      {showForm ? (
        <PositionForm key={sym + (editing ? ':edit' : '')} sym={sym} market={market} price={price} initial={editing ? pos : null}
          onDone={() => setEditing(false)} onCancel={editing ? () => setEditing(false) : undefined} />
      ) : pos ? (
        <div className="space-y-5">
          <div className="grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @3xl:gap-8">
            <div className="min-w-0 space-y-5">
              {d ? <VerdictBox d={d} aiS={ai.hit?.item.s ?? null} /> : (
                <Status loading={cq.isLoading || (enough && price == null)} error={cq.error as Error | null} count={daily && !enough ? daily.length : null} onRetry={() => void cq.refetch()} />
              )}
              <Pnl avg={pos.avg} qty={pos.qty ?? null} price={price} market={market} delayed={!!q && !q.live} f={f} />
              {d ? (
                <>
                  <PriceLadder d={d} market={market} />
                  <KeyNumbers d={d} market={market} f={f} />
                </>
              ) : null}
            </div>
            <div className="min-w-0 space-y-5">
              {d ? <Scenarios d={d} coin={MARKETS[market].coin} /> : null}
              {d ? <Reasons d={d} /> : null}
              <AiCommentary sym={sym} />
            </div>
          </div>
          <p className="text-[12px] leading-relaxed break-keep text-subtle">규칙과 AI로 만든 참고 정보예요. 투자 판단과 책임은 본인에게 있어요.</p>
        </div>
      ) : null}
    </Card>
  );
}

// ── 입력 ──
function PositionForm({ sym, market, price, initial, onDone, onCancel }: {
  sym: Sym; market: Market; price: number | null; initial: Position | null; onDone: () => void; onCancel?: () => void;
}) {
  const id = useId();
  const [avgS, setAvgS] = useState(initial ? fmtInput(initial.avg) : '');
  const [qtyS, setQtyS] = useState(initial?.qty ? fmtInput(initial.qty) : '');
  const [tried, setTried] = useState(false);
  const avgP = parseAmount(avgS), qtyP = parseAmount(qtyS);
  const avgErr = avgP.error ?? (tried && avgP.value == null ? '평단가를 입력해 주세요' : null);
  const far = !avgErr && avgP.value != null && farFromPrice(avgP.value, price);
  const coin = MARKETS[market].coin;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (avgP.value == null || avgP.error || qtyP.error) return;
    savePosition(sym, { avg: avgP.value, ...(qtyP.value ? { qty: qtyP.value } : {}), at: Date.now() });
    onDone();
  };
  const blurFmt = (s: string, set: (v: string) => void) => { const p = parseAmount(s); if (p.value != null) set(fmtInput(p.value)); };
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-2.5 @xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_auto]">
        <div className="min-w-0">
          <div className="mb-1.5 flex h-[22px] items-center"><label htmlFor={id + 'avg'} className="truncate text-[13px] font-semibold text-muted-foreground">평단가 ({UNIT_WORD[market]})</label></div>
          <AmountInput id={id + 'avg'} value={avgS} onChange={setAvgS} onBlur={() => blurFmt(avgS, setAvgS)} invalid={!!avgErr}
            prefix={market === 'us' ? '$' : undefined} suffix={market === 'us' ? undefined : UNIT_WORD[market]}
            placeholder={price != null ? fmtPrice(price, market) : '평단가'} describedBy={avgErr ? id + 'avg-msg' : far ? id + 'far-msg' : undefined} />
          {avgErr ? <p id={id + 'avg-msg'} className="mt-1.5 text-[12.5px] font-medium break-keep text-destructive">{avgErr}</p> : null}
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 flex h-[22px] items-center"><label htmlFor={id + 'qty'} className="truncate text-[13px] font-semibold text-muted-foreground">수량 (선택)</label></div>
          <AmountInput id={id + 'qty'} value={qtyS} onChange={setQtyS} onBlur={() => blurFmt(qtyS, setQtyS)} invalid={!!qtyP.error}
            suffix={coin ? '개' : '주'} placeholder={coin ? '예: 0.15' : '예: 10'} describedBy={qtyP.error ? id + 'qty-msg' : undefined} />
          {qtyP.error ? <p id={id + 'qty-msg'} className="mt-1.5 text-[12.5px] font-medium break-keep text-destructive">{qtyP.error}</p> : null}
        </div>
        {price != null ? (
          <div className="col-span-2 -mt-0.5 @xl:order-last @xl:col-span-3">
            <button type="button" onClick={() => setAvgS(fmtInput(price))} className="press inline-flex h-8 items-center rounded-lg bg-primary/10 px-2.5 text-[13px] font-semibold text-primary tabular">
              현재가 {fmtPriceUnit(price, market)} 넣기
            </button>
          </div>
        ) : null}
        {far ? <p id={id + 'far-msg'} className="col-span-2 text-[12.5px] leading-relaxed break-keep text-[color-mix(in_srgb,var(--warn)_62%,var(--foreground))] @xl:order-last @xl:col-span-3">현재가({fmtPriceUnit(price, market)})와 5배 넘게 차이 나요 — {UNIT_WORD[market]} 기준 가격이 맞는지 확인해 주세요</p> : null}
        <div className="col-span-2 flex gap-2 @xl:col-span-1 @xl:pt-[28px]">
          <button type="submit" className="press h-12 flex-1 rounded-xl bg-primary px-6 text-[15px] font-bold whitespace-nowrap text-primary-foreground">{initial ? '저장하고 진단하기' : '진단하기'}</button>
          {onCancel ? <button type="button" onClick={onCancel} className="press h-12 rounded-xl bg-secondary px-5 text-[15px] font-semibold text-secondary-foreground">취소</button> : null}
        </div>
      </div>
      <p className="text-[12px] break-keep text-subtle">이 기기에만 저장돼요 · 수량을 넣으면 손익 금액도 보여 드려요</p>
    </form>
  );
}

function AmountInput({ id, value, onChange, onBlur, invalid, prefix, suffix, placeholder, describedBy }: {
  id: string; value: string; onChange: (v: string) => void; onBlur: () => void; invalid: boolean;
  prefix?: string; suffix?: string; placeholder: string; describedBy?: string;
}) {
  return (
    <div className={cn('flex h-12 items-center gap-1.5 rounded-xl bg-secondary px-3.5 ring-inset focus-within:ring-2 focus-within:ring-ring', invalid && 'ring-2 ring-destructive focus-within:ring-destructive')}>
      {prefix ? <span className="text-[16px] font-semibold text-muted-foreground">{prefix}</span> : null}
      <input
        id={id} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
        inputMode="decimal" autoComplete="off" spellCheck={false} placeholder={placeholder}
        aria-invalid={invalid || undefined} aria-describedby={describedBy}
        className="h-full min-w-0 flex-1 bg-transparent text-[16px] font-semibold tabular outline-none placeholder:font-normal placeholder:text-faint"
      />
      {suffix ? <span className="shrink-0 text-[14px] font-semibold text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

// ── 진단 화면 조각 ──
function Status({ loading, error, count, onRetry }: { loading: boolean; error: Error | null; count: number | null; onRetry: () => void }) {
  if (loading) {
    return (
      <div className="space-y-2.5" aria-label="진단 준비 중">
        <Skeleton className="h-[104px] w-full rounded-2xl" />
      </div>
    );
  }
  const box = (children: ReactNode) => <div className="rounded-2xl bg-secondary px-4 py-3.5 text-[14px] leading-relaxed break-keep text-secondary-foreground">{children}</div>;
  if (error) {
    return box(<>
      <p className="font-semibold">일봉을 불러오지 못해 손절선·목표는 계산하지 못했어요.</p>
      {/* 우리 쪽 안내 문장(한글)만 그대로 보여 주고, 브라우저·파싱 오류는 쉬운 말로 */}
      <p className="mt-0.5 text-[13px] text-muted-foreground">{/[가-힣]/.test(error.message) ? error.message : '인터넷 연결을 확인하고 다시 시도해 주세요.'}</p>
      <button onClick={onRetry} className="press mt-2.5 h-9 rounded-xl bg-background px-3.5 text-[13.5px] font-semibold dark:bg-popover">다시 시도</button>
    </>);
  }
  if (count != null) {
    return box(<>
      <p className="font-semibold">일봉이 {count}개뿐이라 손절선·목표는 계산하지 못했어요.</p>
      <p className="mt-0.5 text-[13px] text-muted-foreground">기술적 진단에는 30일 이상의 가격이 필요해요. 상장한 지 얼마 안 된 종목은 조금 더 기다려 주세요.</p>
    </>);
  }
  return null;
}

function VerdictBox({ d, aiS }: { d: Diagnosis; aiS: number | null }) {
  const v = VERDICT[d.verdict.tone];
  const agree = aiS != null ? aiAgreement(d.lean, aiS) : null;
  return (
    <div className={cn('rounded-2xl px-4 py-3.5', v.box)}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[13.5px] font-bold', v.text)}><v.Icon aria-hidden className="size-4 shrink-0" />{d.verdict.badge}</span>
        <span className="ml-auto text-[12px] text-muted-foreground">일봉 기준</span>
      </div>
      <p className="mt-1 text-[17px] leading-snug font-bold tracking-tight break-keep">{d.verdict.title}</p>
      <p className="mt-1 text-[13.5px] leading-relaxed break-keep text-secondary-foreground">{d.verdict.detail}</p>
      {agree ? (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-snug font-semibold break-keep">
          <Sparkles aria-hidden className="mt-px size-3.5 shrink-0 text-chart-5" />
          <span className={agree.same ? 'text-foreground' : 'text-[color-mix(in_srgb,var(--chart-5)_75%,var(--foreground))]'}>{agree.text}</span>
        </p>
      ) : null}
    </div>
  );
}

function Pnl({ avg, qty, price, market, delayed, f }: { avg: number; qty: number | null; price: number | null; market: Market; delayed: boolean; f: (x: number) => string }) {
  if (price == null) return <div><div className="text-[13px] text-muted-foreground">내 수익률</div><Skeleton className="mt-1.5 h-9 w-40" /></div>;
  const pnl = (price / avg - 1) * 100;
  const t = dirShown(pnl);
  return (
    <div>
      <div className="text-[13px] text-muted-foreground">내 수익률</div>
      <div className={cn('mt-0.5 text-[32px] leading-tight font-bold tracking-tight tabular', TONE_TEXT[t])}>
        {t !== 'flat' ? <span className="mr-1 align-[0.12em] text-[0.6em]">{arrow(round2(pnl))}</span> : null}{fmtPct(pnl, 2)}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] tabular">
        {qty != null ? <span className={cn('font-semibold', TONE_TEXT[t])}>{fmtMoney((price - avg) * qty, market)}</span> : null}
        <span className="text-muted-foreground">현재가 {f(price)}</span>
        {delayed ? <span className="rounded-md bg-secondary px-1.5 py-px text-[11.5px] font-semibold text-muted-foreground">지연 시세</span> : null}
      </div>
    </div>
  );
}

interface LadderPoint { key: string; name: string; v: number; dot: string; text: string; big?: boolean }
/** 가격 사다리 — 손절선·평단·현재가·목표를 한 줄 위에 실제 가격 비율대로. 라벨은 위·아래 두 줄로 겹치지 않게 */
function PriceLadder({ d, market }: { d: Diagnosis; market: Market }) {
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const [W, setW] = useState(0);
  const [place, setPlace] = useState<LabelPos[] | null>(null);
  const pts: LadderPoint[] = [
    { key: 'stop', name: d.stopBroken ? '손절선(이탈)' : '손절선', v: d.stop, dot: 'var(--down)', text: 'text-down-text' },
    { key: 'avg', name: '평단', v: d.avg, dot: 'var(--subtle)', text: 'text-muted-foreground' },
    { key: 'now', name: '현재', v: d.price, dot: 'var(--foreground)', text: 'text-foreground', big: true },
    ...(d.target != null ? [{ key: 'target', name: '목표', v: d.target, dot: 'var(--up)', text: 'text-up-text' }] : []),
  ];
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const PAD = 8;
  const x = (v: number) => (hi > lo ? PAD + ((v - lo) / (hi - lo)) * Math.max(0, W - 2 * PAD) : W / 2);
  const sig = pts.map((p) => `${p.key}:${p.v}`).join('|');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!W) return;
    const ws = pts.map((_, i) => labels.current[i]?.offsetWidth ?? 64);
    setPlace(placeLabels(pts.map((p) => x(p.v)), ws, W));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, W]);
  const seg = (from: number, to: number, cls: string) => (to > from ? <div className={cn('absolute top-[46px] h-[6px] -translate-y-1/2 rounded-full', cls)} style={{ left: x(from), width: x(to) - x(from) }} /> : null);
  const TOP = 0, LINE = 46, BOTTOM = 58, LABEL_H = 32;
  return (
    <div ref={box} className="relative h-[92px] select-none" role="img" aria-label={`가격 사다리: ${pts.map((p) => `${p.name} ${fmtPriceUnit(p.v, market)}`).join(', ')}`}>
      <div className="absolute inset-x-0 top-[46px] h-[3px] -translate-y-1/2 rounded-full bg-secondary" />
      {W > 0 ? (
        <>
          {!d.stopBroken ? seg(d.stop, d.price, 'bg-down/25') : null}
          {d.target != null ? seg(d.price, d.target, 'bg-up/25') : null}
          {place ? pts.map((p, i) => {
            const pl = place[i];
            const cx = x(p.v);
            // 라벨 줄과 점을 잇는 짧은 선 (라벨이 옆으로 밀려도 어느 점인지 보이게)
            return pl.row === 0
              ? <span key={p.key + 'l'} className="absolute w-px bg-border" style={{ left: cx, top: TOP + LABEL_H, height: LINE - TOP - LABEL_H - 5 }} />
              : <span key={p.key + 'l'} className="absolute w-px bg-border" style={{ left: cx, top: LINE + 5, height: BOTTOM - LINE - 5 }} />;
          }) : null}
          {pts.map((p) => (
            <span key={p.key} className={cn('absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card', p.big ? 'size-3.5' : 'size-3')} style={{ left: x(p.v), top: LINE, background: p.dot }} />
          ))}
        </>
      ) : null}
      {pts.map((p, i) => {
        const pl = place?.[i];
        return (
          <div key={p.key} ref={(el) => { labels.current[i] = el; }} aria-hidden
            className={cn('absolute leading-tight whitespace-nowrap', pl ? 'text-center' : 'invisible')}
            style={{ left: pl ? pl.left : 0, top: pl ? (pl.row === 0 ? TOP : BOTTOM) : 0 }}>
            <div className={cn('text-[11.5px] font-semibold', p.text)}>{p.name}</div>
            <div className={cn('text-[12.5px] tabular', p.big ? 'font-bold' : 'font-semibold')}>{fmtPrice(p.v, market)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl bg-secondary/60 px-3.5 py-3">
      <div className="truncate text-[12px] text-muted-foreground">{k}</div>
      <div className="mt-0.5 truncate text-[15px] font-bold tabular">{v}</div>
      <div className="truncate text-[12px] tabular">{sub}</div>
    </div>
  );
}

function KeyNumbers({ d, market, f }: { d: Diagnosis; market: Market; f: (x: number) => string }) {
  const p = (x: number) => fmtPrice(x, market);
  const fromNow = (x: number) => <span className={TONE_TEXT[x > d.price ? 'up' : 'down']}>현재가 {pctTxt((x / d.price - 1) * 100)}</span>;
  const atrTxt = `${d.atrPct.toFixed(d.atrPct < 1 ? 2 : 1)}%`;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4 @3xl:grid-cols-2">
        <Stat k="손절 고려선" v={p(d.stop)} sub={d.stopBroken ? <span className="font-semibold text-[color-mix(in_srgb,var(--destructive)_80%,var(--foreground))]">이미 이탈</span> : fromNow(d.stop)} />
        <Stat k={d.targetKind === 'high' ? '1차 목표 · 최근 고점' : '1차 목표'} v={d.target != null ? p(d.target) : '–'} sub={d.target != null ? fromNow(d.target) : <span className="text-muted-foreground">위쪽 고점 없음</span>} />
        <Stat k="지지" v={d.support != null ? p(d.support) : '–'} sub={d.support != null ? fromNow(d.support) : <span className="text-muted-foreground">아래쪽 저점 없음</span>} />
        <Stat k="손익비" v={d.rr == null ? '–' : d.rr >= 10 ? '10배 이상' : `${d.rr.toFixed(1)}배`}
          sub={<span className="text-muted-foreground">{d.rr != null ? '목표까지 ÷ 손절선까지' : d.stopBroken ? '손절선 이탈' : '목표 없음'}</span>} />
      </div>
      <ul className="mt-2.5 space-y-1 text-[12.5px] leading-relaxed break-keep text-muted-foreground">
        <li>손절 고려선 근거 — {d.stopBasis}. 하루 평균 움직임(ATR)은 {f(roundSig(d.atr))} ({atrTxt})</li>
        {!d.stopBroken ? <li>손절선에서 정리하면 평단 대비 <span className="tabular">{pctTxt(d.stopFromAvgPct)}{d.stopAmt != null ? ` (${fmtMoney(d.stopAmt, market)})` : ''}</span></li> : null}
      </ul>
    </div>
  );
}

function Scenarios({ d, coin }: { d: Diagnosis; coin: boolean }) {
  return (
    <section aria-label="이렇게 보면 돼요">
      <h3 className="text-[15px] font-bold">이렇게 보면 돼요</h3>
      <ul className="mt-2 space-y-2">
        {d.scenarios.map((s, i) => (
          <li key={i} className="flex gap-2.5 text-[14px] leading-snug">
            <span aria-hidden className={cn('mt-[3px] shrink-0 text-[10px]', TONE_TEXT[s.tone])}>{MARK[s.tone]}</span>
            <span className="break-keep">{s.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-subtle">마감 = 일봉 종가 ({coin ? '코인은 매일 오전 9시' : '장 마감 가격'})</p>
    </section>
  );
}

function ReasonGroup({ title, tone, items }: { title: string; tone: LineTone; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className={cn('mb-1 text-[12.5px] font-bold', TONE_TEXT[tone])}>{MARK[tone]} {title}</div>
      <ul className="space-y-1.5">
        {items.map((x, i) => {
          const k = x.indexOf(' — ');
          return (
            <li key={i} className="text-[13.5px] leading-snug break-keep">
              {k > 0 ? <><span className="font-semibold">{x.slice(0, k)}</span><span className="text-muted-foreground"> — {x.slice(k + 3)}</span></> : x}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Reasons({ d }: { d: Diagnosis }) {
  const n = d.reasons.pos.length + d.reasons.neg.length + d.reasons.mine.length;
  // 휴대폰에선 접어 두고(카드가 너무 길어지지 않게), 넓은 화면에선 펼쳐 둔다
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  const id = useId();
  return (
    <section aria-label="판단 근거">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={id} className="press -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg px-1 py-0.5 text-left">
        <h3 className="text-[15px] font-bold">판단 근거</h3>
        <span className="text-[13px] text-muted-foreground tabular">{n}개</span>
        <ChevronDown aria-hidden className={cn('ml-auto size-4 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div id={id} className="mt-2.5 space-y-3.5">
          <ReasonGroup title="좋은 점" tone="up" items={d.reasons.pos} />
          <ReasonGroup title="걱정되는 점" tone="down" items={d.reasons.neg} />
          <ReasonGroup title="내 평단 기준" tone="flat" items={d.reasons.mine} />
        </div>
      ) : null}
    </section>
  );
}
