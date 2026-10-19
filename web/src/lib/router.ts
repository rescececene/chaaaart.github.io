// 해시 주소 — #/chart/upbit%3AKRW-BTC/1d  (GitHub Pages 에서 서버 설정 없이 동작)
// 이전 버전 주소(#chart/upbit:KRW-BTC/1d)도 그대로 열린다.
import { useSyncExternalStore } from 'react';

export interface Route { page: string; args: string[] }
const PAGES = ['recommend', 'market', 'picks', 'chart', 'screener', 'news', 'settings'] as const;
export type PageKey = (typeof PAGES)[number];

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const page = (PAGES as readonly string[]).includes(parts[0]) ? parts[0] : 'recommend';
  return { page, args: parts.slice(1) };
}
let current = parse();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse();
    listeners.forEach((fn) => fn());
    window.scrollTo({ top: 0 });
  });
}
export function useRoute(): Route {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => current);
}
export const href = (page: PageKey, ...args: (string | number | undefined | null)[]) =>
  '#/' + [page, ...args.filter((a) => a != null && a !== '').map((a) => encodeURIComponent(String(a)))].join('/');
export const navigate = (page: PageKey, ...args: (string | number | undefined | null)[]) => { location.hash = href(page, ...args); };
