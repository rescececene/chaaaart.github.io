// 테마 — 저장값 auto/light/dark 를 실제 data-theme(light|dark)로 풀어 html 에 적용
import { useSyncExternalStore } from 'react';
import { themeStore } from '@/stores';

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

export function resolvedTheme(): 'light' | 'dark' {
  const t = themeStore.get();
  if (t === 'light' || t === 'dark') return t;
  return mq?.matches ? 'dark' : 'light';
}
function apply() {
  document.documentElement.dataset.theme = resolvedTheme();
  listeners.forEach((fn) => fn());
}
export function initTheme() {
  apply();
  themeStore.subscribe(apply);
  mq?.addEventListener('change', apply);
}
/** 차트처럼 캔버스에 색을 직접 넣는 곳에서 테마가 바뀌면 다시 그리게 */
export function useResolvedTheme() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, resolvedTheme);
}
/** CSS 변수 값 읽기 (차트 색) */
export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
