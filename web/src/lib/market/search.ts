// 종목 검색 — 코인은 업비트·바이낸스 목록에서 (같은 코인은 한 번만: 업비트 원화에 있으면 그쪽, 없으면 바이낸스를 연다)
// 주식은 네이버 자동완성(중계) 또는 정적 목록에서
import { marketOf } from './core';
import { listOrder, loadStaticStocks } from './feeds';
import { usdtKrw } from './overview';
import { binanceTop, loadCoins, nameOf, remember, upbitMarkets } from './names';
import { getQuote } from './quotes';
import { Relay } from './relay';
import type { Market, SearchItem, Sym } from './types';

const COIN_MAX = 8;

export async function search(q: string): Promise<SearchItem[]> {
  q = q.trim();
  if (!q) return [];
  await loadCoins();
  const ql = q.toLowerCase();
  const rank = (a?: string, b?: string) => { const x = (a || '').toLowerCase(), y = (b || '').toLowerCase(); return x === ql || y === ql ? 0 : x.startsWith(ql) || y.startsWith(ql) ? 1 : 2; };
  const pick = (list: { r: number; item: SearchItem }[], n = 8) => list.sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.item);
  const res: SearchItem[] = [];

  // ── 코인: 티커(BTC)가 같으면 거래소가 달라도 한 코인 (김프 계산과 같은 규칙) ──
  interface Coin { item: SearchItem; en?: string }
  const coins = new Map<string, Coin>();
  for (const [code, [name, en]] of Object.entries(upbitMarkets())) {
    if (!code.startsWith('KRW-')) continue;
    const base = code.slice(4);
    coins.set(base, { item: { sym: 'upbit:' + code, market: 'upbit', name, sub: base }, en });
  }
  for (const s of binanceTop()) {
    const base = s.replace(/USDT$/, '');
    if (!base || coins.has(base)) continue;
    coins.set(base, { item: { sym: 'binance:' + s, market: 'binance', name: nameOf('binance:' + s).name, sub: base } });
  }
  // 같은 정도로 맞으면 거래대금이 큰 코인부터 ('비트' → 비트코인이 먼저) — 바이낸스는 USDT 라 원화로 바꿔서 견준다
  const fx = usdtKrw() || 1400;
  const volOf = (sym: Sym) => { const v = getQuote(sym)?.vol; return v == null || !Number.isFinite(v) ? 0 : marketOf(sym) === 'binance' ? v * fx : v; };
  const hits: { r: number; v: number; item: SearchItem }[] = [];
  for (const [base, { item, en }] of coins) {
    if (item.name.toLowerCase().includes(ql) || base.toLowerCase().includes(ql) || (en || '').toLowerCase().includes(ql)) {
      hits.push({ r: rank(item.name, base), v: volOf(item.sym), item });
    }
  }
  res.push(...hits.sort((a, b) => a.r - b.r || b.v - a.v).slice(0, COIN_MAX).map((x) => x.item));

  // ── 주식 ──
  if (Relay.ok()) {
    try {
      const d = await Relay.json('naver-ac', '', { q, target: 'stock,worldstock' });
      for (const it of (d.items || []) as { nationCode: string; code: string; reutersCode: string; name: string; typeCode: string; typeName: string }[]) {
        let sym: Sym, sub: string;
        if (it.nationCode === 'KOR') { sym = 'krx:' + it.code; sub = it.code; } else if (it.nationCode === 'USA') { sym = 'us:' + it.reutersCode; sub = it.code; } else continue;
        remember(sym, { name: it.name, sub, ex: it.typeCode });
        res.push({ sym, market: marketOf(sym), name: it.name, sub, ex: it.typeName });
      }
      return res;
    } catch { /* 아래 정적 목록으로 */ }
  }
  await loadStaticStocks();
  for (const market of ['krx', 'us'] as const) {
    const hits: { r: number; item: SearchItem }[] = [];
    for (const sym of listOrder[market]) {
      const n = nameOf(sym);
      if (n.name.toLowerCase().includes(ql) || n.sub.toLowerCase().includes(ql)) hits.push({ r: rank(n.name, n.sub), item: { sym, market: market as Market, name: n.name, sub: n.sub, ex: n.ex } });
    }
    res.push(...pick(hits));
  }
  return res;
}
