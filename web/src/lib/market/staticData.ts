// GitHub Actions 가 10분마다 만드는 data/*.json (스크리너·뉴스·지연 시세·종목별 일봉)
import { getJSON } from './core';

const memo = new Map<string, { at: number; p: Promise<unknown> }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function staticJSON<T = any>(name: string, maxAgeMs = 60_000): Promise<T> {
  const m = memo.get(name);
  if (m && Date.now() - m.at < maxAgeMs) return m.p as Promise<T>;
  // 분 단위 쿼리로 GitHub Pages CDN 캐시(10분)를 피한다
  const p = getJSON<T>(`${import.meta.env.BASE_URL}data/${name}?v=${Math.floor(Date.now() / 60_000)}`).catch((e) => {
    memo.delete(name);
    throw e;
  });
  memo.set(name, { at: Date.now(), p });
  return p;
}
