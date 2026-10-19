import { useEffect, useState, useSyncExternalStore } from 'react';

/** 화면 폭 조건 — 휴대폰 행과 PC 표 중 하나만 그리려고 쓴다 (둘 다 그려 두고 숨기면 300행이 두 배가 된다) */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

/** 위에 붙어 있는 사이트 머리글 높이 — 표 머리글을 그 바로 아래에 붙인다 */
export function useHeaderHeight(enabled: boolean): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = enabled ? document.querySelector('header') : null;
    if (!el) return;
    const update = () => setH(Math.round(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return h;
}
