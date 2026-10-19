// 시장 목록 — 탭·정렬·찾기 규칙 (저장 키·형식은 이전 바닐라 버전과 같다: ml.mkt · ml.mktSort)
import { getQuote, kimp, nameOf, split, Store, type Market, type Sym } from '@/lib/market';

export type Tab = Market | 'watch';
export const TABS: Tab[] = ['upbit', 'binance', 'krx', 'us', 'watch'];
export const isTab = (x: unknown): x is Tab => typeof x === 'string' && (TABS as string[]).includes(x);

export type SortKey = 'name' | 'price' | 'chg' | 'vol' | 'kimp' | 'cap';
export interface Sort { k: SortKey; d: 1 | -1 }

/** 탭마다 보이는 열 (이전 버전과 같음) — 김프는 업비트만, 시가총액은 주식만 */
export const COLS: Record<Tab, SortKey[]> = {
  upbit: ['name', 'price', 'chg', 'vol', 'kimp'],
  binance: ['name', 'price', 'chg', 'vol'],
  krx: ['name', 'price', 'chg', 'vol', 'cap'],
  us: ['name', 'price', 'chg', 'vol', 'cap'],
  watch: ['name', 'price', 'chg', 'vol'],
};
export const DEFAULT_SORT: Record<Tab, Sort | null> = {
  upbit: { k: 'vol', d: -1 }, binance: { k: 'vol', d: -1 }, krx: { k: 'cap', d: -1 }, us: { k: 'cap', d: -1 }, watch: null,
};

// ── 정렬 칩 (토스 '실시간 차트'처럼) ──
export interface ChipDef { id: string; label: string; sort: Sort | null }
const VOL: ChipDef = { id: 'vol', label: '거래대금', sort: { k: 'vol', d: -1 } };
const UP: ChipDef = { id: 'up', label: '상승률', sort: { k: 'chg', d: -1 } };
const DOWN: ChipDef = { id: 'down', label: '하락률', sort: { k: 'chg', d: 1 } };
const KIMP: ChipDef = { id: 'kimp', label: '김프', sort: { k: 'kimp', d: -1 } };
const CAP: ChipDef = { id: 'cap', label: '시가총액', sort: { k: 'cap', d: -1 } };
const NAME: ChipDef = { id: 'name', label: '이름', sort: { k: 'name', d: 1 } };
const ADDED: ChipDef = { id: 'added', label: '추가한 순', sort: null };
export const CHIPS: Record<Tab, ChipDef[]> = {
  upbit: [VOL, UP, DOWN, KIMP, NAME],
  binance: [VOL, UP, DOWN, NAME],
  krx: [CAP, VOL, UP, DOWN, NAME],
  us: [CAP, VOL, UP, DOWN, NAME],
  watch: [ADDED, VOL, UP, DOWN, NAME],
};
/** 칩이 지금 정렬을 나타내는가 — 상승률·하락률은 방향까지, 나머지는 열만 같으면 (반대 방향이면 칩에 ↑ 표시) */
export function chipOn(c: ChipDef, s: Sort | null): boolean {
  if (!c.sort) return s == null;
  return !!s && s.k === c.sort.k && (c.sort.k !== 'chg' || s.d === c.sort.d);
}
export const chipReversed = (c: ChipDef, s: Sort | null) => !!(c.sort && s && c.sort.k !== 'chg' && chipOn(c, s) && s.d !== c.sort.d);

/** 칩을 누르면: 다른 칩이면 그 칩의 기본 정렬, 이미 켜진 칩(상승·하락률 제외)이면 방향을 뒤집는다 */
export function nextChipSort(c: ChipDef, cur: Sort | null): Sort | null {
  if (!c.sort) return null;
  if (chipOn(c, cur) && cur && c.sort.k !== 'chg') return { k: cur.k, d: cur.d === 1 ? -1 : 1 };
  return { ...c.sort };
}
/** 열 머리를 누르면: 같은 열이면 방향만 뒤집고, 새 열이면 이름은 가나다순·숫자는 큰 순 (이전 버전과 같음) */
export function nextHeadSort(k: SortKey, cur: Sort | null): Sort {
  return { k, d: cur && cur.k === k ? (cur.d === 1 ? -1 : 1) : k === 'name' ? 1 : -1 };
}

// ── 저장 ──
type Saved = Partial<Record<Tab, Sort | null>>;
export function loadSorts(): Saved {
  const raw = Store.get<unknown>('ml.mktSort', {});
  return raw && typeof raw === 'object' ? (raw as Saved) : {};
}
export function sortOf(saved: Saved, tab: Tab): Sort | null {
  if (!(tab in saved)) return DEFAULT_SORT[tab];
  const s = saved[tab];
  if (s === null) return tab === 'watch' ? null : DEFAULT_SORT[tab];
  if (!s || typeof s !== 'object' || !COLS[tab].includes(s.k) || (s.d !== 1 && s.d !== -1)) return DEFAULT_SORT[tab];
  return s;
}

// ── 정렬 ──
const collator = new Intl.Collator('ko', { numeric: true });
export function valueOf(sym: Sym, k: SortKey): number | string | null {
  if (k === 'name') return nameOf(sym).name;
  const q = getQuote(sym);
  if (!q) return null;
  switch (k) {
    case 'price': return q.price;
    case 'chg': return q.chg;
    case 'vol': return q.vol ?? null;
    case 'cap': return q.cap ?? null;
    case 'kimp': return split(sym)[0] === 'upbit' ? kimp(nameOf(sym).sub, q.price) : null;
  }
}
/** 값이 없는 종목은 방향과 상관없이 맨 뒤. 같은 값은 원래 순서를 지킨다(안정 정렬). */
export function sortSyms(syms: Sym[], s: Sort | null): Sym[] {
  if (!s) return syms.slice();
  const pairs = syms.map((sym) => [sym, valueOf(sym, s.k)] as const);
  pairs.sort(([, x], [, y]) => {
    if (x == null || (typeof x === 'number' && !Number.isFinite(x))) return y == null ? 0 : 1;
    if (y == null || (typeof y === 'number' && !Number.isFinite(y))) return -1;
    return (typeof x === 'string' ? collator.compare(x, String(y)) : x - (y as number)) * s.d;
  });
  return pairs.map(([sym]) => sym);
}

// ── 목록 안 찾기 — 이름·코드·영문 이름, 초성(ㅂㅌㅋ → 비트코인)도 ──
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const choCache = new Map<string, string>();
function choseong(s: string): string {
  let out = choCache.get(s);
  if (out != null) return out;
  out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  choCache.set(s, out);
  return out;
}
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
/** 일치 정도 — 0 이름·코드가 똑같음 · 1 앞부분 일치 · 2 가운데 포함 · -1 아님 (같은 정도끼리는 목록 순서 유지) */
export function makeRanker(query: string): ((sym: Sym) => number) | null {
  const q = squash(query);
  if (!q) return null;
  const grade = (...fields: (string | undefined)[]) => {
    let best = -1;
    for (const f of fields) {
      if (!f) continue;
      const i = f.indexOf(q);
      if (i < 0) continue;
      const g = f === q ? 0 : i === 0 ? 1 : 2;
      if (best < 0 || g < best) best = g;
    }
    return best;
  };
  if (/^[ㄱ-ㅎ]+$/.test(q)) return (sym) => grade(choseong(squash(nameOf(sym).name)));
  return (sym) => {
    const n = nameOf(sym);
    const sub = squash(n.sub);
    return grade(squash(n.name), sub, sub.split('/')[0], n.en ? squash(n.en) : undefined);
  };
}

// ── 차트에 갔다 돌아오면 보던 자리로 ──
// 누른 줄이 화면의 같은 높이에 다시 오도록 (그사이 순서가 바뀌었어도 그 종목을 기준으로)
interface Spot { tab: Tab; sym: Sym; top: number; y: number; at: number }
let lastSpot: Spot | null = null;
export function rememberSpot(tab: Tab, sym: Sym, top: number) { lastSpot = { tab, sym, top, y: window.scrollY, at: Date.now() }; }
export function peekSpot(tab: Tab): Spot | null {
  const s = lastSpot;
  return s && s.tab === tab && Date.now() - s.at < 30 * 60e3 ? s : null;
}
export function clearSpot() { lastSpot = null; }
export function restoreSpot(s: Spot) {
  const el = document.querySelector(`[data-sym="${CSS.escape(s.sym)}"]`);
  const y = el ? window.scrollY + el.getBoundingClientRect().top - s.top : s.y;
  window.scrollTo({ top: Math.max(0, y) });
}
