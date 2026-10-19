// 실시간 시세로 마지막 봉을 갱신하고, 새 봉이 시작됐으면 하나 붙인다 (바뀌면 새 배열, 아니면 null)
import { IV_SEC, MARKETS, type Candle, type Interval, type Market, type Quote } from './market';

export function applyLiveQuote(candles: Candle[], q: Quote | undefined, market: Market, iv: Interval): Candle[] | null {
  if (!q || !q.live || q.price == null || !candles.length) return null;
  const price = q.price, p = IV_SEC[iv];
  const out = candles.slice();
  let last = { ...out[out.length - 1] };
  const nowSec = Date.now() / 1000;
  let barStart: number | null = null;
  if (MARKETS[market].coin && p) {
    // 거래소 봉 경계는 UTC 기준 — 분봉은 한국 시간 벽시계로 옮기고(+9시간), 일봉은 UTC 날짜 그대로
    const utcStart = Math.floor(nowSec / p) * p;
    barStart = iv === '1d' ? utcStart : utcStart + 9 * 3600;
  } else if (!MARKETS[market].coin && p && p <= 1800 && q.status === 'OPEN') {
    // 장중 주식 분봉. 국내는 장 마감 뒤 NXT 시간에도 OPEN 이지만 실시간 가격이 정규장 종가에 멈춰 있어 정규장에만
    const kstMin = ((nowSec + 9 * 3600) % 86400) / 60;
    if (market !== 'krx' || (kstMin >= 540 && kstMin < 930)) barStart = Math.floor((nowSec + 9 * 3600) / p) * p;
  }
  if (barStart != null && barStart > last.t) {
    out.push({ t: barStart, o: last.c, h: price, l: price, c: price, v: 0 });
    last = { ...out[out.length - 1] };
  }
  const before = out[out.length - 1];
  last.c = price;
  if (market === 'upbit' && iv === '1d' && q.high != null && q.low != null && q.open != null) {
    last.h = q.high; last.l = q.low; last.o = q.open; last.v = q.accVol ?? last.v; // 업비트 일봉은 시세가 곧 오늘 봉
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
  }
  if (out.length === candles.length && before.c === last.c && before.h === last.h && before.l === last.l && before.o === last.o && before.v === last.v) return null;
  out[out.length - 1] = last;
  return out;
}
