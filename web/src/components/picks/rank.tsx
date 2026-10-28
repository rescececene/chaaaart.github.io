// 순위 화면 공용 — '24시간 뒤 예상 +X%' · '10번 중 8번은 A ~ B' · 주의 표시 · 지금 위치(실시간) · 예측 성적
// 말투는 비트코인 카드와 같게: 예상 % 는 가운데 값, 범위는 10번 중 8번, 성적은 '되짚어 봄'(백테스트)과 '실제 기록'(채점)을 나눈다.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useQuote } from '@/hooks/market';
import type { Caution, Market, PastStats, PickLast, PickStats, Sym } from '@/lib/market';
import { dayText, fpct, MKT_ALL, p0, pickDay, toneOf } from './fmt';

export { expDigits, fcWarn, fpct, fpp, MKT_ALL, p0, toneOf, whenText } from './fmt';

/** '10번 중 8번은 −2.9% ~ +3.4%' */
export function RangeText({ lo, hi, className, label = '10번 중 8번은' }: { lo: number | null | undefined; hi: number | null | undefined; className?: string; label?: ReactNode }) {
  if (lo == null || hi == null) return null;
  return (
    <span className={cn('tabular whitespace-nowrap', className)}>
      {label ? <span className="text-muted-foreground">{label} </span> : null}
      <span className={toneOf(lo)}>{fpct(lo)}</span> ~ <span className={toneOf(hi)}>{fpct(hi)}</span>
    </span>
  );
}

/** 주의 표시 — 빼지 않고 알린다 (회색 칩 + 주황 점) */
export function CautionChips({ cau, max = 3, className }: { cau: Caution[] | undefined; max?: number; className?: string }) {
  if (!cau?.length) return null;
  const shown = cau.slice(0, max);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {shown.map((c) => (
        <span key={c.k} className="inline-flex h-5 items-center gap-1 rounded-md bg-secondary px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-secondary-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />{c.t}
        </span>
      ))}
      {cau.length > max ? <span className="text-[11.5px] text-muted-foreground">+{cau.length - max}</span> : null}
    </span>
  );
}

/** 지금 가격(실시간)과 기준가 → 기준가 뒤 움직임. 실시간이 없으면 수집 때 가격 */
export function useMove(sym: Sym, base: number | null | undefined, fallback: number | null | undefined) {
  const q = useQuote(sym);
  const price = q?.price ?? fallback ?? null;
  const move = price != null && base ? price / base - 1 : null;
  return { price, move, live: !!q?.live, chg: q?.chg ?? null };
}

/** 작은 범위 막대 — 회색 길 위에 10번 중 8번(보라 띠), 기준가(0, 세로 눈금), 예상(보라 점), 지금(먹색 점) */
export function MiniRange({ lo, hi, mid, now, className }: { lo: number; hi: number; mid?: number | null; now?: number | null; className?: string }) {
  const vals = [lo, hi, 0, ...(now != null && Number.isFinite(now) ? [now] : [])];
  const a = Math.min(...vals), b = Math.max(...vals);
  const pad = (b - a) * 0.08 || 0.01;
  const L = a - pad, span = b + pad - L;
  const x = (v: number) => `${((v - L) / span) * 100}%`;
  const inside = now != null && now >= lo && now <= hi;
  return (
    <span role="img" aria-label={`10번 중 8번 범위 ${fpct(lo)} ~ ${fpct(hi)}${now != null ? `, 지금 ${fpct(now)}${inside ? ' (범위 안)' : ' (범위 밖)'}` : ''}`}
      className={cn('relative block h-1.5 rounded-full bg-border', className)}>
      <span className="absolute inset-y-0 rounded-full bg-[color-mix(in_srgb,var(--ai)_32%,var(--border))]" style={{ left: x(lo), width: `${((hi - lo) / span) * 100}%` }} />
      <span className="absolute -inset-y-[3px] w-px -translate-x-1/2 bg-muted-foreground/70" style={{ left: x(0) }} />
      {mid != null ? <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ai" style={{ left: x(mid) }} /> : null}
      {now != null && Number.isFinite(now) ? (
        <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card" style={{ left: x(now) }} />
      ) : null}
    </span>
  );
}

/** 예측 성적 — 실제 기록(채점)과 지난 30회 되짚어 봄(백테스트)을 나눠 보인다 */
export function ScoreLines({ market, last, real, past, pending, className, h = 1, dd }: {
  market: Market; last?: PickLast | null; real?: PickStats | null; past?: Omit<PastStats, 'list'> | null; pending?: { n: number; d: string } | null; className?: string;
  /** 보유 기간 — 1이면 '시장보다 나은 날', 길면 '…나은 회차' */
  h?: number;
  /** 되짚어 본 기간의 누적 최대 낙폭 (고른 5개 · 시장 전체) — '시장을 이겨도 손실이 날 수 있어요' */
  dd?: { mdd?: number | null; uniMdd?: number | null } | null;
}) {
  const won_ = h > 1 ? '시장보다 나은 회차' : '시장보다 나은 날';
  const all = MKT_ALL[market];
  const rows: ReactNode[] = [];
  if (last) {
    rows.push(
      <div key="last" className="py-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">{dayText(pickDay(last.d, market))} 고른 5개</span>
          <span className={cn('inline-flex h-[22px] items-center rounded-md px-1.5 text-[12px] font-bold', last.win ? 'bg-up-soft text-up-text' : 'bg-secondary text-muted-foreground')}>
            {last.win ? '시장보다 나음' : '시장보다 못함'}
          </span>
        </div>
        <p className="mt-0.5 tabular break-keep">
          예상 <span className={toneOf(last.pred, 2)}>{fpct(last.pred, 2)}</span> → 실제 <b className={cn('font-semibold', toneOf(last.avg, 2))}>{fpct(last.avg, 2)}</b>
          <span className="text-muted-foreground"> · {all} <span className={toneOf(last.mkt, 2)}>{fpct(last.mkt, 2)}</span></span>
        </p>
      </div>,
    );
  }
  if (real && real.n > 0) {
    const won = Math.round(real.win * real.n);
    rows.push(
      <div key="real" className={cn('py-1.5', rows.length && 'border-t border-border')}>
        <span className="text-muted-foreground">실제 기록 최근 {real.n}회</span>
        <p className="mt-0.5 tabular break-keep">
          {won_} <b className="font-semibold">{won}/{real.n}</b> · 평균 <span className={toneOf(real.avg, 2)}>{fpct(real.avg, 2)}</span>
          <span className="text-muted-foreground">(예상 {fpct(real.pred, 2)} · 시장 {fpct(real.mkt, 2)})</span>
          {real.inRange != null ? <> · 범위 안 {p0(real.inRange)}</> : null}
        </p>
      </div>,
    );
  }
  if (past && (!real || real.n < 20)) {
    rows.push(
      <div key="past" className={cn('py-1.5', rows.length && 'border-t border-border')}>
        <span className="text-muted-foreground">지난 {past.n}회 되짚어 봄 <span className="text-[12px]">· 실제 기록 아님</span></span>
        <p className="mt-0.5 tabular break-keep">
          {won_} <b className="font-semibold">{Math.round(past.beat * past.n)}/{past.n}</b> · 평균 <span className={toneOf(past.act, 2)}>{fpct(past.act, 2)}</span>
          <span className="text-muted-foreground">(예상 {fpct(past.pred, 2)} · 시장 {fpct(past.mkt, 2)})</span>
          {past.inRange != null ? <> · 범위 안 {p0(past.inRange)}</> : null}
        </p>
      </div>,
    );
  }
  if (!rows.length && pending) {
    rows.push(<p key="pend" className="py-1.5 text-muted-foreground">첫 채점은 고른 뒤 기간이 지나야 나와요 ({pending.n}회 기다리는 중).</p>);
  }
  if (rows.length && dd?.mdd != null && Number.isFinite(dd.mdd)) {
    rows.push(
      <p key="dd" className="border-t border-border py-1.5 break-keep text-muted-foreground">
        시장을 이겨도 손실이 날 수 있어요 — 되짚어 본 기간 최대 낙폭 <b className="font-semibold text-down-text tabular">{fpct(dd.mdd, 0)}</b>
        {dd.uniMdd != null ? <span className="tabular"> (시장 {fpct(dd.uniMdd, 0)})</span> : null}
      </p>,
    );
  }
  if (!rows.length) return null;
  return <div className={cn('text-[13px] leading-5', className)}>{rows}</div>;
}
