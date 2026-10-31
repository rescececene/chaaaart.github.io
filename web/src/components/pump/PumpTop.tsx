// 첫 화면용 펌핑 후보 요약 — '급락 위험 뺀 순'(펌핑 확률 − 급락 확률) 상위 5개 + 과거 검증 한 줄 + '전체 보기' (pump.json 하나만 읽는다)
// 실시간: 점수를 낸 시각(기준) 뒤 이미 +15% 넘게 오르거나 −10% 넘게 빠진 후보는 웹소켓 가격으로 바로 목록에서 내리고 다음 후보로 채운다.
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuote, useQuotesTick, useWant } from '@/hooks/market';
import { getQuote } from '@/lib/market';
import { liveOrder, pumpData, pumpMove, type PumpItem } from '@/lib/market/pump';
import { surgeFor } from '@/lib/market/surge';
import { href } from '@/lib/router';
import { p0, RiskChips, sp } from './parts';

const TopRow = memo(function TopRow({ it, rank }: { it: PumpItem; rank: number }) {
  const q = useQuote(it.sym);
  const mv = q?.live ? pumpMove(it.price, q.price) : null;
  const hot = surgeFor(it.sym)?.hit;
  return (
    <li>
      <a href={href('pump', it.code)}
        className="press -mx-2 grid grid-cols-[16px_32px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover">
        <span className="text-right text-[13px] font-semibold text-muted-foreground tabular">{rank}</span>
        <SymbolLogo sym={it.sym} size={32} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <b className="truncate text-[15px] leading-5 font-semibold">{it.name}</b>
            {hot ? <span className="inline-flex h-[20px] shrink-0 items-center rounded-[6px] bg-up-soft px-1.5 text-[12px] font-semibold text-up-text">지금 급등</span> : null}
            <RiskChips risks={it.risks} max={1} />
          </span>
          <span className="block truncate text-[14px] leading-5 font-semibold text-secondary-foreground">
            3일 안 최고 <b className="font-bold text-up-text tabular">{sp(it.mfe[1])}</b> 예상
          </span>
          <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground tabular">
            펌핑<span className="max-sm:hidden">(+15%)</span> <b className="font-semibold text-up-text">{p0(it.pPump)}</b> · 급락<span className="max-sm:hidden">(−15%)</span> <b className="font-semibold text-down-text">{p0(it.pDump)}</b>
            {mv != null ? <> · 점수 낸 뒤 <ChangeText value={mv * 100} className="text-[12.5px]" /></> : q?.chg != null ? <> · 24h <ChangeText value={q.chg} className="text-[12.5px]" /></> : null}
          </span>
        </span>
        <span className="text-right leading-none" title="후보 점수 = 펌핑 확률 − 2 × 급락 확률 이 과거 코인·시점 중 몇 % 보다 큰지">
          <b className="text-[20px] font-bold tracking-[-0.02em] tabular">{Math.round(it.cand)}</b>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">후보 점수</span>
        </span>
      </a>
    </li>
  );
});

/** 첫 화면 카드 — 데이터가 아직 없으면 아무것도 그리지 않는다 */
export function PumpTop({ className, count = 5 }: { className?: string; count?: number }) {
  const { data, isLoading } = useQuery({ queryKey: ['pump'], queryFn: pumpData, staleTime: 3 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });
  // 이미 움직인 후보를 내려도 채울 수 있게 몇 개 더 지켜본다
  const pool = useMemo(() => [...(data?.items ?? [])].filter((it) => it.rankNet != null)
    .sort((a, b) => a.rankNet - b.rankNet).slice(0, count + 10), [data, count]);
  const syms = useMemo(() => pool.map((it) => it.sym), [pool]);
  useWant(syms.length ? syms : null);
  const symSet = useMemo(() => new Set(syms), [syms]);
  const tick = useQuotesTick(1000, (changed) => [...changed].some((s) => symSet.has(s)));
  const ordered = useMemo(() => liveOrder(pool, (it) => it.rankNet, (it) => {
    const q = getQuote(it.sym);
    return q?.live ? pumpMove(it.price, q.price) : null;
  }), [pool, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = ordered.filter((o) => o.st === 'ok').slice(0, count).map((o) => o.x);
  const moved = ordered.filter((o) => o.st !== 'ok' && o.x.rankNet <= count + 5);
  if (isLoading) {
    return (
      <Card className={className}>
        <CardTitle>펌핑 후보</CardTitle>
        <div className="space-y-3">{Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-11 rounded-xl bg-secondary" />)}</div>
      </Card>
    );
  }
  if (!items.length) return null;
  const ord = data?.summary?.orders, base = data?.summary?.base;
  return (
    <Card className={cn(className)}>
      <CardTitle sub="후보 점수 순 — 72시간 안 +15% 가능성에서 급락 위험을 뺐어요 · 가격은 실시간"
        right={<a href={href('pump')} className="inline-flex items-center font-semibold text-muted-foreground hover:text-foreground">전체 보기<ChevronRight aria-hidden className="size-4" /></a>}>
        펌핑 후보
      </CardTitle>
      {data?.regime?.warn ? (
        <p className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-secondary-foreground">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />지금은 펌핑 후보가 급락도 잦은 때예요
        </p>
      ) : null}
      <ol>{items.map((it, k) => <TopRow key={it.code} it={it} rank={k + 1} />)}</ol>
      {moved.length ? (
        <p className="mt-1 text-[12.5px] leading-[1.55] break-keep text-muted-foreground tabular">
          이미 움직여서 내린 후보: {moved.map((o, k) => (
            <span key={o.x.code}>{k ? ' · ' : ''}{o.x.name} <span className={o.st === 'ran' ? 'text-up-text' : 'text-down-text'}>{sp(o.move)}</span></span>
          ))} (기준 가격 대비)
        </p>
      ) : null}
      {ord && base ? (
        <p className="mt-2 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">
          과거 이 순서 상위 {ord.k}개는 3일 안 +15%가 {p0(ord.net.pump)}(평소 {p0(base.pump)}), −15% 급락도 {p0(ord.net.dump)}(평소 {p0(base.dump)})였어요 —
          크게 움직일 코인이지 오를 코인이 아니에요. 투자 권유가 아니에요.
        </p>
      ) : null}
    </Card>
  );
}
