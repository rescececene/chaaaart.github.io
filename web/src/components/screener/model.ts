// 스크리너 — 10분 단위 계산값에 실시간 시세를 덧씌우는 규칙, 정렬, 저장 키 (이전 버전과 같은 ml.scrM · ml.scrSort)
import { isCoinEx, storedCoinEx } from '@/lib/coins';
import { SIGNALS, SURGE, type Tone } from '@/lib/indicators';
import { MARKET_KEYS, Store, type Market, type Quote, type ScreenerRow } from '@/lib/market';

export type SortKey = 'name' | 'price' | 'chg' | 'vol' | 'rsi' | 'volRatio' | 'op';
export interface Sort { k: SortKey; d: 1 | -1 }
const SORT_KEYS: readonly SortKey[] = ['name', 'price', 'chg', 'vol', 'rsi', 'volRatio', 'op'];

export function loadSort(): Sort {
  const s = Store.get<{ k?: unknown; d?: unknown } | null>('ml.scrSort', null);
  if (!s || !SORT_KEYS.includes(s.k as SortKey)) return { k: 'vol', d: -1 };
  return { k: s.k as SortKey, d: s.d === 1 ? 1 : -1 };
}
export const saveSort = (s: Sort) => Store.set('ml.scrSort', s);

export const isMarket = (m: unknown): m is Market => typeof m === 'string' && (MARKET_KEYS as string[]).includes(m);
/** 주소의 시장 → 없으면 마지막으로 본 시장. 코인은 거래소를 따로 기억한다 (#/screener/coin → 마지막으로 고른 거래소 · ml.coinEx) */
export function pickMarket(arg: string | undefined): Market {
  if (arg === 'coin') return storedCoinEx();
  if (isMarket(arg)) return arg;
  const s = Store.get<unknown>('ml.scrM', 'upbit');
  return isMarket(s) && !isCoinEx(s) ? s : storedCoinEx();
}

/** 주소의 신호 목록 — #/screener/upbit/golden,vol_spike 처럼 바로 걸러서 열 수 있다 */
export const parseChips = (s: string | undefined): string[] =>
  s ? [...new Set(s.split(/[,+]/).filter((k) => Object.hasOwn(SIGNALS, k)))] : [];

/** 아직 계산된 파일이 없음 — 배포 서버는 404, 개발 서버는 HTML 을 돌려줘 JSON 해석이 실패한다 */
export const isNoData = (e: unknown) => (e as { status?: number } | null)?.status === 404 || e instanceof SyntaxError;
/** 불러오기 실패 이유를 사람 말로 */
export function errorText(e: unknown): string {
  // fetch 의 네트워크 실패 — 크롬 'Failed to fetch' · 파이어폭스 'NetworkError…' · 사파리 'Load failed'
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return '인터넷 연결을 확인하고 다시 시도해 주세요';
  const status = (e as { status?: number } | null)?.status;
  if (status) return `서버 응답 오류 (${status})`;
  return e instanceof Error ? e.message : String(e);
}

/** 칩 배치 — 두 줄 격자에서 위는 상승 쪽, 아래는 하락 쪽 신호가 짝을 이룬다 (null 은 빈칸) */
export const CHIP_GRID: (string | null)[] = (() => {
  const pairs: [string, string | null][] = [
    ['surge', 'plunge'], ['new_high', 'new_low'], ['golden', 'dead'], ['align_up', 'align_down'],
    ['macd_up', 'macd_down'], ['bb_up', 'bb_down'], ['rsi_os', 'rsi_ob'], ['vol_spike', null],
  ];
  const out = pairs.flat().filter((k) => k == null || Object.hasOwn(SIGNALS, k));
  for (const k of Object.keys(SIGNALS)) if (!out.includes(k)) out.push(k); // 나중에 신호가 늘어도 빠지지 않게
  return out;
})();

export interface Entry { row: ScreenerRow; price: number | null; chg: number | null; vol: number | null; sig: string[]; live: boolean }

/** 실시간 시세가 있으면 가격·등락률·거래대금을 바꾸고, 급등/급락은 실시간 등락률로 다시 판정한다 */
export function mergeLive(row: ScreenerRow, q: Quote | undefined): Entry {
  if (!q || !q.live || q.price == null) return { row, price: row.price, chg: row.chg, vol: row.vol, sig: row.sig, live: false };
  const sig = row.sig.filter((s) => s !== 'surge' && s !== 'plunge');
  if (q.chg != null && q.chg >= SURGE) sig.unshift('surge');
  else if (q.chg != null && q.chg <= -SURGE) sig.unshift('plunge');
  return { row, price: q.price, chg: q.chg, vol: q.vol ?? row.vol, sig, live: true };
}

const collator = new Intl.Collator('ko');
const GET: Record<SortKey, (e: Entry) => number | string | null> = {
  name: (e) => e.row.name, price: (e) => e.price, chg: (e) => e.chg, vol: (e) => e.vol,
  rsi: (e) => e.row.rsi, volRatio: (e) => e.row.volRatio, op: (e) => e.row.score,
};
const blank = (x: number | string | null) => x == null || (typeof x === 'number' && !Number.isFinite(x));
/** 값이 없는 종목은 방향과 상관없이 맨 뒤 — 같은 값끼리는 원래(거래대금) 순서를 지킨다 */
export function sortEntries(list: Entry[], s: Sort): Entry[] {
  const get = GET[s.k];
  return list.sort((a, b) => {
    const x = get(a), y = get(b);
    if (blank(x) || blank(y)) return blank(x) === blank(y) ? 0 : blank(x) ? 1 : -1;
    return (typeof x === 'string' ? collator.compare(x, String(y)) : (x as number) - (y as number)) * s.d;
  });
}

export const SORT_OPTIONS: { k: SortKey; d: 1 | -1; label: string }[] = [
  { k: 'vol', d: -1, label: '거래대금 많은 순' },
  { k: 'chg', d: -1, label: '상승률 높은 순' },
  { k: 'chg', d: 1, label: '하락률 높은 순' },
  { k: 'volRatio', d: -1, label: '거래량 급증 순' },
  { k: 'rsi', d: -1, label: 'RSI 높은 순' },
  { k: 'rsi', d: 1, label: 'RSI 낮은 순' },
  { k: 'op', d: -1, label: '매수 의견 순' },
  { k: 'op', d: 1, label: '매도 의견 순' },
  { k: 'name', d: 1, label: '이름 순' },
];
const KEY_LABEL: Record<SortKey, string> = { name: '이름', price: '현재가', chg: '등락률', vol: '거래대금', rsi: 'RSI', volRatio: '거래량 배수', op: '의견' };
export function sortLabel(s: Sort): string {
  const hit = SORT_OPTIONS.find((o) => o.k === s.k && o.d === s.d);
  if (hit) return hit.label;
  if (s.k === 'name') return '이름 역순';
  return `${KEY_LABEL[s.k]} ${s.d < 0 ? '높은' : '낮은'} 순`;
}

export const opTone = (label: string): Tone => (label.includes('매수') ? 'up' : label.includes('매도') ? 'down' : 'flat');
export const signalName = (k: string) => SIGNALS[k]?.[0] ?? k;

/** PC 표의 열 — 머리글과 행이 같은 격자를 쓴다 */
export const WIDE_GRID = 'grid grid-cols-[40px_minmax(120px,1fr)_minmax(0,1.25fr)_120px_88px_76px_44px_60px_72px] items-center gap-x-3';
