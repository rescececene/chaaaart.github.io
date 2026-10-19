// 뉴스 화면 부품 — 주제 탭, PC 오른쪽 '지금 뉴스에 많이 나온 종목'·'다른 주제 새 소식'
import { memo, useEffect, useMemo, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { UnderlineTabs } from '@/components/common/Segmented';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { useNamesVersion, useQuote } from '@/hooks/market';
import { nameOf, split, type NewsItem, type NewsTopic, type Sym } from '@/lib/market';
import type { Related, Sentiment } from '@/lib/newsTag';
import { href } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Meta, shortName } from './NewsCard';

/** 같은 기사가 두 번 오면 하나만, 그리고 새것부터 (시각이 같으면 받은 순서 그대로) */
export function uniqItems<T extends NewsItem>(items: T[]): T[] {
  const seen = new Set<string>();
  return items
    .filter((x) => { const k = x.url || x.title; return !!x.title && !seen.has(k) && !!seen.add(k); })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/** 주제 밑줄 탭 — 휴대폰에서 가로로 밀어 보고, 고른 탭이 가려져 있으면 보이는 곳으로 끌어온다 */
export function TopicTabs({ tabs, value, onChange, className, listClassName }: {
  tabs: { key: string; label: string }[]; value: string; onChange: (key: string) => void; className?: string; listClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>('[role="tablist"]');
    const el = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !el) return;
    const rr = row.getBoundingClientRect(), er = el.getBoundingClientRect();
    const gap = 24, l = er.left - rr.left + row.scrollLeft, r = l + er.width;
    let left: number | null = null;
    if (l - gap < row.scrollLeft) left = l - gap;
    else if (r + gap > row.scrollLeft + row.clientWidth) left = r + gap - row.clientWidth;
    if (left != null) row.scrollTo({ left: Math.max(0, left), behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [value, tabs.length]);
  return (
    <div ref={ref} className={cn('border-b border-border', className)} aria-label="뉴스 주제">
      <UnderlineTabs items={tabs.map((t) => ({ value: t.key, label: t.label }))} value={value} onChange={onChange} className={listClassName} />
    </div>
  );
}

export interface Mention { sym: Sym; name?: string; n: number; bull: number; bear: number }
/** 지금 불러온 기사들에 관련 종목으로 많이 붙은 순 (같은 수면 더 최근 기사에 나온 것 먼저) */
export function countMentions(rows: { s: Sentiment | null; related: Related[] }[], limit = 8): Mention[] {
  const m = new Map<Sym, Mention & { first: number }>();
  rows.forEach(({ s, related }, i) => {
    for (const r of related) {
      let e = m.get(r.sym);
      if (!e) m.set(r.sym, (e = { sym: r.sym, name: r.name, n: 0, bull: 0, bear: 0, first: i }));
      e.n++;
      const lv = s && s.basis !== 'none' ? s.level : 0;
      if (lv > 0) e.bull++;
      else if (lv < 0) e.bear++;
    }
  });
  return [...m.values()].sort((a, b) => b.n - a.n || a.first - b.first).slice(0, limit);
}

const MentionRow = memo(function MentionRow({ m, rank, judged }: { m: Mention; rank: number; judged: boolean }) {
  useNamesVersion();
  const q = useQuote(m.sym);
  const code = split(m.sym)[1], n = nameOf(m.sym);
  const label = shortName(n.name && n.name !== code ? n.name : m.name || code);
  const tone = [
    judged && m.bull ? <span key="b" className="text-up-text">호재 {m.bull}</span> : null,
    judged && m.bear ? <span key="r" className="text-down-text">악재 {m.bear}</span> : null,
  ].filter(Boolean);
  return (
    <li>
      <a href={href('chart', m.sym)} className="press -mx-2 flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-hover">
        <span className="w-4 shrink-0 text-center text-[14px] font-bold text-muted-foreground tabular">{rank}</span>
        <SymbolLogo sym={m.sym} size={34} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-tight font-semibold">{label}</span>
          <span className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] text-muted-foreground tabular">
            기사 {m.n}건
            {tone.map((x, i) => <span key={i} className="contents"><span aria-hidden className="text-faint">·</span>{x}</span>)}
          </span>
        </span>
        <ChangeText value={q?.chg} className="shrink-0 text-[14px] font-semibold" />
      </a>
    </li>
  );
});

/** PC 오른쪽 — 지금 이 주제 기사들에 가장 많이 나온 종목 (실시간 등락률 · 누르면 차트) */
export function TopMentions({ mentions, label, total, judged }: { mentions: Mention[]; label: string; total: number; judged: boolean }) {
  if (!mentions.length) return null;
  return (
    <section className="rounded-[20px] bg-card p-5" aria-label="지금 뉴스에 많이 나온 종목">
      <h2 className="text-[17px] font-bold tracking-tight">지금 뉴스에 많이 나온 종목</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground break-keep">{label ? `${label} ` : ''}최근 {total}개 기사 기준</p>
      <ul className="mt-2">
        {mentions.map((m, i) => <MentionRow key={m.sym} m={m} rank={i + 1} judged={judged} />)}
      </ul>
    </section>
  );
}

const MentionChip = memo(function MentionChip({ m }: { m: Mention }) {
  useNamesVersion();
  const q = useQuote(m.sym);
  const code = split(m.sym)[1], n = nameOf(m.sym);
  const label = shortName(n.name && n.name !== code ? n.name : m.name || code);
  return (
    <a href={href('chart', m.sym)}
      className="press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-secondary pr-3 pl-1 text-[13px] font-semibold text-secondary-foreground hover:bg-border/60">
      <SymbolLogo sym={m.sym} size={26} />
      <span className="max-w-[8em] truncate">{label}</span>
      <span className="text-[12px] font-medium text-muted-foreground tabular">{m.n}건</span>
      {q?.chg != null ? <ChangeText value={q.chg} className="text-[12.5px]" /> : null}
    </a>
  );
});

/** 휴대폰·태블릿 — 오른쪽 칸 대신 가로로 미는 줄 (두 번 넘게 나온 종목만) */
export function MentionStrip({ mentions, className }: { mentions: Mention[]; className?: string }) {
  const list = mentions.filter((m) => m.n >= 2);
  if (!list.length) return null;
  return (
    <div className={className}>
      <p className="text-[12.5px] font-semibold text-muted-foreground">지금 뉴스에 많이 나온 종목</p>
      <div className="no-scrollbar -mx-4 mt-1.5 flex gap-1.5 overflow-x-auto px-4 md:-mx-5 md:px-5">
        {list.map((m) => <MentionChip key={m.sym} m={m} />)}
      </div>
    </div>
  );
}

/** PC 오른쪽 — 지금 보고 있지 않은 주제들에서 가장 새로 들어온 기사 */
export function LatestElsewhere({ topics, current, limit = 5 }: { topics: NewsTopic[]; current: string; limit?: number }) {
  const rows = useMemo(() => {
    const all = topics.filter((t) => t.key !== current).flatMap((t) => t.items.slice(0, 4).map((x) => ({ x, key: t.key, label: t.label })));
    const seen = new Set<string>();
    return all
      .filter(({ x }) => { const k = x.url || x.title; return !!x.title && !seen.has(k) && !!seen.add(k); })
      .sort((a, b) => (b.x.ts || 0) - (a.x.ts || 0))
      .slice(0, limit);
  }, [topics, current, limit]);
  if (!rows.length) return null;
  return (
    <section className="rounded-[20px] bg-card p-5">
      <h2 className="text-[17px] font-bold tracking-tight">다른 주제 새 소식</h2>
      <ul className="mt-2 divide-y divide-border">
        {rows.map(({ x, key, label }) => (
          <li key={key + (x.url || x.title)} className="py-3 last:pb-0">
            <a href={href('news', key)} className="inline-flex items-center text-[12.5px] font-semibold text-muted-foreground hover:text-foreground">
              {label}<ChevronRight className="size-3.5" />
            </a>
            <a href={x.url} target="_blank" rel="noopener" className="press -mx-2 mt-0.5 block rounded-xl px-2 py-1.5 text-foreground visited:text-muted-foreground hover:bg-hover">
              <span className="line-clamp-2 text-[14px] leading-[1.45] font-semibold tracking-[-0.01em] break-keep wrap-break-word">{x.title}</span>
              <Meta item={x} className="mt-1 text-[12px]" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
