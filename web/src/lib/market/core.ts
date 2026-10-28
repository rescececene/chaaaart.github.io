// 공통 도구 — 저장소, 숫자·시각 변환, HTTP
import type { Candle, Market, Sym } from './types';

export const MARKETS: Record<Market, { name: string; ccy: 'KRW' | 'USD' | 'USDT'; coin: boolean }> = {
  upbit: { name: '업비트', ccy: 'KRW', coin: true },
  binance: { name: '바이낸스', ccy: 'USDT', coin: true },
  krx: { name: '국내주식', ccy: 'KRW', coin: false },
  us: { name: '미국주식', ccy: 'USD', coin: false },
};
export const MARKET_KEYS = Object.keys(MARKETS) as Market[];

/** localStorage — 사생활 보호 모드처럼 저장이 막혀도 앱은 돌아가야 한다 (키·형식은 이전 버전과 같다) */
export const Store = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 */ }
  },
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 업비트는 브라우저 요청(Origin 이 붙은 요청)을 IP 당 10초에 1번쯤만 받는다 — 웹소켓 접속과 REST 가 같은 몫을 쓴다.
// 부딪치면 CORS 헤더 없는 429 가 와서 브라우저에선 원인 모를 실패로 보이므로, 둘이 한 줄로 차례를 잡는다.
const upbitGate = { next: 0 };
/** 업비트 직접 요청(웹소켓 접속 포함) 차례를 잡고, 그 차례까지 기다릴 ms 를 돌려준다. minWait = 최소 대기 */
export function upbitSlot(minWait = 0): number {
  const now = Date.now(), at = Math.max(now + minWait, upbitGate.next);
  upbitGate.next = at + 10_500;
  return at - now;
}
export function split(sym: Sym): [Market, string] {
  const i = sym.indexOf(':');
  return [sym.slice(0, i) as Market, sym.slice(i + 1)];
}
export const marketOf = (sym: Sym) => split(sym)[0];
export const isValidSym = (sym: string) => { const [m, c] = split(sym); return !!c && m in MARKETS; };
export function num(s: unknown): number | null {
  if (s == null || s === '') return null;
  const v = typeof s === 'number' ? s : parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg?: string) { super(msg || `HTTP ${status}`); this.status = status; }
}
export class NeedRelay extends Error {
  needRelay = true;
  constructor() { super('주식 분봉은 실시간 중계(Worker)가 연결돼야 볼 수 있습니다'); }
}
async function fetchOk(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    let msg: string | undefined;
    try { msg = (await r.json()).error; } catch { /* 본문 없음 */ }
    throw new HttpError(r.status, msg);
  }
  return r;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getJSON = async <T = any>(url: string): Promise<T> => (await fetchOk(url)).json();
export const getText = async (url: string) => (await fetchOk(url)).text();

/** 'YYYY-MM-DDTHH:MM:SS' (벽시계) → 초 */
export const wallTs = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0) / 1000;
/** 'YYYYMMDD[HHMMSS]' (벽시계) → 초 */
export const ymdTs = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10) || 0, +s.slice(10, 12) || 0) / 1000;

export function dedupe(cs: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of cs) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}
/** key(t) 가 같은 봉끼리 합친다 */
export function groupBars(bars: Candle[], key: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of bars) {
    const k = key(c.t);
    if (!cur || cur.t !== k) { cur = { ...c, t: k }; out.push(cur); } else {
      cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v;
    }
  }
  return out;
}
