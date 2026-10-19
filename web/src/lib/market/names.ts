// 종목 이름표 + 코인 목록 (GitHub Actions 가 만든 coins.json)
import { split } from './core';
import { hasQuote, putQuote, resyncWants } from './quotes';
import { staticJSON } from './staticData';
import type { NameInfo, ScreenerData, Sym } from './types';

const Names = new Map<Sym, NameInfo>();
const nameListeners = new Set<() => void>();
let nameVersion = 0;

export function remember(sym: Sym, o: Partial<NameInfo>) {
  const cur = Names.get(sym) || ({} as NameInfo);
  let changed = false;
  for (const [k, v] of Object.entries(o)) {
    if (v != null && v !== '' && (cur as unknown as Record<string, unknown>)[k] !== v) { (cur as unknown as Record<string, unknown>)[k] = v; changed = true; }
  }
  Names.set(sym, cur);
  if (changed) { nameVersion++; nameListeners.forEach((fn) => fn()); }
}
export function nameOf(sym: Sym): NameInfo {
  const n = Names.get(sym);
  const code = split(sym)[1];
  return { name: n?.name || code, sub: n?.sub || code, ex: n?.ex, warn: n?.warn, en: n?.en };
}
export const onNames = (fn: () => void) => { nameListeners.add(fn); return () => { nameListeners.delete(fn); }; };
export const namesVersion = () => nameVersion;

interface CoinsData { updatedAt?: string; upbit: Record<string, [string, string, number]>; binance: string[] }
let coinsData: CoinsData | null = null;
let coinsPromise: Promise<CoinsData> | null = null;
let coinsRetry: ReturnType<typeof setTimeout> | null = null;

export function loadCoins(): Promise<CoinsData> {
  if (coinsData) return Promise.resolve(coinsData);
  if (coinsPromise) return coinsPromise;
  coinsPromise = (async () => {
    let d: CoinsData;
    try {
      d = await staticJSON<CoinsData>('coins.json', 3600e3);
    } catch {
      // 못 받았으면 빈 목록을 기억하지 않고 30초 뒤 다시 — 받으면 '업비트 전체' 같은 구독을 다시 맞춘다
      coinsPromise = null;
      if (!coinsRetry) coinsRetry = setTimeout(() => { coinsRetry = null; void loadCoins().then((x) => { if (Object.keys(x.upbit || {}).length) resyncWants(); }); }, 30e3);
      return { upbit: {}, binance: [] };
    }
    const kr: Record<string, string> = {};
    for (const [code, [name, en, warn]] of Object.entries(d.upbit || {})) {
      const base = code.slice(4);
      kr[base] = name;
      remember('upbit:' + code, { name, sub: base, en, warn: !!warn });
    }
    for (const s of d.binance || []) {
      const base = s.replace(/USDT$/, '');
      remember('binance:' + s, { name: kr[base] || base, sub: base + '/USDT' });
    }
    coinsData = d;
    // 업비트 웹소켓이 막혀 있어도 빈 화면이 되지 않도록 10분 단위 시세를 먼저 깔아 둔다
    staticJSON<ScreenerData>('screener/upbit.json', 5 * 60e3).then((s) => {
      const ts = Date.parse(s.updatedAt);
      for (const r of s.rows) if (!hasQuote(r.sym)) putQuote(r.sym, { price: r.price, chg: r.chg, vol: r.vol, ts, live: false });
    }).catch(() => {});
    return d;
  })();
  return coinsPromise;
}
export const upbitCodes = (): string[] => Object.keys(coinsData?.upbit || {});
export const binanceTop = (): string[] => coinsData?.binance || [];
export const coinsLoaded = () => !!coinsData;
export const upbitMarkets = () => coinsData?.upbit || {};
