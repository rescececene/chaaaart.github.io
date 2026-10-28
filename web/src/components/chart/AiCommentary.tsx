// 종목 AI 해설 — GitHub Actions 가 업비트 원화 전 종목과 시장별 상위 종목을 몇 시간마다 돌려 가며 만든 data/stock_ai.json (정적 파일 · 중계 호출 없음)
// 코인은 이 거래소에 해설이 없으면 같은 코인의 다른 거래소 해설을 보여 준다 (업비트 원화 → 바이낸스 순)
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';
import { coinBase, coinExOf, coinSym, COIN_EXES, EX_NAME, EX_UNIT } from '@/lib/coins';
import { stockAi, type StockAi, type StockAiItem, type Sym } from '@/lib/market';
import { Skeleton } from '@/components/ui/skeleton';

/** s: -2 매우 약함 … 2 매우 강함 */
export const AI_DIR: Record<number, [string, 'up' | 'down' | 'flat']> = {
  2: ['매우 강함', 'up'], 1: ['강함', 'up'], 0: ['중립', 'flat'], [-1]: ['약함', 'down'], [-2]: ['매우 약함', 'down'],
};
const TONE = { up: 'text-up-text', down: 'text-down-text', flat: 'text-muted-foreground' } as const;

function findAi(d: StockAi | undefined, sym: Sym): { item: StockAiItem; from: Sym } | null {
  const items = d?.items;
  if (!items) return null;
  const base = coinBase(sym);
  const tries = base ? [sym, ...COIN_EXES.map((ex) => coinSym(ex, base)).filter((s) => s !== sym)] : [sym];
  for (const s of tries) {
    const it = items[s];
    if (it && typeof it.x === 'string' && it.x.trim()) return { item: it, from: s };
  }
  return null;
}

/** 이 종목의 AI 해설 — 없으면 hit 가 null. 파일이 아직 없으면(404 · 개발 서버는 HTML 이 와서 SyntaxError) 없음과 같다 */
export function useStockAi(sym: Sym) {
  const q = useQuery({ queryKey: ['stockAi'], queryFn: stockAi, staleTime: 10 * 60e3, retry: false });
  const hit = useMemo(() => findAi(q.data, sym), [q.data, sym]);
  const missing = (q.error as { status?: number } | null)?.status === 404 || q.error instanceof SyntaxError;
  return { hit, loading: q.isLoading, failed: q.isError && !missing };
}

/** 'AI 해설' 상자 — 차트 분석 카드와 내 평단 진단 카드가 같이 쓴다 (AI 표시는 보라 한 가지) */
export function AiCommentary({ sym, className, title = 'AI 해설' }: { sym: Sym; className?: string; title?: string }) {
  const { hit, loading, failed } = useStockAi(sym);
  const dir = hit ? AI_DIR[hit.item.s] ?? AI_DIR[0] : null;
  const otherEx = hit && hit.from !== sym ? coinExOf(hit.from) : null;
  return (
    <section className={cn('rounded-[14px] bg-[color-mix(in_srgb,var(--ai,var(--chart-5))_7%,var(--card))] p-4', className)} aria-label={title}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Sparkles aria-hidden className="size-4 shrink-0 text-[var(--ai,var(--chart-5))]" />
        <h3 className="text-[14px] font-bold">{title}</h3>
        {dir ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-card px-1.5 text-[12px] leading-5 font-semibold whitespace-nowrap text-foreground">
            <span aria-hidden className={cn('text-[8px]', TONE[dir[1]])}>{dir[1] === 'up' ? '▲' : dir[1] === 'down' ? '▼' : '●'}</span>{dir[0]}
          </span>
        ) : null}
        {hit?.item.at ? <span className="ml-auto text-[12.5px] text-muted-foreground tabular">{timeAgo(hit.item.at * 1000)}</span> : null}
      </div>
      {loading ? (
        <div className="mt-2.5 space-y-2"><Skeleton className="h-3.5 w-full" /><Skeleton className="h-3.5 w-4/5" /></div>
      ) : hit ? (
        <>
          <p className="mt-2 text-[14.5px] leading-[22px] break-keep text-secondary-foreground">{hit.item.x}</p>
          {otherEx ? <p className="mt-1.5 text-[12.5px] text-muted-foreground">{EX_NAME[otherEx]} {EX_UNIT[otherEx]} 기준 해설이에요</p> : null}
        </>
      ) : (
        <p className="mt-1.5 text-[13.5px] leading-relaxed break-keep text-muted-foreground">
          {failed ? 'AI 해설을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' : '이 종목은 아직 AI 해설이 없어요 (업비트 원화 전 종목과 시장별 상위 종목을 몇 시간마다 돌려 가며 해설해요)'}
        </p>
      )}
    </section>
  );
}
