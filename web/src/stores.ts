// 사용자 데이터 (이 기기의 브라우저에 저장) — 관심종목·화면 설정
import { coinKey, sameCoin } from '@/lib/coins';
import { createLocalStore } from '@/lib/localStore';
import { createSecureStore } from '@/lib/secureStore';
import { nameOf, remember, type Sym } from '@/lib/market';

export interface WatchItem { sym: Sym; name: string; sub: string }
export type ThemePref = 'auto' | 'light' | 'dark';
export interface IndToggles { ma: boolean; bb: boolean; vol: boolean; rsi: boolean; macd: boolean; cross: boolean; forecast: boolean }

const DEFAULT_WATCH: WatchItem[] = [
  { sym: 'upbit:KRW-BTC', name: '비트코인', sub: 'BTC' }, { sym: 'upbit:KRW-ETH', name: '이더리움', sub: 'ETH' },
  { sym: 'krx:005930', name: '삼성전자', sub: '005930' }, { sym: 'krx:000660', name: 'SK하이닉스', sub: '000660' },
  { sym: 'us:NVDA.O', name: '엔비디아', sub: 'NVDA' }, { sym: 'us:AAPL.O', name: '애플', sub: 'AAPL' },
];

/** 관심종목 — 이 기기 안에서 암호화해 저장 (lib/secureStore.ts) */
export const watchStore = createSecureStore<WatchItem[]>('ml.watch', DEFAULT_WATCH);
export const themeStore = createLocalStore<ThemePref>('ml.theme', 'auto');
export const indStore = createLocalStore<IndToggles>('ml.ind', { ma: true, bb: false, vol: true, rsi: true, macd: true, cross: false, forecast: true });

// 코인은 거래소가 달라도 한 종목 — 업비트 BTC 든 바이낸스 BTC 든 하나만 담겨 있으면 '담김'
/** 담겨 있는가 (코인은 어느 거래소로 담았든) */
export const isWatched = (list: WatchItem[], sym: Sym) => list.some((w) => sameCoin(w.sym, sym));
/** 담기/빼기 — 담을 때는 이 종목을, 뺄 때는 같은 코인의 모든 거래소를. 담았으면 true */
export function toggleWatch(sym: Sym): boolean {
  const l = watchStore.get();
  const on = !isWatched(l, sym);
  if (on) { const n = nameOf(sym); watchStore.set([...l, { sym, name: n.name, sub: n.sub }]); } else watchStore.set(l.filter((w) => !sameCoin(w.sym, sym)));
  return on;
}
/** 같은 코인은 한 번만 (먼저 담은 거래소로) — 관심 탭·검색 창 목록용 */
export function distinctWatch(list: WatchItem[]): WatchItem[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = coinKey(w.sym);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 저장된 종목 이름을 이름표에 미리 넣어 둔다 (시세가 오기 전에도 이름이 보이게) */
export function seedNames() {
  for (const x of watchStore.get()) {
    if (x.sym) remember(x.sym, { name: x.name, sub: x.sub });
  }
}
