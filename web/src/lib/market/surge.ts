// 실시간 급등 감지 — 업비트 웹소켓 시세(원화 전 종목)를 5초 간격 표본으로 10분 쌓아
// 1분·5분 상승률과 그 사이 거래대금이 평소(24시간 평균 속도)의 몇 배인지를 본다.
// 수집기(40~70분 간격)를 기다리지 않는 화면 쪽 계산 — 과거 검증을 거친 점수가 아니라 '지금 벌어지는 일'을 보여 주는 용도.
import { getQuote, onQuotes } from './quotes';
import type { Sym } from './types';

const STEP = 5000; // 표본 간격
const KEEP = 10 * 60e3; // 표본 보관
const W1 = 60e3, W5 = 5 * 60e3;
/** 감지 기준 — 창 안 상승률 · 평소 대비 거래대금 배수 · 창 안 최소 거래대금(한두 번 체결로 튄 것 거르기) */
export const SURGE_RULE = { r1: 0.015, r5: 0.03, burst: 3, minVal: 3e6 };

export interface Sample { t: number; p: number; a: number | null }
const buf = new Map<Sym, Sample[]>();
let users = 0;
let since = 0;
let off: (() => void) | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
const LINGER = 90e3; // 추천 ↔ 펌핑 후보처럼 화면을 옮겨도 모은 표본을 바로 버리지 않는다

function take(sym: Sym, now: number) {
  if (!sym.startsWith('upbit:')) return;
  const q = getQuote(sym);
  if (!q?.live || q.price == null) return;
  let s = buf.get(sym);
  if (!s) buf.set(sym, (s = []));
  const last = s[s.length - 1];
  const a = q.accVal ?? null;
  if (last && now - last.t < STEP) {
    // 같은 칸 안에서는 마지막 값으로 덮지 않는다 — 칸의 처음 값이 '그 시각 가격'
    return;
  }
  s.push({ t: now, p: q.price, a });
  while (s.length && now - s[0].t > KEEP) s.shift();
}

/** 감지 시작 (화면이 켜는 동안만) → 끄는 함수 */
export function startSurge(): () => void {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (users++ === 0 && !off) {
    since = Date.now();
    off = onQuotes((changed) => { const now = Date.now(); changed.forEach((sym) => take(sym, now)); });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users === 0) {
      stopTimer = setTimeout(() => { stopTimer = null; if (users) return; off?.(); off = null; buf.clear(); since = 0; }, LINGER);
    }
  };
}
/** 지켜본 시간 (ms) */
export const surgeWatched = (now = Date.now()) => (since ? now - since : 0);

export interface Surge {
  sym: Sym; price: number;
  /** 1분 · 5분(지켜본 시간이 짧으면 그만큼) 상승률 — 분수 */
  r1: number | null; r5: number | null; win: number;
  /** 창 안 거래대금(원)과 평소 속도(24시간 거래대금 ÷ 24시간) 대비 배수 */
  val: number | null; burst: number | null;
  hit: boolean;
}

/** 표본 배열에서 now − ago 시각의 표본(그 시각 이전 마지막 것). 지켜본 시간이 모자라면 가장 오래된 것 */
function at(s: Sample[], now: number, ago: number): Sample | null {
  if (!s.length) return null;
  let pick: Sample | null = null;
  for (const x of s) { if (x.t <= now - ago) pick = x; else break; }
  return pick ?? s[0];
}

/** 순수 계산 — 시험용으로 표본·시세를 직접 받는다 */
export function surgeOf(sym: Sym, s: Sample[], price: number, accVal: number | null, vol24: number | null, now: number): Surge | null {
  if (!s.length || !(price > 0)) return null;
  const first = s[0];
  const watched = now - first.t;
  if (watched < 30e3) return null;
  const b1 = at(s, now, W1), b5 = at(s, now, W5);
  const r1 = b1 && now - b1.t >= 30e3 ? price / b1.p - 1 : null;
  const win = b5 ? now - b5.t : 0;
  const r5 = b5 && win >= 30e3 ? price / b5.p - 1 : null;
  let val: number | null = null, burst: number | null = null;
  if (b5 && b5.a != null && accVal != null && accVal >= b5.a) {
    val = accVal - b5.a; // 09:00 KST 초기화를 건너면 accVal < b5.a → 계산 안 함
    if (vol24 && vol24 > 0 && win > 0) burst = val / (vol24 * (win / 86400e3));
  }
  const hit = val != null && val >= SURGE_RULE.minVal && burst != null && burst >= SURGE_RULE.burst
    && ((r1 != null && r1 >= SURGE_RULE.r1) || (r5 != null && r5 >= SURGE_RULE.r5));
  return { sym, price, r1, r5, win, val, burst, hit };
}

/** 지금 업비트 원화 전 종목의 감지 결과 — 기준을 넘은 것만, 5분 상승률 큰 순 */
export function surgeList(now = Date.now()): Surge[] {
  const out: Surge[] = [];
  for (const [sym, s] of buf) {
    const q = getQuote(sym);
    if (!q?.price) continue;
    const r = surgeOf(sym, s, q.price, q.accVal ?? null, q.vol ?? null, now);
    if (r?.hit) out.push(r);
  }
  return out.sort((a, b) => (b.r5 ?? b.r1 ?? 0) - (a.r5 ?? a.r1 ?? 0));
}
/** 한 종목 (기준을 넘지 않아도) */
export function surgeFor(sym: Sym, now = Date.now()): Surge | null {
  const s = buf.get(sym), q = getQuote(sym);
  return s && q?.price ? surgeOf(sym, s, q.price, q.accVal ?? null, q.vol ?? null, now) : null;
}
