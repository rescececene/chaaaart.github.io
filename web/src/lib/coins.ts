// 코인 하나 = 거래소 여러 곳. 업비트 원화(upbit:KRW-BTC)와 바이낸스 USDT(binance:BTCUSDT)는 같은 코인(BTC)으로 묶는다.
// 같은 코인인지는 티커로 정한다 (김프 계산과 같은 규칙). 어느 거래소에 있는지는 coins.json 목록 — loadCoins() 가 끝나야 안다.
import { useEffect, useState } from 'react';
import { binanceTop, coinsLoaded, loadCoins, split, Store, upbitMarkets, type Sym } from '@/lib/market';
import { href, type PageKey } from '@/lib/router';

export type CoinEx = 'upbit' | 'binance';
/** 거래소 순서 — 업비트 원화가 먼저 (대표 종목 · 전환 버튼 순서) */
export const COIN_EXES: readonly CoinEx[] = ['upbit', 'binance'];
export const isCoinEx = (x: unknown): x is CoinEx => x === 'upbit' || x === 'binance';
export const EX_NAME: Record<CoinEx, string> = { upbit: '업비트', binance: '바이낸스' };
export const EX_UNIT: Record<CoinEx, string> = { upbit: '원화', binance: 'USDT' };

/** 'BTC' — upbit:KRW-BTC · binance:BTCUSDT 모두. 주식이나 원화가 아닌 업비트 마켓(BTC-ETH 등)은 null */
export function coinBase(sym: Sym): string | null {
  if (typeof sym !== 'string') return null; // 백업 파일 등에서 온 깨진 항목
  const [m, code] = split(sym);
  if (m === 'upbit') return code.startsWith('KRW-') && code.length > 4 ? code.slice(4) : null;
  if (m === 'binance') return code.endsWith('USDT') && code.length > 4 ? code.slice(0, -4) : null;
  return null;
}
/** 코인 종목이면 그 거래소, 아니면 null */
export function coinExOf(sym: Sym): CoinEx | null {
  if (!coinBase(sym)) return null;
  const m = split(sym)[0];
  return isCoinEx(m) ? m : null;
}
/** 목록에 보일 코드 — 바이낸스도 업비트처럼 티커만 ('BTC/USDT' → 'BTC', 단위는 고른 거래소가 말해 준다) */
export const tickerOf = (market: string, sub: string) => (market === 'binance' ? sub.replace(/\/USDT$/, '') : sub);
/** 거래소별 종목 주소 — ('binance', 'BTC') → binance:BTCUSDT */
export const coinSym = (ex: CoinEx, base: string): Sym => (ex === 'upbit' ? `upbit:KRW-${base}` : `binance:${base}USDT`);

// 바이낸스 목록은 배열이라 찾기용 Set 을 만들어 둔다 (목록이 새로 오면 다시)
let bnList: string[] | null = null;
let bnSet = new Set<string>();
function onBinance(base: string) {
  const list = binanceTop();
  if (list !== bnList) { bnList = list; bnSet = new Set(list); }
  return bnSet.has(base + 'USDT');
}
/** 이 거래소 목록에 있는가 — 업비트는 원화 마켓, 바이낸스는 우리가 따라가는 USDT 상위 목록 */
export const listedOn = (ex: CoinEx, base: string) => (ex === 'upbit' ? Object.hasOwn(upbitMarkets(), 'KRW-' + base) : onBinance(base));

/** 거래소 목록을 아는가 — coins.json 을 못 받았으면 둘 다 비어 있다 ('어디에는 없어요' 라고 말하면 안 된다) */
export const coinListsKnown = () => binanceTop().length > 0 || Object.keys(upbitMarkets()).length > 0;
/** 이 코인이 거래되는 곳 (업비트 원화 → 바이낸스 순). 목록이 아직 안 왔으면 빈 배열 */
export function venues(base: string | null | undefined): Sym[] {
  if (!base) return [];
  return COIN_EXES.filter((ex) => listedOn(ex, base)).map((ex) => coinSym(ex, base));
}
/** 같은 코인의 거래소들 — 지금 보는 종목은 목록(상위 종목만 따라간다)에서 빠졌어도 넣는다. 주식은 자기 자신만 */
export function venuesOf(sym: Sym): Sym[] {
  const base = coinBase(sym);
  if (!base) return [sym];
  const out = venues(base);
  if (!out.includes(sym)) out.push(sym);
  return COIN_EXES.flatMap((ex) => out.filter((s) => split(s)[0] === ex));
}
/** 대표 종목 — 업비트 원화에 있으면 그것, 없으면 바이낸스 (목록에 없으면 null) */
export const preferredSym = (base: string): Sym | null => venues(base)[0] ?? null;

/** 같은 코인인가 — 거래소가 달라도 티커가 같으면 같은 코인. 주식은 같은 종목일 때만 */
export function sameCoin(a: Sym, b: Sym): boolean {
  if (a === b) return true;
  const x = coinBase(a);
  return x != null && x === coinBase(b);
}
/** 한 번만 보이게 묶는 열쇠 — 코인은 'coin:BTC', 주식은 종목 주소 그대로 */
export function coinKey(sym: Sym): string {
  const b = coinBase(sym);
  return b ? 'coin:' + b : sym;
}

// ── 마지막으로 고른 코인 거래소 (시장·종목 골라보기·유망 종목이 함께 쓴다) ──
const EX_KEY = 'ml.coinEx';
export function storedCoinEx(): CoinEx {
  const v = Store.get<unknown>(EX_KEY, 'upbit');
  return isCoinEx(v) ? v : 'upbit';
}
export const saveCoinEx = (ex: CoinEx) => Store.set(EX_KEY, ex);

/** 주소의 'coin' 을 실제 거래소로 바꿔 둔다 (#/market/coin → #/market/upbit · 방문 기록은 늘리지 않는다).
 *  그대로 두면 거래소를 바꾼 뒤 '뒤로' 가 'coin'(= 방금 고른 거래소)으로 돌아가 아무 일도 없는 것처럼 보인다 */
export function settleCoinArg(page: PageKey, args: string[], ex: CoinEx) {
  if (args[0] === 'coin') history.replaceState(history.state, '', href(page, ex, ...args.slice(1)));
}

/** 코인 목록(coins.json)이 왔는가 — 오면 한 번 다시 그린다 */
export function useCoinsReady(): boolean {
  const [ready, setReady] = useState(coinsLoaded);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void loadCoins().then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [ready]);
  return ready;
}
