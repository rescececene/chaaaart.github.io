// 시세 저장소 — 종목별로 구독할 수 있어 바뀐 종목만 다시 그린다.
// 웹소켓·폴링으로 들어온 갱신은 다음 화면 프레임(requestAnimationFrame)에 한꺼번에 알린다.
import type { Quote, Sym } from './types';

const quotes = new Map<Sym, Quote>();
const symListeners = new Map<Sym, Set<() => void>>();
const anyListeners = new Set<(changed: Set<Sym>) => void>();
let pending = new Set<Sym>();
let scheduled = false;

export function getQuote(sym: Sym): Quote | undefined { return quotes.get(sym); }
export function hasQuote(sym: Sym) { return quotes.has(sym); }

export function putQuote(sym: Sym, q: Partial<Quote>) {
  const old = quotes.get(sym);
  // 새 객체로 바꿔야 useSyncExternalStore 가 변경을 알아챈다
  const next: Quote = old ? { ...old, ...q, prev: q.price !== undefined ? old.price : old.prev } : ({ price: null, chg: null, ts: Date.now(), live: false, ...q } as Quote);
  quotes.set(sym, next);
  pending.add(sym);
  schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const run = () => { scheduled = false; flush(); };
  // 탭이 숨겨져 있으면 rAF 가 멈추므로 타이머로
  if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 250);
}
function flush() {
  const changed = pending;
  pending = new Set();
  for (const sym of changed) symListeners.get(sym)?.forEach((fn) => fn());
  for (const fn of anyListeners) { try { fn(changed); } catch (e) { console.error(e); } }
}

export function subscribeSym(sym: Sym, fn: () => void) {
  let set = symListeners.get(sym);
  if (!set) symListeners.set(sym, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) symListeners.delete(sym); };
}
export function onQuotes(fn: (changed: Set<Sym>) => void) { anyListeners.add(fn); return () => { anyListeners.delete(fn); }; }

// ── 구독 요청 ("이 화면은 이 종목들 시세가 필요하다") ──
// 'upbit:*' 처럼 * 는 그 시장 목록 전체. 거래소별 실시간 연결은 feeds.ts 가 이 목록을 보고 맞춘다.
const wants = new Map<string, Set<Sym>>();
const wantListeners = new Set<() => void>();
let wantTimer: ReturnType<typeof setTimeout> | null = null;
export function want(owner: string, syms: Iterable<Sym>) { wants.set(owner, new Set(syms)); scheduleWantSync(); }
export function unwant(owner: string) { if (wants.delete(owner)) scheduleWantSync(); }
export function wanted(market: string): Set<Sym> {
  const out = new Set<Sym>();
  for (const set of wants.values()) for (const s of set) if (s.startsWith(market + ':')) out.add(s);
  return out;
}
export function onWantsChange(fn: () => void) { wantListeners.add(fn); return () => { wantListeners.delete(fn); }; }
/** 구독 목록은 그대로지만 '*' 가 가리키는 종목이 바뀌었을 때 (코인 목록을 늦게 받은 경우) 다시 맞추게 한다 */
export const resyncWants = () => scheduleWantSync();
function scheduleWantSync() {
  if (wantTimer) clearTimeout(wantTimer);
  wantTimer = setTimeout(() => { wantTimer = null; wantListeners.forEach((fn) => fn()); }, 120);
}
