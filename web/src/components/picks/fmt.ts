// 순위 화면 표기(순수 함수 — 테스트용으로 컴포넌트와 나눔): '+0.3%'(U+2212) · 방향색 · 한국 시간 날짜 · 예상 % 경고 문장
import { signedPct } from '@/components/common/Change';
import type { FcGrade, Market } from '@/lib/market';

/** 분수 → '+0.3%' · '−2.9%' (U+2212) */
export const fpct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : signedPct(x * 100, d));
/** 분수 → '+0.25%p' */
export const fpp = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '–' : `${signedPct(x * 100, d)}p`);
/** 비율 → '58%' */
export const p0 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
/** 보이는 자릿수 기준 방향색 — 0.0% 로 보이면 색 없음 (한국식: 오름 빨강 · 내림 파랑) */
export function toneOf(x: number | null | undefined, d = 1) {
  if (x == null || !Number.isFinite(x)) return 'text-muted-foreground';
  const r = Math.round(x * 100 * 10 ** d);
  return r > 0 ? 'text-up-text' : r < 0 ? 'text-down-text' : 'text-foreground';
}
/** 예상 % 자릿수 — 0.1% 안쪽이면 둘째 자리까지 (+0.0% 만 줄줄이 보이지 않게) */
export const expDigits = (x: number | null | undefined) => (x != null && Math.abs(x) < 0.001 ? 2 : 1);

const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
const hourFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

/** ISO → '10월 29일 오전 9:00' (한국 시간) */
export function whenText(iso: string | null | undefined) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(+d)) return '';
  return `${dayFmt.format(d)} ${hourFmt.format(d).replace(':00', '시').replace(/(\d+):(\d+)/, '$1시 $2분')}`;
}
/** 'YYYY-MM-DD'(한국 날짜) 또는 ISO → 오늘·어제·'10월 28일' */
export function dayText(s: string | null | undefined, now = Date.now()) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? `${s}T12:00:00+09:00` : s);
  if (Number.isNaN(+d)) return '';
  const k = keyFmt.format(d);
  if (k === keyFmt.format(new Date(now))) return '오늘';
  if (k === keyFmt.format(new Date(now - 86400e3))) return '어제';
  return dayFmt.format(d);
}
/** 기록의 '고른 날' — 코인은 기준일 다음 날 09:00(기준가 시각), 주식은 기준일 장 마감 */
export function pickDay(d: string, market: Market | null | undefined) {
  if (market !== 'upbit' && market !== 'binance') return d;
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
export const MKT_ALL: Record<Market, string> = { upbit: '업비트 전체', binance: '바이낸스 전체', krx: '국내 전체', us: '미국 전체' };

/** 예상 % 검증 등급이 약하면 먼저 알리는 한 줄 */
export function fcWarn(grade: FcGrade | null | undefined, hLabel = '24시간'): string | null {
  if (grade === 'poor') return `이 시장의 '${hLabel} 뒤 예상 %'는 과거로 되돌려 보니 '0%'라고 하는 것보다 잘 맞지 않았어요. 숫자보다 범위(흔들림 크기)를 보세요.`;
  if (grade === 'weak') return `이 시장의 '${hLabel} 뒤 예상 %'는 과거에 '0%'라고 하는 것보다 조금 나은 정도였어요. 참고만 하세요.`;
  return null;
}

/** 문장 속 음수 부호를 U+2212 로 ('-27%' → '−27%') */
export const minusFix = (t: string) => t.replace(/(^|[\s(~])-(?=\d)/g, '$1−');
