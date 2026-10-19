// 숫자·시간 표시 규칙 (한국어, 상승 빨강 · 하락 파랑)
import { MARKETS, type Market } from './market';

const nfs: Record<number, Intl.NumberFormat> = {};
const nf = (d: number) => (nfs[d] ||= new Intl.NumberFormat('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));

export const fmt = (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? '–' : nf(d).format(x));

/** 시장·가격대별 소수 자릿수 — 업비트 호가 단위, 바이낸스 USDT, 미국 달러 관례에 맞춤 */
export function digits(p: number | null | undefined, market: Market): number {
  const a = Math.abs(p || 0);
  if (!a || market === 'krx') return 0;
  const mag = Math.floor(Math.log10(a));
  if (market === 'upbit') return Math.min(8, Math.max(0, 3 - mag)); // 110,874,000 / 512.3 / 0.01234
  if (market === 'binance') return Math.min(8, Math.max(2, 4 - mag)); // 82,386.01 / 2.3456
  return Math.min(6, Math.max(2, 2 - mag)); // 343.46
}
export const fmtPrice = (p: number | null | undefined, market: Market) => fmt(p, digits(p, market));
export const priceUnit = (market: Market) => (market === 'us' ? '$' : market === 'binance' ? 'USDT' : '원');
/** "110,874,000원" · "$343.46" · "82,386.01 USDT" */
export function fmtPriceUnit(p: number | null | undefined, market: Market) {
  if (p == null) return '–';
  if (market === 'us') return '$' + fmtPrice(p, market);
  return fmtPrice(p, market) + (market === 'binance' ? ' USDT' : '원');
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
export const dir = (x: number | null | undefined): 'up' | 'down' | 'flat' => (x == null ? 'flat' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
/** 0.00% 로 보이는 값엔 방향을 주지 않는다 */
export const dirShown = (x: number | null | undefined) => dir(x == null ? null : round2(x));
export const arrow = (x: number | null | undefined) => (x == null ? '' : x > 0 ? '▲' : x < 0 ? '▼' : '');
export function fmtPct(x: number | null | undefined, d = 2) {
  if (x == null || !Number.isFinite(x)) return '–';
  const r = Math.round(x * 10 ** d) / 10 ** d;
  return `${r > 0 ? '+' : ''}${r.toFixed(d)}%`;
}
/** 분수(0.034) → "+3.4%" */
export const fmtRatio = (x: number | null | undefined, d = 1) => (x == null ? '–' : fmtPct(x * 100, d));

export const ccyOf = (m: Market) => MARKETS[m].ccy;
/** 거래대금·시가총액 — 원은 조/억/만, 달러는 B/M/K */
export function fmtAmount(x: number | null | undefined, ccy: 'KRW' | 'USD' | 'USDT') {
  if (x == null || !Number.isFinite(x)) return '–';
  if (ccy === 'KRW') {
    if (x >= 1e12) return (x / 1e12).toFixed(x >= 1e14 ? 0 : 1) + '조';
    if (x >= 1e8) return fmt(x / 1e8) + '억';
    if (x >= 1e4) return fmt(x / 1e4) + '만';
    return fmt(x);
  }
  if (x >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
  return '$' + fmt(x);
}
/** 수량 — 코인 0.15개, 주식 40주 */
export function fmtQty(q: number | null | undefined, market: Market) {
  if (q == null) return '–';
  const d = q % 1 ? Math.min(8, String(q).split('.')[1]?.length || 0) : 0;
  return fmt(q, d) + (MARKETS[market].coin ? '개' : '주');
}
/** 호가 잔량 — 큰 수는 줄여서 */
export function fmtSize(q: number) {
  if (q >= 1e6) return fmt(q / 1e6, 2) + 'M';
  if (q >= 1e4) return fmt(q, 0);
  if (q >= 100) return fmt(q, 1);
  if (q >= 1) return fmt(q, 3);
  return fmt(q, 4);
}
export function timeAgo(ms: number | null | undefined) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** 차트 시각(t: 벽시계 초) → "2026.10.19" 또는 "10.19 09:30" */
export function timeLabel(t: number, daily: boolean) {
  const d = new Date(t * 1000);
  const ymd = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  return daily ? ymd : `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function tickLabel(t: number, type: number) {
  const d = new Date(t * 1000);
  if (type === 0) return String(d.getUTCFullYear());
  if (type === 1) return `${d.getUTCMonth() + 1}월`;
  if (type === 2) return String(d.getUTCDate());
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
