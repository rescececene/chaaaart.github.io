// 비트코인 카드 표기 — 원화는 '1억 835만 원', 변화율은 '+1.2%'·'−0.4%'(U+2212), 시각은 한국 시간 '오전 9시'
import { signedPct } from '@/components/common/Change';

/** 108,347,000 → '1억 835만 원' (만 원 단위 반올림) · unit=false 면 '1억 835만' */
export function krw(x: number | null | undefined, unit = true): string {
  if (x == null || !Number.isFinite(x)) return '–';
  const man = Math.round(x / 1e4);
  const eok = Math.floor(man / 10000);
  const rest = man % 10000;
  const s = eok && rest ? `${eok}억 ${rest.toLocaleString('ko-KR')}만` : eok ? `${eok}억` : `${rest.toLocaleString('ko-KR')}만`;
  return unit ? `${s} 원` : s;
}

/** 분수 → '+1.2%' */
export const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : signedPct(x * 100, d));
/** 확률 → '51%' */
export const prob = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
/** 보이는 자릿수 기준 방향색 (0.0% 로 보이면 색 없음) */
export const toneCls = (x: number | null | undefined, d = 1) => {
  if (x == null || !Number.isFinite(x)) return 'text-muted-foreground';
  const r = Math.round(x * 100 * 10 ** d);
  return r > 0 ? 'text-up-text' : r < 0 ? 'text-down-text' : 'text-foreground';
};

const hourFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
const ymdFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' });

/** ISO → '오전 9시' (한국 시간, 정각 기준) */
export function hourLabel(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(+d)) return '';
  const m = d.getUTCMinutes();
  return hourFmt.format(d) + (m ? ` ${m}분` : '');
}
/** ISO → '10월 29일' */
export function dayLabel(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(+d) ? dayFmt.format(d) : '';
}
/** 'YYYY-MM-DD' 또는 ISO → '2025. 10. 28.' 꼴을 '2025.10.28' 로 */
export function ymd(s: string | null | undefined): string {
  const d = s ? new Date(s.length === 10 ? `${s}T00:00:00+09:00` : s) : null;
  return d && !Number.isNaN(+d) ? ymdFmt.format(d).replace(/\s/g, '').replace(/\.$/, '') : '';
}
/** 한국 날짜가 오늘·어제면 그 말로 */
export function relDay(iso: string, now = Date.now()): string {
  const key = (t: number) => ymdFmt.format(new Date(t));
  const t = Date.parse(iso);
  if (key(t) === key(now)) return '오늘';
  if (key(t) === key(now - 86400e3)) return '어제';
  return dayLabel(iso);
}
/** [맞힘, 전체] → '17/30' */
export const frac = (x: [number, number] | null | undefined) => (x && x[1] ? `${x[0]}/${x[1]}` : '–');
