// 사람이 화면을 쓰고 있는지 — 오래 조작이 없으면 실시간 호출을 줄여 중계(무료 하루 10만 건)를 아낀다
// 마우스·키·터치·스크롤 한 번이면 바로 실시간으로 돌아온다.
export const IDLE_AFTER = 15 * 60e3;
let last = Date.now();
const wakeListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

export const isIdle = () => Date.now() - last > IDLE_AFTER;

function touch() {
  const was = isIdle();
  last = Date.now();
  if (was) {
    wakeListeners.forEach((fn) => fn());
    changeListeners.forEach((fn) => fn());
  }
}
/** 조작이 없다가 다시 움직였을 때 (밀린 시세를 바로 받는 데 쓴다) */
export const onWake = (fn: () => void) => { wakeListeners.add(fn); return () => { wakeListeners.delete(fn); }; };
/** 절약 모드가 켜지거나 꺼질 때 (화면 표시용) */
export const onIdleChange = (fn: () => void) => { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; };

if (typeof window !== 'undefined') {
  let moved = 0;
  const opts = { passive: true, capture: true } as const;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, touch, opts);
  window.addEventListener('pointermove', () => { const t = Date.now(); if (t - moved > 1000) { moved = t; touch(); } }, opts);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
  // 절약 모드로 넘어가는 순간을 알린다 (분마다 확인)
  let wasIdle = false;
  setInterval(() => { const now = isIdle(); if (now !== wasIdle) { wasIdle = now; if (now) changeListeners.forEach((fn) => fn()); } }, 60e3);
}
