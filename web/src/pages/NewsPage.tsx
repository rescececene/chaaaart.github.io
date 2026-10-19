// 뉴스 — 코인 속보 · 주식 속보 · 해외 속보는 중계로 30초마다(화면이 보일 때만), 나머지 주제는 GitHub Actions 가 10분마다 모은 news.json.
// 코인·주식 속보는 호재·악재를 판단해 카드 바탕을 물들인다: AI 판단(news_ai.json, 2분마다 확인) → 이용자 투표 → 키워드 순.
// 해외 속보는 판단하지 않고 관련 종목만 붙인다. 주제는 #/news/<주제> 로 연다.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ArrowUpRight, Newspaper, Sparkles } from 'lucide-react';
import type { PageProps } from '@/App';
import { CARD_CLS, Empty, EMPTY_BTN, PageTitle } from '@/components/common/Card';
import { Chip } from '@/components/common/Segmented';
import { LiveBadge } from '@/components/common/Status';
import { CardSkeletons, clockLabel, NewsCard } from '@/components/news/NewsCard';
import { countMentions, LatestElsewhere, MentionStrip, TopicTabs, TopMentions, uniqItems } from '@/components/news/NewsFeed';
import { useInterval, useNamesVersion, useRelay, useWant } from '@/hooks/market';
import { timeAgo } from '@/lib/format';
import { aiKey, googleNewsUrl, LIVE_TOPICS, loadStaticStocks, newsAi, split, Store, topicNews, type NewsItem, type Sym } from '@/lib/market';
import { medianVotes, relatedOf, sentimentOf, VOTE_NEUTRAL, type FeedKind, type Related, type Sentiment } from '@/lib/newsTag';
import { navigate } from '@/lib/router';

// 주제별 출처와 '더 보기' 주소 — 수집기(collector/collect.py)와 같은 출처. q 는 Google 뉴스 검색어
const META: Record<string, { q?: string; site?: string; url?: string }> = {
  world: { site: '네이버 증권', url: 'https://m.stock.naver.com/investment/news/worldnews' },
  coinflash: { site: '코인니스', url: 'https://coinness.com/news' },
  stockflash: { site: '코인니스', url: 'https://coinness.com/stock-news' },
  us: { q: '뉴욕증시 OR 나스닥 OR 미국 증시' },
  krx: { q: '코스피 OR 코스닥' },
  coin: { q: '비트코인 OR 가상자산 OR 이더리움' },
  macro: { q: '환율 OR 금리 OR 연준' },
};
const siteOf = (key: string) => META[key]?.site ?? 'Google 뉴스';
function moreLink(key: string, label: string) {
  const m = META[key];
  if (m?.url) return { url: m.url, text: `${m.site}에서 ‘${label}’ 더 보기` };
  return { url: googleNewsUrl(m?.q ?? label), text: `Google 뉴스에서 ‘${label}’ 더 보기` };
}
const GOOGLE_ECON = 'https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtdHZHZ0pMVWlnQVAB?hl=ko&gl=KR&ceid=KR:ko';

/** 속보 세 주제는 데이터가 늦어도 늘 맨 앞에 (중계로 바로 받을 수 있다) */
const FIRST = [{ key: 'coinflash', label: '코인 속보' }, { key: 'stockflash', label: '주식 속보' }, { key: 'world', label: '해외 속보' }];
/** AI 판단이 붙는 주제 (해외 속보는 AI 로 판단하지 않는다) */
const AI_TOPICS = new Set(['coinflash', 'stockflash']);
/** 호재·악재를 아예 판단하지 않는 주제 — 관련 종목만 */
const NO_JUDGE = new Set(['world']);
const KIND: Record<string, FeedKind> = { coinflash: 'coin', coin: 'coin', stockflash: 'stock', world: 'stock', us: 'stock', krx: 'stock', macro: 'stock' };
/** 관련 종목 실시간 시세를 받는 최대 종목 수 — 코인은 거래소 웹소켓이라 넉넉히, 주식은 중계로 20개씩 묶어 받으니
 *  시장(국내·미국)마다 20개까지만 (한 번 새로 받을 때 시장마다 중계 요청 하나) */
const WANT_CAP = { coin: 60, krx: 20, us: 20 } as const;
type Filter = 'all' | 'bull' | 'bear';
interface Row { x: NewsItem; s: Sentiment | null; related: Related[] }
const levelOf = (r: Row) => (r.s && r.s.basis !== 'none' ? r.s.level : 0);

/** 회색 바탕 위 보조 버튼 — 카드색 바탕 */
function GoogleEconLink() {
  return (
    <a href={GOOGLE_ECON} target="_blank" rel="noopener"
      className="press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-card px-3 text-[14px] font-semibold text-secondary-foreground hover:bg-hover">
      구글 뉴스 경제<ArrowUpRight className="size-4 text-muted-foreground" aria-hidden />
    </a>
  );
}

export default function NewsPage({ args }: PageProps) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['topicNews'], queryFn: topicNews, staleTime: 5 * 60e3, refetchInterval: 5 * 60e3,
  });
  // '3분 전' 같은 상대 시각을 1분마다 새로 (탭이 보일 때만)
  const [, setTick] = useState(0);
  useInterval(() => setTick((t) => t + 1), 60_000);
  const { ok: relayOk } = useRelay();
  const namesV = useNamesVersion(); // 코인·주식 이름표가 늦게 와도 관련 종목이 생기게
  // 국내·미국 종목 이름표 (정적 파일 — 기사 속 회사 이름·AI 가 고른 종목을 찾는 데 쓴다. 중계 요청 없음)
  useEffect(() => { void loadStaticStocks(); }, []);
  const [filter, setFilter] = useState<Filter>('all');

  const topics = data?.topics?.length ? data.topics : null;
  const tabs = useMemo(() => [
    ...FIRST,
    ...(topics || []).filter((t) => !FIRST.some((f) => f.key === t.key)).map((t) => ({ key: t.key, label: t.label })),
  ], [topics]);
  const want = args[0] || Store.get<string>('ml.newsT', 'coinflash');
  // 주제 목록이 오기 전엔 주소의 주제를 그대로 둔다 (Google 뉴스 주제는 news.json 이 와야 안다)
  const key = tabs.some((t) => t.key === want) || (!topics && isLoading) ? want : tabs[0].key;
  const topic = topics?.find((t) => t.key === key);
  const label = tabs.find((t) => t.key === key)?.label ?? topic?.label ?? '';
  const judge = !NO_JUDGE.has(key);
  const aiOn = AI_TOPICS.has(key);

  // 속보 주제는 중계로 바로 — 30초마다, 탭이 숨겨지면 멈추고 돌아오면 바로 새로 (실패하면 조용히 10분 단위 데이터로)
  const liveFn = relayOk ? LIVE_TOPICS[key] : undefined;
  const live = useQuery({
    queryKey: ['newsLive', key], queryFn: () => liveFn!(), enabled: !!liveFn,
    refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, staleTime: 20_000, retry: 0,
  });
  // AI 판단 — 정적 파일이라 중계 요청과 상관없다. GitHub Actions 가 10분마다 새로 만든다
  const ai = useQuery({
    queryKey: ['newsAi'], queryFn: newsAi, enabled: aiOn,
    // 파일이 없으면(AI 설정 전) 10분에 한 번만 다시 본다
    refetchInterval: (q) => (q.state.status === 'error' ? 10 * 60e3 : 2 * 60e3), refetchIntervalInBackground: false, staleTime: 60e3, retry: 0,
  });
  const tags = aiOn ? ai.data?.tags : undefined;

  const liveItems = liveFn && live.data?.length ? live.data : null;
  const items = useMemo(() => uniqItems(liveItems ?? topic?.items ?? []), [liveItems, topic]);
  const rows = useMemo<Row[]>(() => {
    const median = medianVotes(items), neutral = VOTE_NEUTRAL[key] ?? 0.5, kind = KIND[key] ?? 'mixed';
    return items.map((x) => {
      const tag = tags ? tags[aiKey(key, x)] : undefined;
      return { x, s: judge ? sentimentOf(x, median, tag, neutral) : null, related: relatedOf(x, kind, tag, 3) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, key, tags, judge, namesV]);
  const nBull = rows.filter((r) => levelOf(r) > 0).length;
  const nBear = rows.filter((r) => levelOf(r) < 0).length;
  const nAi = rows.filter((r) => r.s?.basis === 'ai').length;
  const f: Filter = judge ? filter : 'all';
  const shown = useMemo(() => (f === 'bull' ? rows.filter((r) => levelOf(r) > 0) : f === 'bear' ? rows.filter((r) => levelOf(r) < 0) : rows), [rows, f]);
  const mentions = useMemo(() => countMentions(rows, 8), [rows]);
  // 실시간 시세는 많이 나온 종목 → 보이는 기사 순으로, 시장마다 WANT_CAP 개까지만 (나머지 주식은 10분 단위 시세로)
  const wantSyms = useMemo(() => {
    const out = new Set<Sym>(), n = { coin: 0, krx: 0, us: 0 };
    const add = (sym: Sym) => {
      const m = split(sym)[0], k = m === 'krx' || m === 'us' ? m : 'coin';
      if (out.has(sym) || n[k] >= WANT_CAP[k]) return;
      n[k]++;
      out.add(sym);
    };
    for (const m of mentions) add(m.sym);
    for (const r of shown) for (const o of r.related) add(o.sym);
    return [...out];
  }, [mentions, shown]);
  useWant(wantSyms.length ? wantSyms : null);

  const more = moreLink(key, label);
  const pick = (k: string) => navigate('news', k);
  useEffect(() => { if (topics || FIRST.some((t) => t.key === key)) Store.set('ml.newsT', key); }, [topics, key]);
  useEffect(() => { document.title = label ? `뉴스 · ${label} — 마켓` : '뉴스 — 마켓'; }, [label]);
  useEffect(() => () => { document.title = '마켓'; }, []);

  // 머리 아래 줄: 지금 주제의 출처와 얼마나 새것인지
  const updated = data?.updatedAt ? Date.parse(data.updatedAt) : NaN;
  let sub: ReactNode;
  if (liveItems) sub = <>{siteOf(key)}<span aria-hidden>·</span><LiveBadge state="live" className="text-[14px] font-medium sm:text-[15px]" /></>;
  else if (topic && Number.isFinite(updated)) sub = <span title={`${clockLabel(updated)} 수집`}>{siteOf(key)} · {timeAgo(updated)} 수집</span>;
  else sub = isLoading || live.isLoading ? '불러오는 중…' : siteOf(key);

  const aiAt = ai.data?.updatedAt ? Date.parse(ai.data.updatedAt) : NaN;
  // AI 판단 파일이 최근(1시간 안)에 만들어졌으면 AI 가 돌고 있다 — 그 뒤로 올라온 새 기사는 다음 판단 때 본다
  const aiRunning = aiOn && !!tags && Number.isFinite(aiAt) && Date.now() - aiAt < 60 * 60e3;
  const aiPending = (r: Row) => {
    const k = aiKey(key, r.x);
    return aiRunning && !!k && !!tags && !(k in tags) && (r.x.ts || 0) * 1000 > Math.max(aiAt - 10 * 60e3, Date.now() - 40 * 60e3);
  };
  let note: string;
  if (!judge) note = '해외 속보는 호재·악재를 판단하지 않고, 관련 종목만 보여 드려요.';
  else if (aiOn && (tags || ai.isLoading)) note = 'AI가 기사마다 호재·악재를 판단해요. AI가 아직 보지 않은 새 기사는 이용자 투표나 키워드로 추정해요.';
  else if (aiOn) note = '이용자 투표나 제목·요약의 단어로 호재·악재를 추정해요. 참고만 해 주세요.';
  else note = '제목에 쓰인 단어로 호재·악재를 추정해요. 참고만 해 주세요.';

  let body: ReactNode;
  const pending = !items.length && (isLoading || (!!liveFn && live.isLoading));
  if (pending) body = <CardSkeletons />;
  else if (!items.length && (isError || live.isError)) {
    body = (
      <div className={CARD_CLS}>
        <Empty icon={<Newspaper />} title="뉴스를 불러오지 못했어요"
          action={<button onClick={() => { void refetch(); if (liveFn) void live.refetch(); }} disabled={isFetching || live.isFetching} className={EMPTY_BTN}>{isFetching || live.isFetching ? '다시 불러오는 중…' : '다시 시도'}</button>}>
          인터넷 연결을 확인하고 다시 시도해 주세요
        </Empty>
      </div>
    );
  } else if (!items.length) {
    body = <div className={CARD_CLS}><Empty icon={<Newspaper />} title="이 주제의 뉴스가 아직 없어요">10분마다 새로 모아요. 잠시 뒤 다시 확인해 주세요</Empty></div>;
  } else if (!shown.length) {
    body = (
      <div className={CARD_CLS}>
        <Empty icon={<Newspaper />} title={`${f === 'bull' ? '호재' : '악재'}로 본 기사가 없어요`}
          action={<button onClick={() => setFilter('all')} className={EMPTY_BTN}>전체 뉴스 보기</button>}>
          지금 불러온 {label} 중에는 {f === 'bull' ? '호재' : '악재'}로 본 기사가 없어요
        </Empty>
      </div>
    );
  } else {
    body = (
      <motion.div key={key} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
        <ul className="space-y-2" aria-label={`${label} 뉴스`}>
          {shown.map((r) => <NewsCard key={r.x.id || r.x.url || r.x.title} item={r.x} s={r.s} related={r.related} aiPending={aiPending(r)} />)}
        </ul>
        <a href={more.url} target="_blank" rel="noopener"
          className={`${CARD_CLS} press mt-2 flex h-12 w-full items-center justify-center gap-1 px-4 text-[14px] font-semibold text-secondary-foreground hover:bg-hover`}>
          <span className="truncate">{more.text}</span><ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </a>
      </motion.div>
    );
  }

  return (
    <>
      <PageTitle sub={sub} right={<GoogleEconLink />}>뉴스</PageTitle>
      <div className="grid items-start gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-4">
        <div className="min-w-0 space-y-2">
          <section className={`${CARD_CLS} px-4 pt-0.5 pb-3.5 sm:px-5 md:px-6 md:pb-[18px]`} aria-label="뉴스 주제와 거르기">
            <TopicTabs tabs={tabs} value={key} onChange={pick} className="-mx-4 sm:-mx-5 md:-mx-6" listClassName="px-4 sm:px-5 md:px-6" />
            {judge && items.length ? (
              <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div role="group" aria-label="호재·악재로 거르기" className="flex min-w-0 gap-2">
                  <Chip on={f === 'all'} onClick={() => setFilter('all')}>전체 <span className="tabular">{rows.length}</span></Chip>
                  <Chip on={f === 'bull'} tone="up" disabled={!nBull} onClick={() => setFilter('bull')}>호재 <span className="tabular">{nBull}</span></Chip>
                  <Chip on={f === 'bear'} tone="down" disabled={!nBear} onClick={() => setFilter('bear')}>악재 <span className="tabular">{nBear}</span></Chip>
                </div>
                {aiOn && nAi && Number.isFinite(aiAt) ? (
                  <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground tabular sm:ml-auto" title={`AI 판단 ${clockLabel(aiAt)} 갱신 · 불러온 ${rows.length}개 중 ${nAi}개`}>
                    <Sparkles className="size-3.5 text-ai" aria-hidden />AI 판단 {nAi}개 · {timeAgo(aiAt)}
                  </span>
                ) : null}
              </div>
            ) : null}
            <MentionStrip mentions={mentions} className="mt-3.5 lg:hidden" />
            <p className="mt-3 text-[12.5px] leading-[1.6] text-muted-foreground">{note}</p>
          </section>
          {body}
        </div>
        <aside className="sticky top-20 hidden space-y-4 lg:block">
          <TopMentions mentions={mentions.slice(0, 5)} label={label} total={items.length} judged={judge} />
          {/* 따라 내려오는 칸이 화면보다 길어지지 않게 — 세로가 넉넉한 화면에서만 다른 주제 새 소식도 */}
          {topics ? <div className="hidden [@media(min-height:1060px)]:block"><LatestElsewhere topics={topics} current={key} limit={3} /></div> : null}
        </aside>
      </div>
    </>
  );
}
