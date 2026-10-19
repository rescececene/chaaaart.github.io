// 뉴스 — 주제별은 GitHub Actions 가 모은 Google 뉴스, 종목별은 네이버 증권(중계)
// (구글 뉴스는 Cloudflare 서버 요청을 봇으로 막아서 중계로는 못 쓴다)
import { split, ymdTs } from './core';
import { nameOf } from './names';
import { Relay } from './relay';
import { staticJSON } from './staticData';
import type { NewsAi, NewsItem, Sym } from './types';

export interface NewsTopic { key: string; label: string; items: NewsItem[] }
export const topicNews = () => staticJSON<{ updatedAt: string; topics: NewsTopic[] }>('news.json', 5 * 60e3);
/** 코인·주식 속보의 AI 호재·악재 판단 — GitHub Actions 가 10분마다 Cloudflare Workers AI 로 만든다 (해외 속보는 판단하지 않는다).
 *  중계를 거치지 않는 정적 파일이라 중계 요청 수와 상관없다. 키: '<주제>:<기사 id>' */
export const newsAi = () => staticJSON<NewsAi>('news_ai.json', 2 * 60e3);
export const aiKey = (topic: string, it: NewsItem) => (it.id ? `${topic}:${it.id}` : '');

const unescapeHtml = (s: string) => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
const kstTs = (s: string) => ymdTs(s) - 9 * 3600; // 네이버 뉴스 시각(한국 시간) → 실제 epoch 초

export type SymbolNews = NewsItem[] & { general?: boolean };

async function symbolNewsRaw(sym: Sym): Promise<SymbolNews> {
  const [market, code] = split(sym);
  if (market === 'krx') {
    const d = await Relay.json<{ items?: { titleFull?: string; title: string; officeName: string; datetime: string; mobileNewsUrl?: string; officeId: string; articleId: string }[] }[]>('naver-m', `news/stock/${code}`, { pageSize: 20, page: 1 });
    return d.flatMap((c) => c.items || []).map((x) => ({
      title: unescapeHtml(x.titleFull || x.title), src: x.officeName, ts: kstTs(x.datetime),
      url: x.mobileNewsUrl || `https://n.news.naver.com/mnews/article/${x.officeId}/${x.articleId}`,
    }));
  }
  if (market === 'us') {
    const d = await Relay.json<{ tit: string; ohnm: string; dt: string }[]>('naver-api', `news/worldStock/${code}`, { pageSize: 20, page: 1 });
    return d.map((x) => ({ title: unescapeHtml(x.tit), src: x.ohnm, ts: kstTs(x.dt), url: `https://m.stock.naver.com/worldstock/stock/${code}/news` }));
  }
  // 코인: GitHub Actions 가 모은 코인 뉴스에서 이름·티커가 들어간 것
  const t = await topicNews();
  const items = (t.topics || []).find((x) => x.key === 'coin')?.items || [];
  const n = nameOf(sym), base = n.sub.split('/')[0];
  const words = [...n.name.split(/[()]/), base].map((w) => w.trim()).filter((w) => w.length >= 2);
  const hit = items.filter((x) => words.some((w) => x.title.toUpperCase().includes(w.toUpperCase())));
  if (hit.length >= 2) return hit;
  const general: SymbolNews = items.slice(0, 10);
  general.general = true; // 이 코인만의 뉴스가 부족하면 코인 주요 뉴스로
  return general;
}
export async function symbolNews(sym: Sym): Promise<SymbolNews> {
  const seen = new Set<string>(), raw = await symbolNewsRaw(sym);
  const out: SymbolNews = raw.filter((x) => x.title && !seen.has(x.title) && seen.add(x.title)); // 같은 제목은 하나만
  out.general = raw.general;
  return out;
}
/** 해외 증시 속보 (네이버 증권의 로이터 등 번역 기사) — 중계로 바로 받아 GitHub Actions 10분 주기보다 빠르게 */
export async function worldNewsLive(): Promise<NewsItem[]> {
  const d = await Relay.json<{ tit: string; ohnm: string; dt: string; subcontent?: string; oid: string; aid: string; relatedItems?: { reutersCode?: string; itemName?: string }[] }[]>('naver-api', 'news/worldNews', { pageSize: 50, page: 1 });
  return d.filter((x) => x.tit).map((x) => ({
    id: `${x.oid}-${x.aid}`, title: unescapeHtml(x.tit), src: x.ohnm, ts: kstTs(x.dt),
    summary: (x.subcontent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    url: 'https://m.stock.naver.com/news/read?' + new URLSearchParams({ oid: x.oid, aid: x.aid }),
    rel: (x.relatedItems || []).filter((r) => r.reutersCode && !r.reutersCode.startsWith('.')).slice(0, 4).map((r) => ({ sym: 'us:' + r.reutersCode, name: r.itemName || r.reutersCode! })),
  }));
}
/** 코인니스 코인·주식 속보 — 중계로 바로 받는다 (제목·짧은 미리보기·투표 수·원문 링크만) */
const COINNESS = {
  coinflash: { path: 'v3/breaking-news', link: 'https://coinness.com/news/' },
  stockflash: { path: 'v1/stock-breaking-news', link: 'https://coinness.com/stock-news/' },
} as const;
export async function coinnessLive(kind: keyof typeof COINNESS): Promise<NewsItem[]> {
  const c = COINNESS[kind];
  const d = await Relay.json<{ id: number; title: string; content?: string; publishAt: string; bullCount?: number; bearCount?: number; isImportant?: boolean; originCodes?: string[] }[]>('coinness', c.path, { languageCode: 'ko', limit: 40 });
  return d.filter((x) => x.title).map((x) => {
    const body = (x.content || '').replace(/\s+/g, ' ').trim();
    return {
      id: String(x.id), title: x.title.trim(), src: '코인니스', ts: Date.parse(x.publishAt) / 1000, url: c.link + x.id,
      summary: body.slice(0, 110) + (body.length > 110 ? '…' : ''), bull: x.bullCount ?? null, bear: x.bearCount ?? null, important: !!x.isImportant,
      codes: (x.originCodes || []).filter(Boolean).slice(0, 4),
    };
  });
}
/** 실시간으로 다시 받을 수 있는 뉴스 주제 (나머지는 GitHub Actions 10분 주기) */
export const LIVE_TOPICS: Record<string, () => Promise<NewsItem[]>> = {
  world: worldNewsLive,
  coinflash: () => coinnessLive('coinflash'),
  stockflash: () => coinnessLive('stockflash'),
};
export const googleNewsUrl = (query: string) => 'https://news.google.com/search?' + new URLSearchParams({ q: query, hl: 'ko', gl: 'KR', ceid: 'KR:ko' });
export function newsMoreUrl(sym: Sym) {
  const [market, code] = split(sym);
  if (market === 'krx') return `https://m.stock.naver.com/domestic/stock/${code}/news`;
  if (market === 'us') return `https://m.stock.naver.com/worldstock/stock/${code}/news`;
  return googleNewsUrl(nameOf(sym).name + ' 코인');
}
