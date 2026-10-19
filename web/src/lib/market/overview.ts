// 지수·환율·김치 프리미엄
import { getJSON, num } from './core';
import { naverChg } from './feeds';
import { binanceTop } from './names';
import { getQuote } from './quotes';
import { Relay } from './relay';
import { staticJSON } from './staticData';
import type { OverviewItem } from './types';

export const FX: { usd: number | null } = { usd: null };

export async function overview(): Promise<{ items: OverviewItem[]; live: boolean }> {
  let items: OverviewItem[] = [];
  let live = false;
  if (Relay.ok()) {
    const [dom, world, fx] = await Promise.allSettled([
      Relay.json('naver-poll', 'domestic/index/KOSPI,KOSDAQ'),
      Relay.json('naver-poll', 'worldstock/index/.IXIC,.INX,.DJI'),
      Relay.json('naver-api', 'marketindex/exchange/FX_USDKRW'),
    ]);
    if (fx.status === 'fulfilled') {
      const d = fx.value.exchangeInfo;
      let chg = num(d.fluctuationsRatio) || 0;
      if (d.fluctuationsType && ['4', '5'].includes(d.fluctuationsType.code) && chg > 0) chg = -chg;
      items.push({ id: 'USDKRW', label: 'USD/KRW', price: num(d.calcPrice ?? d.closePrice), chg });
    }
    for (const r of [dom, world]) {
      if (r.status !== 'fulfilled') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const s of (r.value.datas || []) as any[]) {
        items.push({ id: s.itemCode || s.reutersCode, label: s.stockName || s.indexName, price: num(s.closePriceRaw), chg: naverChg(s), status: s.marketStatus });
      }
    }
    live = items.length > 0;
  }
  if (!live) {
    try { items = (await staticJSON<{ items: OverviewItem[] }>('overview.json', 5 * 60e3)).items; } catch { /* 아직 없음 */ }
  }
  const usd = items.find((x) => x.id === 'USDKRW');
  if (usd?.price) FX.usd = usd.price;
  return { items, live };
}

/** 원화로 산 USDT 가격 (없으면 달러 환율) */
export function usdtKrw(): number | null {
  const q = getQuote('upbit:KRW-USDT');
  return q?.price || FX.usd;
}

// 김치 프리미엄 = 업비트 원화가 ÷ (바이낸스 USDT가 × 달러 환율) − 1
const kimpRef = new Map<string, number>(); // base → 바이낸스 USDT 가격 (REST 로 20초마다)
let kimpAt = 0;
export async function refreshKimpRef() {
  if (Date.now() - kimpAt < 20e3) return;
  kimpAt = Date.now();
  const top = binanceTop();
  if (!top.length) return;
  try {
    const d = await getJSON<{ symbol: string; price: string }[]>('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(top)));
    for (const x of d) kimpRef.set(x.symbol.replace(/USDT$/, ''), +x.price);
  } catch { /* 바이낸스 접속 불가 지역 등 */ }
}
export function kimp(base: string, krwPrice: number | null | undefined): number | null {
  const bq = getQuote('binance:' + base + 'USDT');
  const usd = bq?.price || kimpRef.get(base);
  if (!usd || !FX.usd || !krwPrice) return null;
  const k = (krwPrice / (usd * FX.usd) - 1) * 100;
  return Math.abs(k) < 50 ? k : null; // 티커만 같고 다른 코인이면 터무니없는 값
}
