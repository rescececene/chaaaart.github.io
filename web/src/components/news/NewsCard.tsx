// 뉴스 카드 — 호재·악재 정도에 따라 카드 바탕이 물든다 (미친 호재는 확실히 빨갛게, 미친 악재는 확실히 파랗게).
// 색만으로 구분하지 않도록 언제나 글자 배지를 붙이고, 판단 근거(AI 이유 · 이용자 투표 · 키워드)를 한 줄로 밝힌다.
import { memo, useSyncExternalStore } from 'react';
import { Sparkles } from 'lucide-react';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText } from '@/components/common/Change';
import { Skeleton } from '@/components/ui/skeleton';
import { useNamesVersion, useQuote } from '@/hooks/market';
import { timeAgo } from '@/lib/format';
import { nameOf, remember, split, type NewsItem } from '@/lib/market';
import type { Level, Related, Sentiment } from '@/lib/newsTag';
import { href } from '@/lib/router';
import { cn } from '@/lib/utils';

const pad = (n: number) => String(n).padStart(2, '0');
/** 10월 19일 20:35 (이 기기 시각) */
export function clockLabel(ms: number) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 1분마다 한 번 바뀌는 값 — 카드가 memo 라 데이터가 그대로면 다시 그리지 않으니, '3분 전'은 이걸 구독해 스스로 새로 그린다.
// 타이머는 하나만, 구독하는 곳이 있고 탭이 보일 때만 돈다
let minute = Math.floor(Date.now() / 60e3);
const minuteSubs = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
function subscribeMinute(cb: () => void) {
  minuteSubs.add(cb);
  minuteTimer ??= setInterval(() => {
    const m = Math.floor(Date.now() / 60e3);
    if (document.hidden || m === minute) return;
    minute = m;
    minuteSubs.forEach((f) => f());
  }, 10e3);
  return () => {
    minuteSubs.delete(cb);
    if (!minuteSubs.size && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  };
}
export const useMinute = () => useSyncExternalStore(subscribeMinute, () => minute);

/** 출처 · 3시간 전 — 시각에 마우스를 올리면 정확한 시각 */
export function Meta({ item, className }: { item: NewsItem; className?: string }) {
  useMinute();
  const ms = item.ts ? item.ts * 1000 : 0;
  const ago = ms ? timeAgo(ms) : '';
  return (
    <p className={cn('flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground', className)}>
      {item.src ? <span className="truncate">{item.src}</span> : null}
      {item.src && ago ? <span aria-hidden className="text-faint">·</span> : null}
      {ago ? <time className="shrink-0 tabular" dateTime={new Date(ms).toISOString()} title={clockLabel(ms)}>{ago}</time> : null}
    </p>
  );
}

// 카드 바탕 — 카드색에 상승·하락 색을 섞는다 (다크 모드에서도 카드색 기준이라 자연스럽다)
export const CARD_TONE: Record<Level, string> = {
  2: 'bg-[color-mix(in_oklab,var(--up)_15%,var(--card))] ring-1 ring-inset ring-up/45',
  1: 'bg-[color-mix(in_oklab,var(--up)_6.5%,var(--card))]',
  0: 'bg-card',
  [-1]: 'bg-[color-mix(in_oklab,var(--down)_6.5%,var(--card))]',
  [-2]: 'bg-[color-mix(in_oklab,var(--down)_15%,var(--card))] ring-1 ring-inset ring-down/45',
} as Record<Level, string>;
// 배지 — '미친' 단계는 꽉 찬 색(흰 글자 대비 4.5:1 이상인 진한 빨강·파랑을 두 테마 모두에 쓴다)
const BADGE_TONE: Record<Level, string> = {
  2: 'bg-[#e02b3a] text-white',
  1: 'bg-up-soft text-up-text',
  0: 'bg-secondary text-muted-foreground',
  [-1]: 'bg-down-soft text-down-text',
  [-2]: 'bg-[#1b64da] text-white',
} as Record<Level, string>;
const BADGE_TEXT: Record<Level, string> = { 2: '🔥 미친 호재', 1: '호재', 0: '중립', [-1]: '악재', [-2]: '💥 미친 악재' } as Record<Level, string>;

export function LevelBadge({ level, className }: { level: Level; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[12.5px] font-bold whitespace-nowrap', Math.abs(level) === 2 && 'px-2.5 text-[13px] font-extrabold', BADGE_TONE[level], className)}>
      {BADGE_TEXT[level]}
    </span>
  );
}

/** 호재·악재 표 비율 막대 (빨강 = 호재, 파랑 = 악재) */
export function VoteBar({ bullPct, className }: { bullPct: number; className?: string }) {
  const p = Math.round(Math.min(1, Math.max(0, bullPct)) * 100);
  return (
    <span aria-hidden className={cn('flex h-1 w-16 shrink-0 overflow-hidden rounded-full bg-down', className)}>
      <span className="h-full bg-up" style={{ width: `${p}%` }} />
    </span>
  );
}

/** 투표 호재 72% · 384명 — 많은 쪽을 앞세운다.
 *  투표로 정했는데 한쪽으로 기운 채 중립이면 이유를 붙인다: 이 피드에선 흔한 쏠림(평소 수준)이거나, 표가 아직 적거나 */
function VoteLine({ s, sub }: { s: Sentiment; sub?: boolean }) {
  if (s.bullPct == null || !s.votes) return null;
  const bull = s.bullPct >= 0.5, pct = Math.round((bull ? s.bullPct : 1 - s.bullPct) * 100);
  const bullN = Math.round(s.bullPct * s.votes);
  let why: { text: string; title: string } | null = null;
  if (s.basis === 'votes' && s.level === 0 && s.base != null && Math.abs(s.bullPct - 0.5) >= 0.1) {
    const base = Math.round(s.base * 100);
    why = s.bullPct <= s.base + 0.12 && s.bullPct >= s.base - 0.1
      ? { text: '평소 수준', title: `이 속보의 투표는 평소에도 호재가 ${base}% 안팎이에요. 그보다 뚜렷하게 기울 때만 호재·악재로 봐요.` }
      : { text: '표가 더 필요해요', title: '표가 적어 한쪽으로 기운 게 우연일 수 있어요. 표가 더 모이면 판단해요.' };
  }
  return (
    <p className={cn('flex items-center gap-2 tabular', sub ? 'text-[12.5px] text-muted-foreground' : 'mt-2.5 text-[13.5px] text-secondary-foreground', sub && (s.basis === 'ai' ? 'mt-1' : 'mt-2'))}
      title={`코인니스 이용자 투표 — 호재 ${bullN}표 · 악재 ${s.votes - bullN}표`}>
      <span className="min-w-0 truncate">
        투표 <span className={cn('font-semibold', bull ? 'text-up-text' : 'text-down-text')}>{bull ? '호재' : '악재'} {pct}%</span>
        <span className="text-faint"> · </span>{s.votes.toLocaleString('ko-KR')}명
        {why ? <><span className="text-faint"> · </span><span className="text-subtle" title={why.title}>{why.text}</span></> : null}
      </span>
      <VoteBar bullPct={s.bullPct} />
    </p>
  );
}

/** 칩에 쓸 짧은 이름 — 'AMD(어드밴스드 마이크로 디바이시스)' → 'AMD' (전체가 길고 괄호 밖이 남을 때만) */
export function shortName(name: string) {
  if (name.length <= 12) return name;
  const outer = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  return outer.length >= 2 ? outer : name;
}

/** 판단 근거 한두 줄 — AI 이유 (+ 투표가 있으면 참고로), 투표, 또는 키워드.
 *  aiPending: AI 가 다음 판단 때 볼 새 기사 — 다른 근거도 없으면 'AI 판단 전'이라고만 적는다 */
export function Reason({ s, aiPending }: { s: Sentiment; aiPending?: boolean }) {
  if (s.basis === 'ai') {
    return (
      <>
        <p className="mt-2.5 flex items-start gap-1.5 text-[13.5px] leading-[1.5] break-keep wrap-break-word">
          <Sparkles aria-hidden className="mt-[3px] size-3.5 shrink-0 text-chart-5" />
          <span className="min-w-0">
            <span className="font-semibold text-foreground">AI 판단</span>
            <span className="text-faint"> · </span>
            <span className="text-secondary-foreground">{s.reason || `${s.label}${s.level === 0 ? '으로' : '로'} 봤어요`}</span>
          </span>
        </p>
        <VoteLine s={s} sub />
      </>
    );
  }
  if (s.basis === 'votes') return <VoteLine s={s} sub={s.level === 0} />;
  if (s.basis === 'keywords') {
    const words = [...(s.pos || []).map((w) => ['+', w, 'text-up-text'] as const), ...(s.neg || []).map((w) => ['−', w, 'text-down-text'] as const)].slice(0, 4);
    return (
      <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-subtle" title="AI 판단·투표가 아직 없어 제목·요약의 단어로 추정했어요">
        <span>키워드로 추정</span>
        {words.map(([sign, w, cls]) => <span key={sign + w} className={cn('font-semibold', cls)}>{sign}{w}</span>)}
        {aiPending ? <><span aria-hidden className="text-faint">·</span><span>AI 판단 전</span></> : null}
      </p>
    );
  }
  if (aiPending) {
    return (
      <p className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-subtle" title="AI가 10분쯤마다 새 기사를 판단해요. 판단이 나오면 이 자리에 이유가 보여요.">
        <Sparkles aria-hidden className="size-3.5 shrink-0 text-faint" />AI 판단 전이에요
      </p>
    );
  }
  return null;
}

/** 관련 종목 칩 — 누르면 차트로. 자기 종목 시세만 구독한다. 이름은 앱이 아는 한글 이름 우선(없으면 기사에 붙은 이름·티커).
 *  바탕은 반투명이라 물든 카드 위에서도 어울린다 */
export const RelatedChip = memo(function RelatedChip({ sym, name }: Related) {
  useNamesVersion();
  const q = useQuote(sym);
  const code = split(sym)[1], known = nameOf(sym).name;
  const label = shortName(known && known !== code ? known : name || code);
  return (
    <a href={href('chart', sym)} onClick={() => { if (name && known === code) remember(sym, { name }); }}
      className="press inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.055] pr-3 pl-1 text-[13px] font-semibold text-secondary-foreground hover:bg-foreground/[0.1]">
      <SymbolLogo sym={sym} size={24} />
      <span className="truncate">{label}</span>
      {q?.chg != null ? <ChangeText value={q.chg} className="text-[12.5px]" /> : null}
    </a>
  );
});

/** 요약 앞의 '바르샤바, 10월 19일 (로이터) -'·'10월 19일 (The Insurer) -' 머리말, '**' 표시, 뒤에 붙는 '원문:'·'DISCLAIMER' 안내문은 읽기에 방해라 뺀다.
 *  해외 속보 요약은 160자에서 잘려 오니, 문장 중간에서 끊겼으면 마지막 어절을 덜어 내고 '…'를 붙인다 */
export function cleanSummary(raw: string) {
  let s = raw
    .replace(/^\s*(?:[^,]{1,24},\s*)?\d{1,2}월\s?\d{1,2}일\s?\([^()]{1,30}\)\s?[-–—]\s?/, '')
    .replace(/^\s*\((?:로이터|Reuters|AP|AFP|블룸버그|Bloomberg)\)\s?[-–—]\s?/i, '')
    .replace(/\*{2,}/g, ' ')
    .replace(/^\s*\*+\s*/, '')
    .replace(/\s*(?:원문\s?:|원문 바로가기|DISCLAIMER).*$/i, '')
    // 로이터 단신: '-- 출처 링크: https://… -- 참고: 로이터는 이 기사의 내용을 확인하지 않았으며 …'
    .replace(/-{2,}\s*출처\s?링크\s?:\s*\S+\s*-*/g, ' ')
    .replace(/\s*-*\s*참고\s?:\s*로이터는\s.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // 잘린 원문의 끝이 정리 뒤에도 남아 있을 때만 (안내문을 덜어 낸 요약엔 붙이지 않는다)
  const r = raw.trim();
  if (s.length >= 20 && r.length >= 150 && r.endsWith(s.slice(-8)) && !/[.!?…。"'”’)\]]$/.test(s)) {
    const cut = s.replace(/\s*\S*$/, '').replace(/[,·\s]+$/, '');
    s = (cut.length >= 20 ? cut : s) + '…';
  }
  return s;
}

/** 기사 카드 — 제목 링크가 카드 전체를 덮고(새 창), 관련 종목 칩만 그 위에 따로 눌린다. 읽은 기사는 제목이 옅어진다.
 *  s 가 없으면(해외 속보) 호재·악재를 판단하지 않은 카드. aiPending: AI 가 아직 보지 않은 새 기사 */
export const NewsCard = memo(function NewsCard({ item, s, related, aiPending }: { item: NewsItem; s: Sentiment | null; related: Related[]; aiPending?: boolean }) {
  const summary = item.summary ? cleanSummary(item.summary) : '';
  const level: Level = s && s.basis !== 'none' ? s.level : 0;
  // 배지: 호재·악재로 본 기사는 언제나, 중립은 AI 가 직접 중립이라고 판단했을 때만 (투표·키워드 중립은 조용히)
  const badge = !!s && s.basis !== 'none' && (level !== 0 || s.basis === 'ai');
  return (
    <li>
      <article className={cn('relative rounded-[20px] p-4 transition-shadow hover:shadow-[0_2px_14px_rgba(0,0,0,0.07)] motion-safe:has-[.row-link:active]:scale-[0.99] md:p-5', CARD_TONE[level])}>
        <div className="flex min-w-0 items-center gap-1.5">
          {badge ? <LevelBadge level={level} /> : null}
          {item.important ? <span className="inline-flex h-6 shrink-0 items-center rounded-md bg-foreground px-1.5 text-[12px] font-bold text-background">중요</span> : null}
          <Meta item={item} className={cn('min-w-0', (badge || item.important) && 'ml-auto pl-2')} />
        </div>
        <h3 className="mt-2 line-clamp-3 text-[16.5px] leading-[1.45] font-bold tracking-[-0.02em] break-keep wrap-break-word md:text-[17px]">
          <a href={item.url} target="_blank" rel="noopener"
            className="row-link text-foreground outline-none visited:text-muted-foreground after:absolute after:inset-0 after:rounded-[20px] focus-visible:after:ring-2 focus-visible:after:ring-ring">
            {item.title}
          </a>
        </h3>
        {summary ? <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.55] text-muted-foreground break-keep wrap-break-word">{summary}</p> : null}
        {s ? <Reason s={s} aiPending={aiPending} /> : null}
        {related.length ? (
          <div className="relative z-10 mt-3 flex flex-wrap gap-1.5">
            {related.map((r) => <RelatedChip key={r.sym} sym={r.sym} name={r.name} />)}
          </div>
        ) : null}
      </article>
    </li>
  );
});

export function CardSkeletons({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="rounded-[20px] bg-card p-4 md:p-5">
          <div className="flex items-center gap-2"><Skeleton className="h-6 w-12" /><Skeleton className="ml-auto h-3.5 w-24" /></div>
          <Skeleton className="mt-3 h-[18px] w-[92%]" />
          <Skeleton className={cn('mt-2 h-[18px]', i % 2 ? 'w-[46%]' : 'w-[68%]')} />
          <Skeleton className="mt-3 h-3.5 w-40" />
        </li>
      ))}
    </ul>
  );
}
