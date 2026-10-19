// 내 평단 진단 — 이 종목의 평단가(이 기기에만 암호화해 저장 · 어디로도 보내지 않음)를 넣으면 일봉 기술적 분석으로 손절 고려선·목표·대응을 짚고,
// GitHub Actions 가 하루 2번 만드는 종목 AI 해설을 함께 보여 준다. 요청마다 AI 를 부르지 않는다 (무료 한도·중계 보호).
// 일봉은 차트 화면과 같은 쿼리 키라 캐시를 같이 쓰고, 평단이 저장된 종목에서만 불러온다.
//  - PositionHeadline: 가격 머리 아래 한 줄 — 평단이 없으면 바로 넣는 입력칸, 있으면 요약(평단 · 수익률 · 손절 고려선 · 1차 목표)
//  - PositionCard: 전체 진단 카드 (휴대폰 [내 평단] 탭 · PC 오른쪽 열)
import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, HandCoins, Lock, OctagonAlert, ShieldCheck, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { Skeleton } from '@/components/ui/skeleton';
import { AiCommentary, useStockAi } from '@/components/chart/AiCommentary';
import { useQuote, useRelay, useWant } from '@/hooks/market';
import { analyze } from '@/lib/indicators';
import { createSecureStore } from '@/lib/secureStore';
import { dirShown, fmt, fmtPrice, fmtPriceUnit, fmtQty } from '@/lib/format';
import {
  aiAgreement, diagnose, farFromPrice, isPosition, parseAmount, pivots, placeLabels, roundSig, type Diagnosis, type LabelPos, type LineTone, type Position, type VerdictTone,
} from '@/lib/position';
import { candles as fetchCandles, MARKETS, split, type Market, type Sym } from '@/lib/market';

/** 종목별 내 평단 { sym: { avg, qty?, at } } — 코인은 거래소마다 통화가 달라(원·USDT) 종목 주소별로 따로.
 *  이 기기 안에서도 암호화해 저장한다 (secureStore — 풀기는 비동기라 다 읽기 전엔 입력칸 대신 자리만) */
export const positionStore = createSecureStore<Record<Sym, Position>>('ml.pos', {});
let posLoaded = false;
const posLoading = positionStore.ready().then(() => { posLoaded = true; });
/** 저장된 평단을 다 읽었는가 — 그 전에 '평단 없음' 입력칸이 잠깐 보였다 바뀌지 않게 */
export function usePositionsLoaded() {
  const [ok, setOk] = useState(posLoaded);
  useEffect(() => {
    if (ok) return;
    let alive = true;
    void posLoading.then(() => { if (alive) setOk(true); });
    return () => { alive = false; };
  }, [ok]);
  return ok;
}
const PRIVACY = '이 기기에만 암호화해 저장돼요 · 어디로도 보내지 않아요';
function PrivacyNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-[12.5px] leading-[18px] break-keep text-muted-foreground', className)}>
      <Lock aria-hidden className="mt-px size-3.5 shrink-0" />{PRIVACY}
    </p>
  );
}
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

const MINUS = '−';
const UNIT_WORD: Record<Market, string> = { upbit: '원', binance: 'USDT', krx: '원', us: '달러' };
const TONE_TEXT: Record<LineTone, string> = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' };
const WARN_TEXT = 'text-[color-mix(in_srgb,var(--warn)_58%,var(--foreground))]';
/** 판정 상자 — 빨강·파랑은 가격 방향 전용이라 쓰지 않는다. 손절·주의는 주황 경고색, 아이콘으로도 구분 */
const VERDICT: Record<VerdictTone, { box: string; text: string; Icon: LucideIcon }> = {
  hold: { box: 'bg-good/10', text: 'text-[color-mix(in_srgb,var(--good)_62%,var(--foreground))]', Icon: ShieldCheck },
  trim: { box: 'bg-secondary', text: 'text-foreground', Icon: HandCoins },
  watch: { box: 'bg-secondary', text: 'text-secondary-foreground', Icon: Eye },
  caution: { box: 'bg-warn/12', text: WARN_TEXT, Icon: TriangleAlert },
  exit: { box: 'bg-warn/12', text: WARN_TEXT, Icon: OctagonAlert },
};

/** 손익 금액 — '+634,000원' · '−$12.40' · '+1.25 USDT' */
function fmtMoney(x: number, market: Market) {
  const s = x > 0 ? '+' : x < 0 ? MINUS : '';
  const v = fmt(Math.abs(x), market === 'upbit' || market === 'krx' ? 0 : 2);
  return market === 'us' ? `${s}$${v}` : `${s}${v}${market === 'binance' ? ' USDT' : '원'}`;
}
/** 입력칸에 다시 채울 때 — 쉼표를 넣고 소수는 그대로 */
const fmtInput = (x: number) => x.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
/** 부호 % — '+6.2%' · '−8.2%' */
const sgnPct = (x: number, d = Math.abs(x) < 1 ? 2 : 1) => { const r = Math.round(x * 10 ** d) / 10 ** d; return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(d)}%`; };
/** 등락 % — '▲13.0%' (기호가 부호를 대신) */
function UpDown({ x, d = 1, className }: { x: number; d?: number; className?: string }) {
  const t = dirShown(x);
  return (
    <span className={cn('tabular whitespace-nowrap', TONE_TEXT[t], className)}>
      {t !== 'flat' ? <><span aria-hidden className="mr-px text-[0.72em]">{t === 'up' ? '▲' : '▼'}</span><span className="sr-only">{t === 'up' ? '상승 ' : '하락 '}</span></> : null}
      {Math.abs(x).toFixed(d)}%
    </span>
  );
}

/** 평단 + 일봉 진단 (머리 요약 줄과 진단 카드가 같이 쓴다 — 일봉은 같은 쿼리 캐시) */
export function usePositionDiag(sym: Sym) {
  const [market] = split(sym);
  const q = useQuote(sym);
  const pos = usePosition(sym);
  const { ok: relayOk } = useRelay();
  // 일봉 — 차트 화면과 같은 키 (캐시 공유). 주기마다 다시 부르지 않는다 (중계 호출을 늘리지 않게)
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
  return { market, q, pos, cq, daily, enough, price, d, f };
}

// ── 머리 요약 줄 ──
/** 가격 머리 아래 — 평단이 없으면 바로 넣는 입력칸, 있으면 '내 평단 · 수익률 · 손절 고려선 · 1차 목표 · 진단 보기' */
export function PositionHeadline({ sym, onOpen, onSaved }: { sym: Sym; onOpen: () => void; onSaved?: () => void }) {
  const { market, pos, price, d } = usePositionDiag(sym);
  const loaded = usePositionsLoaded();
  if (!loaded) return <Skeleton className="h-[132px] w-full rounded-[14px] sm:h-[98px]" aria-label="내 평단 불러오는 중" />;
  if (!pos) return <QuickForm key={sym} sym={sym} market={market} price={price} onSaved={onSaved} />;
  const pnl = price != null ? (price / pos.avg - 1) * 100 : null;
  const v = d ? VERDICT[d.verdict.tone] : null;
  const p = (x: number) => fmtPrice(x, market);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[14px] bg-[var(--tile,var(--hover))] px-4 py-3 text-[14px] text-muted-foreground tabular">
      <span className="whitespace-nowrap">내 평단 <b className="ml-1 text-[15px] font-bold text-foreground">{fmtPriceUnit(pos.avg, market)}</b>{pnl != null ? <UpDown x={pnl} className="ml-1.5 text-[14px] font-semibold" /> : null}</span>
      {d && v ? (
        <span className={cn('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-bold whitespace-nowrap', v.box, v.text)}><v.Icon aria-hidden className="size-3.5" />{d.verdict.badge}</span>
      ) : null}
      {d ? (
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="whitespace-nowrap">손절 고려선 <b className="ml-0.5 font-semibold text-foreground">{p(d.stop)}</b></span>
          {d.target != null ? <span className="whitespace-nowrap">1차 목표 <b className="ml-0.5 font-semibold text-foreground">{p(d.target)}</b></span> : null}
        </span>
      ) : null}
      <button onClick={onOpen} className="press -my-1 ml-auto inline-flex h-9 items-center gap-0.5 rounded-lg pr-1 pl-2 text-[14px] font-semibold whitespace-nowrap text-secondary-foreground hover:bg-hover hover:text-foreground">
        진단 보기<ChevronRight aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/** 평단이 없을 때 머리 아래 바로 넣는 칸 — 들어오자마자 보이게 */
function QuickForm({ sym, market, price, onSaved }: { sym: Sym; market: Market; price: number | null; onSaved?: () => void }) {
  const id = useId();
  const [s, setS] = useState('');
  const [tried, setTried] = useState(false);
  const p = parseAmount(s);
  const err = p.error ?? (tried && p.value == null ? '평단가를 입력해 주세요' : null);
  const far = !err && p.value != null && farFromPrice(p.value, price);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (p.value == null || p.error) return;
    savePosition(sym, { avg: p.value, at: Date.now() });
    onSaved?.();
  };
  return (
    <form onSubmit={submit} noValidate className="rounded-[14px] bg-[var(--tile,var(--hover))] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <label htmlFor={id} className="min-w-0 text-[14px] font-semibold break-keep text-secondary-foreground sm:max-w-[260px] lg:max-w-none">
          내 평단가를 넣으면 손절 고려선·목표를 짚어 드려요
        </label>
        <div className="flex min-w-0 flex-1 basis-[260px] gap-2 lg:ml-auto lg:max-w-[480px]">
          <AmountInput id={id} value={s} onChange={setS} onBlur={() => { if (p.value != null) setS(fmtInput(p.value)); }} invalid={!!err} size="sm"
            prefix={market === 'us' ? '$' : undefined} suffix={market === 'us' ? undefined : UNIT_WORD[market]}
            placeholder={price != null ? `예: ${fmtPrice(price, market)}` : '평단가'} describedBy={err || far ? id + '-msg' : undefined} />
          <button type="submit" className="press h-11 shrink-0 rounded-xl bg-primary px-4 text-[15px] font-semibold whitespace-nowrap text-primary-foreground">진단하기</button>
        </div>
      </div>
      {err || far ? (
        <p id={id + '-msg'} className={cn('mt-2 text-[13px] font-medium break-keep', err ? WARN_TEXT : 'text-muted-foreground')}>
          {err ?? `현재가(${fmtPriceUnit(price, market)})와 5배 넘게 차이 나요 — ${UNIT_WORD[market]} 기준 가격이 맞는지 확인해 주세요`}
        </p>
      ) : <PrivacyNote className="mt-2" />}
    </form>
  );
}

// ── 전체 카드 ──
export function PositionCard({ sym, className }: { sym: Sym; className?: string }) {
  useWant([sym]);
  const { market, q, pos, cq, daily, enough, price, d, f } = usePositionDiag(sym);
  const loaded = usePositionsLoaded();
  const ai = useStockAi(sym);
  const [delSym, setDelSym] = useState<Sym | null>(null); // 지우기 확인은 그 종목에서만
  const confirmDel = delSym === sym;

  return (
    <Card className={cn('@container', className)}>
      <CardTitle right={<span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"><Lock aria-hidden className="size-3.5" />암호화 저장</span>}>내 평단 진단</CardTitle>
      {loaded ? (
        <PositionForm key={sym + ':' + (pos ? `${pos.avg}:${pos.qty ?? ''}` : '')} sym={sym} market={market} price={price} initial={pos}
          onDelete={pos ? () => setDelSym(sym) : undefined} />
      ) : <div aria-label="내 평단 불러오는 중"><Skeleton className="h-4 w-20" /><Skeleton className="mt-2.5 h-12 w-full rounded-xl" /><Skeleton className="mt-3 h-6 w-48" /></div>}
      <PrivacyNote className="mt-2.5" />
      {confirmDel && pos ? (
        <div role="alertdialog" aria-label="평단 지우기" className="mt-3 flex flex-wrap items-center gap-2 rounded-[14px] bg-secondary px-4 py-3">
          <span className="mr-auto text-[14px] font-semibold break-keep">이 종목의 평단을 지울까요?</span>
          <button onClick={() => { savePosition(sym, null); setDelSym(null); }} className="press h-10 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground">지우기</button>
          <button onClick={() => setDelSym(null)} className="press h-10 rounded-xl bg-card px-4 text-[14px] font-semibold">취소</button>
        </div>
      ) : null}
      {pos ? (
        <div className="mt-6 space-y-6">
          <PnlLine avg={pos.avg} qty={pos.qty ?? null} price={price} market={market} delayed={!!q && !q.live} />
          {d ? <VerdictBox d={d} aiS={ai.hit?.item.s ?? null} /> : (
            <Status loading={cq.isLoading || (enough && price == null)} error={cq.error as Error | null} count={daily && !enough ? daily.length : null} onRetry={() => void cq.refetch()} />
          )}
          {d ? (
            <>
              <PriceLadder d={d} market={market} />
              <LevelList d={d} market={market} f={f} />
              <Scenarios d={d} coin={MARKETS[market].coin} />
              <Reasons d={d} />
            </>
          ) : null}
          <AiCommentary sym={sym} />
          <p className="text-[12.5px] leading-relaxed break-keep text-muted-foreground">지난 가격으로 계산한 참고 자료예요. 사고팔지는 직접 판단해 주세요.</p>
        </div>
      ) : !loaded ? null : (
        <ul className="mt-5 space-y-2 text-[13.5px] leading-[1.5] break-keep text-muted-foreground">
          <li className="flex gap-2"><span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-faint" />손절 고려선 — 최근 지지와 하루 평균 움직임으로 계산해요</li>
          <li className="flex gap-2"><span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-faint" />1차 목표 — 위쪽에서 한 번 막혔던 가격이에요</li>
          <li className="flex gap-2"><span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-faint" />오를 때 · 옆으로 갈 때 · 내릴 때 어떻게 볼지 실제 가격으로 알려 드려요</li>
        </ul>
      )}
    </Card>
  );
}

// ── 입력 ──
function PositionForm({ sym, market, price, initial, onDelete }: {
  sym: Sym; market: Market; price: number | null; initial: Position | null; onDelete?: () => void;
}) {
  const id = useId();
  const [avgS, setAvgS] = useState(initial ? fmtInput(initial.avg) : '');
  const [qtyS, setQtyS] = useState(initial?.qty ? fmtInput(initial.qty) : '');
  const [qtyOpen, setQtyOpen] = useState(!!initial?.qty);
  const [tried, setTried] = useState(false);
  const avgP = parseAmount(avgS), qtyP = parseAmount(qtyS);
  const avgErr = avgP.error ?? (tried && avgP.value == null ? '평단가를 입력해 주세요' : null);
  const far = !avgErr && avgP.value != null && farFromPrice(avgP.value, price);
  const coin = MARKETS[market].coin;
  const same = !!initial && avgP.value === initial.avg && (qtyP.value ?? undefined) === initial.qty;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (avgP.value == null || avgP.error || qtyP.error) return;
    savePosition(sym, { avg: avgP.value, ...(qtyP.value ? { qty: qtyP.value } : {}), at: Date.now() });
  };
  const blurFmt = (s: string, set: (v: string) => void) => { const p = parseAmount(s); if (p.value != null) set(fmtInput(p.value)); };
  const msgId = avgErr || far ? id + 'avg-msg' : undefined;
  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={id + 'avg'} className="text-[13px] font-semibold text-secondary-foreground">내 평균 단가</label>
      <div className="mt-2 flex flex-wrap gap-2">
        <div className="min-w-[200px] flex-1">
          <AmountInput id={id + 'avg'} value={avgS} onChange={setAvgS} onBlur={() => blurFmt(avgS, setAvgS)} invalid={!!avgErr}
            prefix={market === 'us' ? '$' : undefined} suffix={market === 'us' ? undefined : UNIT_WORD[market]}
            placeholder={price != null ? fmtPrice(price, market) : '평단가'} describedBy={msgId} />
        </div>
        <button type="submit" className={cn('press h-12 rounded-xl px-5 text-[15px] font-bold whitespace-nowrap max-[374px]:w-full',
          same ? 'bg-secondary text-secondary-foreground' : 'bg-primary text-primary-foreground')}>
          {same ? '저장됨' : initial ? '다시 진단' : '진단하기'}
        </button>
      </div>
      {avgErr || far ? (
        <p id={msgId} className={cn('mt-2 text-[13px] font-medium break-keep', avgErr ? WARN_TEXT : 'text-muted-foreground')}>
          {avgErr ?? `현재가(${fmtPriceUnit(price, market)})와 5배 넘게 차이 나요 — ${UNIT_WORD[market]} 기준 가격이 맞는지 확인해 주세요`}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setQtyOpen((o) => !o)} aria-expanded={qtyOpen} aria-controls={id + 'qtybox'}
          className="press inline-flex h-9 items-center gap-0.5 rounded-lg px-2 text-[13px] font-semibold text-secondary-foreground hover:bg-hover">
          수량 {qtyOpen ? '' : '넣기 '}<span className="font-medium text-muted-foreground">(선택)</span><ChevronDown aria-hidden className={cn('size-4 transition-transform', qtyOpen && 'rotate-180')} />
        </button>
        {price != null ? (
          <button type="button" onClick={() => setAvgS(fmtInput(price))} className="press inline-flex h-9 items-center rounded-lg px-2 text-[13px] font-semibold text-secondary-foreground tabular hover:bg-hover">
            현재가 넣기
          </button>
        ) : null}
        {onDelete ? (
          <button type="button" onClick={onDelete} className="press ml-auto inline-flex h-9 items-center rounded-lg px-2 text-[13px] font-semibold text-muted-foreground hover:bg-hover hover:text-foreground">평단 지우기</button>
        ) : null}
      </div>
      {qtyOpen ? (
        <div id={id + 'qtybox'} className="mt-1.5">
          <label htmlFor={id + 'qty'} className="text-[13px] font-semibold text-secondary-foreground">보유 수량 — 넣으면 손익 금액도 보여 드려요</label>
          <div className="mt-2">
            <AmountInput id={id + 'qty'} value={qtyS} onChange={setQtyS} onBlur={() => blurFmt(qtyS, setQtyS)} invalid={!!qtyP.error}
              suffix={coin ? '개' : '주'} placeholder={coin ? '예: 0.15' : '예: 10'} describedBy={qtyP.error ? id + 'qty-msg' : undefined} />
          </div>
          {qtyP.error ? <p id={id + 'qty-msg'} className={cn('mt-2 text-[13px] font-medium break-keep', WARN_TEXT)}>{qtyP.error}</p> : null}
        </div>
      ) : null}
    </form>
  );
}

function AmountInput({ id, value, onChange, onBlur, invalid, prefix, suffix, placeholder, describedBy, size = 'md' }: {
  id: string; value: string; onChange: (v: string) => void; onBlur: () => void; invalid: boolean;
  prefix?: string; suffix?: string; placeholder: string; describedBy?: string; size?: 'sm' | 'md';
}) {
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-xl px-4 focus-within:ring-[1.5px] focus-within:ring-foreground focus-within:ring-inset',
      size === 'sm' ? 'h-11 bg-card shadow-[inset_0_0_0_1px_var(--border)]' : 'h-12 bg-secondary',
      invalid && 'ring-[1.5px] ring-warn ring-inset focus-within:ring-warn')}>
      {prefix ? <span className="text-[16px] font-semibold text-muted-foreground">{prefix}</span> : null}
      <input
        id={id} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
        inputMode="decimal" autoComplete="off" spellCheck={false} placeholder={placeholder}
        aria-invalid={invalid || undefined} aria-describedby={describedBy}
        className={cn('h-full w-full min-w-0 flex-1 bg-transparent font-semibold tabular outline-none placeholder:font-normal placeholder:text-faint', size === 'sm' ? 'text-[16px]' : 'text-[17px]')}
      />
      {suffix ? <span className="shrink-0 text-[15px] font-medium text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

// ── 진단 화면 조각 ──
function Status({ loading, error, count, onRetry }: { loading: boolean; error: Error | null; count: number | null; onRetry: () => void }) {
  if (loading) return <Skeleton className="h-[104px] w-full rounded-[14px]" aria-label="진단 준비 중" />;
  const box = (children: ReactNode) => <div className="rounded-[14px] bg-secondary px-4 py-3.5 text-[14px] leading-relaxed break-keep text-secondary-foreground">{children}</div>;
  if (error) {
    return box(<>
      <p className="font-semibold">일봉을 불러오지 못해 손절선·목표는 계산하지 못했어요.</p>
      {/* 우리 쪽 안내 문장(한글)만 그대로 보여 주고, 브라우저·파싱 오류는 쉬운 말로 */}
      <p className="mt-0.5 text-[13px] text-muted-foreground">{/[가-힣]/.test(error.message) ? error.message : '인터넷 연결을 확인하고 다시 시도해 주세요.'}</p>
      <button onClick={onRetry} className="press mt-2.5 h-10 rounded-xl bg-card px-4 text-[14px] font-semibold">다시 시도</button>
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

/** '평단보다 ▲13.0% 위에 있어요' + '평단 → 지금 · 1개당 손익' */
function PnlLine({ avg, qty, price, market, delayed }: { avg: number; qty: number | null; price: number | null; market: Market; delayed: boolean }) {
  if (price == null) return <div><Skeleton className="h-7 w-56" /><Skeleton className="mt-2 h-4 w-72" /></div>;
  const pnl = (price / avg - 1) * 100;
  const t = dirShown(pnl);
  const per = MARKETS[market].coin ? '1개당' : '1주당';
  return (
    <div>
      <p className="text-[20px] leading-7 font-bold tracking-[-0.02em] break-keep">
        {t === 'flat' ? '평단과 거의 같아요' : <>평단보다 <UpDown x={pnl} /> {t === 'up' ? '위에' : '아래에'} 있어요</>}
      </p>
      <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground tabular break-keep">
        평단 {fmtPriceUnit(avg, market)} → 지금 {fmtPriceUnit(price, market)} · {per} <span className={cn('font-semibold', TONE_TEXT[t])}>{fmtMoney(price - avg, market)}</span>
        {qty != null ? <> · {fmtQty(qty, market)} 합계 <span className={cn('font-semibold', TONE_TEXT[t])}>{fmtMoney((price - avg) * qty, market)}</span></> : null}
        {delayed ? <span className="ml-1.5 rounded-md bg-secondary px-1.5 py-px text-[12px] font-semibold text-muted-foreground">지연 시세</span> : null}
      </p>
    </div>
  );
}

function VerdictBox({ d, aiS }: { d: Diagnosis; aiS: number | null }) {
  const v = VERDICT[d.verdict.tone];
  const agree = aiS != null ? aiAgreement(d.lean, aiS) : null;
  return (
    <div className={cn('rounded-[14px] px-4 py-3.5', v.box)}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[13.5px] font-bold', v.text)}><v.Icon aria-hidden className="size-4 shrink-0" />{d.verdict.badge}</span>
        <span className="ml-auto text-[12.5px] text-muted-foreground">일봉 기준</span>
      </div>
      <p className="mt-1 text-[17px] leading-snug font-bold tracking-tight break-keep">{d.verdict.title}</p>
      <p className="mt-1 text-[14px] leading-[1.5] break-keep text-secondary-foreground">{d.verdict.detail}</p>
      {agree ? (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-snug font-semibold break-keep">
          <Sparkles aria-hidden className="mt-px size-3.5 shrink-0 text-[var(--ai,var(--chart-5))]" />
          <span className={agree.same ? 'text-foreground' : 'text-[color-mix(in_srgb,var(--ai,var(--chart-5))_75%,var(--foreground))]'}>{agree.text}</span>
        </p>
      ) : null}
    </div>
  );
}

interface LadderPoint { key: string; name: string; v: number; kind: 'stop' | 'avg' | 'now' | 'target' }
/** 가격 사다리 — 8px 트랙에 손절선 아래(파랑)·목표 위(빨강) 구간을 옅게, 눈금(손절·목표·평단)과 지금 위치 점.
 *  이름표는 위(손절선·목표)·아래(평단·지금) 두 줄 — 겹치면 placeLabels 가 옆으로 민다 */
function PriceLadder({ d, market }: { d: Diagnosis; market: Market }) {
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const [W, setW] = useState(0);
  const [place, setPlace] = useState<{ top: LabelPos[]; bottom: LabelPos[] } | null>(null);
  const pts: LadderPoint[] = [
    { key: 'stop', name: d.stopBroken ? '손절선(이탈)' : '손절선', v: d.stop, kind: 'stop' },
    ...(d.target != null ? [{ key: 'target', name: '목표', v: d.target, kind: 'target' as const }] : []),
    { key: 'avg', name: '평단', v: d.avg, kind: 'avg' },
    { key: 'now', name: '지금', v: d.price, kind: 'now' },
  ];
  const vs = pts.map((p) => p.v);
  const lo0 = Math.min(...vs), hi0 = Math.max(...vs), pad = (hi0 - lo0 || hi0 * 0.02) * 0.08;
  const lo = lo0 - pad, hi = hi0 + pad;
  const x = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * W : W / 2);
  const sig = pts.map((p) => `${p.key}:${p.v}`).join('|');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const topIdx = pts.map((p, i) => (p.kind === 'stop' || p.kind === 'target' ? i : -1)).filter((i) => i >= 0);
  const botIdx = pts.map((p, i) => (p.kind === 'avg' || p.kind === 'now' ? i : -1)).filter((i) => i >= 0);
  useLayoutEffect(() => {
    if (!W) return;
    const ws = pts.map((_, i) => labels.current[i]?.offsetWidth ?? 40);
    const lay = (idx: number[]) => placeLabels(idx.map((i) => x(pts[i].v)), idx.map((i) => ws[i]), W);
    setPlace({ top: lay(topIdx), bottom: lay(botIdx) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, W]);
  // 이름표 줄 수에 따라 트랙 위치·높이를 정한다 (위 줄 16px · 트랙 위아래 12px)
  const topRows = place ? 1 + Math.max(0, ...place.top.map((x) => x.row)) : 1;
  const botRows = place ? 1 + Math.max(0, ...place.bottom.map((x) => x.row)) : 1;
  const TRACK = topRows * 16 + 12; // 트랙 가운데 y
  const H = TRACK + 12 + botRows * 16;
  const posOf = (i: number) => {
    if (!place) return null;
    const t = topIdx.indexOf(i);
    if (t >= 0) return { left: place.top[t].left, top: (topRows - 1 - place.top[t].row) * 16 };
    const b = botIdx.indexOf(i);
    return b >= 0 ? { left: place.bottom[b].left, top: TRACK + 12 + place.bottom[b].row * 16 } : null;
  };
  return (
    <div ref={box} className="relative select-none" style={{ height: H }} role="img"
      aria-label={`가격 사다리: ${pts.map((p) => `${p.name} ${fmtPriceUnit(p.v, market)}`).join(', ')}`}>
      <div className="absolute inset-x-0 h-2 -translate-y-1/2 rounded-full bg-border" style={{ top: TRACK }} />
      {W > 0 ? (
        <>
          <div className="absolute h-2 -translate-y-1/2 rounded-l-full bg-down/22" style={{ top: TRACK, left: 0, width: x(d.stop) }} />
          {d.target != null ? <div className="absolute h-2 -translate-y-1/2 rounded-r-full bg-up/22" style={{ top: TRACK, left: x(d.target), right: 0 }} /> : null}
          {pts.filter((p) => p.kind !== 'now').map((p) => (
            <span key={p.key} className={cn('absolute h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full', p.kind === 'stop' ? 'bg-down' : p.kind === 'target' ? 'bg-up' : 'bg-muted-foreground')} style={{ left: x(p.v), top: TRACK }} />
          ))}
          <span className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--card)] transition-[left] duration-300 motion-reduce:transition-none" style={{ left: x(d.price), top: TRACK }} />
        </>
      ) : null}
      {pts.map((p, i) => {
        const pl = posOf(i);
        return (
          <div key={p.key} ref={(el) => { labels.current[i] = el; }} aria-hidden
            className={cn('absolute text-[12px] leading-4 font-semibold whitespace-nowrap', pl ? '' : 'invisible',
              p.kind === 'stop' ? 'text-down-text' : p.kind === 'target' ? 'text-up-text' : p.kind === 'now' ? 'font-bold text-foreground' : 'text-muted-foreground')}
            style={{ left: pl ? pl.left : 0, top: pl ? pl.top : 0 }}>
            {p.name}
          </div>
        );
      })}
    </div>
  );
}

/** 선 목록 — 손절 고려선 · 1차 목표 · 지지 (가격 · 지금보다 % · 근거 한 줄) */
function LevelList({ d, market, f }: { d: Diagnosis; market: Market; f: (x: number) => string }) {
  const fromNow = (x: number) => `지금보다 ${sgnPct((x / d.price - 1) * 100)}`;
  const atrTxt = `${d.atrPct.toFixed(d.atrPct < 1 ? 2 : 1)}%`;
  const rows: { key: string; name: string; dot: string; v: number | null; why: ReactNode; note?: ReactNode }[] = [
    { key: 'stop', name: '손절 고려선', dot: 'bg-down', v: d.stop,
      why: <>{d.stopBasis}. 하루 평균 움직임(ATR)은 {f(roundSig(d.atr))} ({atrTxt})</>,
      note: d.stopBroken ? <span className={cn('font-semibold', WARN_TEXT)}>이미 이탈했어요</span> : null },
    { key: 'target', name: d.targetKind === 'high' ? '1차 목표 · 최근 최고가' : '1차 목표', dot: 'bg-up', v: d.target,
      why: d.target == null ? '위쪽에 막힐 최근 고점이 없어요' : d.targetKind === 'high' ? '위쪽에 막힐 고점이 없어 최근 최고가를 목표로 봤어요' : '최근 고점 — 한 번 막혔던 자리예요' },
    { key: 'support', name: '가까운 지지', dot: 'bg-muted-foreground', v: d.support, why: d.support == null ? '아래쪽에 받쳐 줄 최근 저점이 없어요' : '가장 가까운 최근 저점 — 내려오면 받쳐 줄 수 있는 자리예요' },
  ];
  return (
    <div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="py-3.5 first:pt-0">
            <div className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 pt-px text-[14.5px] font-semibold"><i aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', r.dot)} />{r.name}</span>
              <span className="shrink-0 text-right tabular">
                <b className="block text-[15px] font-bold">{r.v != null ? fmtPriceUnit(r.v, market) : '–'}</b>
                {r.v != null ? <span className="text-[12.5px] text-muted-foreground">{r.note ?? fromNow(r.v)}</span> : null}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-[1.5] break-keep text-muted-foreground">{r.why}</p>
          </li>
        ))}
      </ul>
      <p className="mt-1 rounded-[14px] bg-[var(--tile,var(--hover))] px-3.5 py-2.5 text-[13px] leading-[1.5] break-keep text-secondary-foreground tabular">
        손익비 <b className="font-bold text-foreground">{d.rr == null ? '–' : d.rr >= 10 ? '10배 이상' : `${d.rr.toFixed(1)}배`}</b>
        <span className="text-muted-foreground"> ({d.rr != null ? '목표까지 ÷ 손절선까지' : d.stopBroken ? '손절선 이탈' : '목표 없음'})</span>
        {!d.stopBroken ? <> · 손절선에서 정리하면 평단 대비 <b className="font-semibold text-foreground">{sgnPct(d.stopFromAvgPct)}{d.stopAmt != null ? ` (${fmtMoney(d.stopAmt, market)})` : ''}</b></> : null}
      </p>
    </div>
  );
}

const SCENE: Record<LineTone, { title: string; icon: string; cls: string; order: number }> = {
  up: { title: '오를 때', icon: '▲', cls: 'bg-up-soft text-up-text', order: 0 },
  flat: { title: '옆으로 갈 때', icon: '●', cls: 'bg-secondary text-muted-foreground', order: 1 },
  down: { title: '내릴 때', icon: '▼', cls: 'bg-down-soft text-down-text', order: 2 },
};
function Scenarios({ d, coin }: { d: Diagnosis; coin: boolean }) {
  const list = d.scenarios.slice().sort((a, b) => SCENE[a.tone].order - SCENE[b.tone].order);
  return (
    <section aria-label="시나리오">
      <h3 className="text-[15px] font-bold">시나리오</h3>
      <ul className="mt-3 space-y-3.5">
        {list.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className={cn('mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[9px]', SCENE[s.tone].cls)}>{SCENE[s.tone].icon}</span>
            <div className="min-w-0">
              <div className="text-[14.5px] leading-[22px] font-bold">{SCENE[s.tone].title}</div>
              <p className="text-[13.5px] leading-[1.5] break-keep text-secondary-foreground">{s.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[12.5px] text-muted-foreground">마감 = 일봉 종가 ({coin ? '코인은 매일 오전 9시' : '장 마감 가격'})</p>
    </section>
  );
}

function ReasonGroup({ title, tone, items }: { title: string; tone: LineTone; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-bold"><span aria-hidden className={cn('text-[9px]', TONE_TEXT[tone])}>{tone === 'up' ? '▲' : tone === 'down' ? '▼' : '●'}</span>{title}</div>
      <ul className="space-y-1.5">
        {items.map((x, i) => {
          const k = x.indexOf(' — ');
          return (
            <li key={i} className="relative pl-3.5 text-[13.5px] leading-[1.5] break-keep">
              <span aria-hidden className="absolute top-[9px] left-0.5 size-1 rounded-full bg-faint" />
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
  const [open, setOpen] = useState(false); // 카드가 너무 길어지지 않게 접어 둔다
  const id = useId();
  return (
    <section aria-label="판단 근거">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={id} className="press -mx-2 flex h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-xl px-2 text-left hover:bg-hover">
        <h3 className="text-[15px] font-bold">판단 근거</h3>
        <span className="text-[13px] font-semibold text-muted-foreground tabular">{n}</span>
        <ChevronDown aria-hidden className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div id={id} className="mt-2 space-y-3.5">
          <ReasonGroup title="좋은 점" tone="up" items={d.reasons.pos} />
          <ReasonGroup title="걱정되는 점" tone="down" items={d.reasons.neg} />
          <ReasonGroup title="내 평단 기준" tone="flat" items={d.reasons.mine} />
        </div>
      ) : null}
    </section>
  );
}
