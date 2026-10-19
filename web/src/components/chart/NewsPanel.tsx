import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { aiKey, loadStaticStocks, MARKETS, newsAi, split, symbolNews, topicNews, type Market, type NewsItem, type Sym } from '@/lib/market';
import { timeAgo } from '@/lib/format';
import { useNamesVersion, useRelay } from '@/hooks/market';
import { Skeleton } from '@/components/ui/skeleton';
import { LevelBadge } from '@/components/news/NewsCard';
import { medianVotes, relatedOf, sentimentOf, VOTE_NEUTRAL, type Sentiment } from '@/lib/newsTag';
import { href } from '@/lib/router';
import { cn } from '@/lib/utils';

export function NewsList({ items, limit = 8 }: { items: { title: string; src: string; url: string; ts: number }[]; limit?: number }) {
  return (
    <ul className="space-y-0.5">
      {items.slice(0, limit).map((x, i) => (
        <li key={i}>
          <a href={x.url} target="_blank" rel="noopener" className="press -mx-3 block rounded-[14px] px-3 py-2.5 transition-colors hover:bg-hover">
            <div className="line-clamp-2 text-[15px] leading-[22px] font-semibold text-foreground wrap-break-word">{x.title}</div>
            <div className="mt-1 text-[13px] text-muted-foreground">{x.src} · {timeAgo(x.ts * 1000)}</div>
          </a>
        </li>
      ))}
    </ul>
  );
}

// '미친' 호재·악재만 칸을 물들인다 (뉴스 화면 카드와 같은 비율)
const HOT_UP = 'bg-[color-mix(in_srgb,var(--up)_var(--hot-a),var(--card))] ring-1 ring-inset ring-up/35';
const HOT_DOWN = 'bg-[color-mix(in_srgb,var(--down)_var(--hot-a),var(--card))] ring-1 ring-inset ring-down/35';

/** 같은 자산인가 — 코인은 업비트·바이낸스를 같은 코인으로 본다 */
function sameAsset(a: Sym, b: Sym) {
  if (a === b) return true;
  const base = (s: Sym) => { const [m, c] = split(s); return m === 'upbit' ? c.replace(/^KRW-/, '') : m === 'binance' ? c.replace(/USDT$/, '') : null; };
  const x = base(a);
  return !!x && x === base(b);
}

/** 이 종목이 관련 종목으로 붙은 코인니스 속보 (+ 호재·악재 판단) — GitHub Actions 가 10분마다 모은 정적 파일만 쓴다 (중계 요청 없음) */
function useFlashFor(sym: Sym, coin: boolean) {
  const key = coin ? 'coinflash' : 'stockflash';
  const tn = useQuery({ queryKey: ['topicNews'], queryFn: topicNews, staleTime: 5 * 60e3, refetchInterval: 5 * 60e3 });
  const ai = useQuery({ queryKey: ['newsAi'], queryFn: newsAi, staleTime: 60e3, refetchInterval: (q) => (q.state.status === 'error' ? 10 * 60e3 : 2 * 60e3), retry: 0 });
  const namesV = useNamesVersion(); // 이름표가 늦게 와도 찾게
  // 주식 속보는 회사 이름으로 찾으니 국내·미국 종목 이름표가 필요하다 (정적 파일)
  useEffect(() => { if (!coin) void loadStaticStocks(); }, [coin]);
  return useMemo(() => {
    const items = tn.data?.topics?.find((t) => t.key === key)?.items || [];
    const median = medianVotes(items), tags = ai.data?.tags;
    const out: { x: NewsItem; s: Sentiment }[] = [];
    for (const x of items) {
      const tag = tags?.[aiKey(key, x)];
      if (!relatedOf(x, coin ? 'coin' : 'stock', tag, 6).some((r) => sameAsset(r.sym, sym))) continue;
      out.push({ x, s: sentimentOf(x, median, tag, VOTE_NEUTRAL[key]) });
      if (out.length >= 4) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tn.data, ai.data, sym, key, coin, namesV]);
}

/** 속보 한 줄 판단 근거 — AI 이유, 투표, 키워드 */
function shortReason(s: Sentiment) {
  if (s.basis === 'ai') return s.reason ? `AI · ${s.reason}` : 'AI 판단';
  if (s.basis === 'votes' && s.bullPct != null) {
    const bull = s.bullPct >= 0.5;
    return `투표 ${bull ? '호재' : '악재'} ${Math.round((bull ? s.bullPct : 1 - s.bullPct) * 100)}%`;
  }
  if (s.basis === 'keywords') return '키워드로 추정';
  return '';
}

function FlashList({ rows, coin }: { rows: { x: NewsItem; s: Sentiment }[]; coin: boolean }) {
  return (
    <section className="mb-3" aria-label="코인니스 속보">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-muted-foreground">코인니스 속보 · 호재·악재</h3>
        <a href={href('news', coin ? 'coinflash' : 'stockflash')} className="text-[13px] font-semibold text-muted-foreground hover:text-foreground">뉴스에서 보기</a>
      </div>
      <ul className="space-y-1">
        {rows.map(({ x, s }) => {
          const level = s.basis === 'none' ? 0 : s.level;
          const badge = s.basis !== 'none' && (level !== 0 || s.basis === 'ai');
          const why = shortReason(s);
          return (
            <li key={x.id || x.url}>
              {/* 물들임은 '미친' 단계(±2)만 — 호재·악재는 배지만 */}
              <a href={x.url} target="_blank" rel="noopener"
                className={cn('press -mx-3 block rounded-[14px] px-3 py-2.5 transition-colors', level === 2 ? HOT_UP : level === -2 ? HOT_DOWN : 'hover:bg-hover')}>
                {badge ? <LevelBadge level={level} className="mb-1 h-5 px-1.5 text-[12px]" /> : null}
                <div className="line-clamp-2 text-[15px] leading-[22px] font-semibold text-foreground wrap-break-word">{x.title}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
                  <span className="shrink-0 tabular">{timeAgo(x.ts * 1000)}</span>
                  {why ? <><span aria-hidden>·</span>{s.basis === 'ai' ? <Sparkles aria-hidden className="size-3 shrink-0 text-ai" /> : null}<span className="truncate">{why}</span></> : null}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 종목 뉴스 — 주식은 네이버(중계 필요), 코인은 수집된 코인 뉴스. 위에는 이 종목이 붙은 코인니스 속보를 호재·악재 판단과 함께 */
export function NewsPanel({ sym, market }: { sym: Sym; market: Market }) {
  const { ok } = useRelay();
  const coin = MARKETS[market].coin;
  const { data, isLoading, isError } = useQuery({ queryKey: ['symnews', sym], queryFn: () => symbolNews(sym), enabled: coin || ok, staleTime: 5 * 60e3 });
  const flash = useFlashFor(sym, coin);
  const flashList = flash.length ? <FlashList rows={flash} coin={coin} /> : null;
  if (!coin && !ok) return <>{flashList}<p className="py-6 text-center text-[14px] text-muted-foreground">종목 뉴스는 실시간 중계가 연결되면 보여요.</p></>;
  if (isLoading) return <>{flashList}<div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full bg-secondary" />)}</div></>;
  if (isError || !data) return <>{flashList}<p className="py-6 text-center text-[14px] text-muted-foreground">뉴스를 불러오지 못했어요.</p></>;
  if (!data.length) return <>{flashList}<p className="py-6 text-center text-[14px] text-muted-foreground">최근 뉴스가 없어요.</p></>;
  return (
    <>
      {flashList}
      {data.general && <p className="mb-1 text-[13px] text-muted-foreground">이 코인만의 뉴스가 적어 코인 주요 뉴스를 보여 드려요.</p>}
      {flashList ? <h3 className="mt-1 text-[13px] font-semibold text-muted-foreground">기사</h3> : null}
      <NewsList items={data} />
    </>
  );
}
