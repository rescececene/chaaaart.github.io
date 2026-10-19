// 시장 목록 공용 — 열 너비, 표시 규칙, 관심 토글
import { toast } from 'sonner';
import { sameCoin } from '@/lib/coins';
import { fmtPrice } from '@/lib/format';
import { nameOf, type Market, type Sym } from '@/lib/market';
import { toggleWatch, watchStore } from '@/stores';
import type { Tab } from './sort';

/** 열 너비 — 머리줄과 행이 같은 값을 쓴다 (lg 이상에서만 표, 그 아래는 두 줄 행) */
export const GRID: Record<Tab, string> = {
  upbit: 'lg:grid-cols-[40px_36px_minmax(0,1fr)_160px_112px_112px_96px_44px]',
  binance: 'lg:grid-cols-[40px_36px_minmax(0,1fr)_160px_112px_128px_44px]',
  krx: 'lg:grid-cols-[40px_36px_minmax(0,1fr)_160px_112px_112px_120px_44px]',
  us: 'lg:grid-cols-[40px_36px_minmax(0,1fr)_160px_112px_112px_120px_44px]',
  watch: 'lg:grid-cols-[40px_36px_minmax(0,1fr)_160px_112px_128px_44px]',
};
/** display 는 쓰는 쪽에서 정한다 (머리줄은 PC 에서만 보이므로 hidden lg:grid) */
export const ROW_GRID = 'grid-cols-[18px_36px_minmax(0,1fr)_auto_32px] items-center gap-x-2 lg:gap-x-3';

const EX: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥', KONEX: '코넥스', NASDAQ: '나스닥', NYSE: 'NYSE', AMEX: 'AMEX' };
export const exLabel = (ex?: string) => (ex ? EX[ex.toUpperCase()] || ex : '');

/** 목록 가격 — 미국 주식만 $ 를 붙인다 (원·USDT 는 탭이 말해 준다) */
export function priceText(p: number | null | undefined, market: Market) {
  if (p == null) return '–';
  return (market === 'us' ? '$' : '') + fmtPrice(p, market);
}

/** ★ — 담기/빼기, 빼면 '되돌리기' 로 원래 자리에 다시 넣을 수 있다.
 *  코인은 거래소가 달라도 한 종목이라, 빼면 업비트·바이낸스로 담긴 것이 함께 빠지고 되돌리면 함께 돌아온다 */
export function onStar(sym: Sym) {
  const before = watchStore.get();
  const removed = before.flatMap((w, i) => (sameCoin(w.sym, sym) ? [{ w, i }] : []));
  const on = toggleWatch(sym);
  const name = nameOf(sym).name;
  if (on) {
    toast(`${name}, 관심 종목에 담았어요`, { duration: 1800 });
    return;
  }
  toast(`${name}, 관심 종목에서 뺐어요`, {
    duration: 4000,
    action: {
      label: '되돌리기',
      onClick: () => watchStore.set((l) => {
        if (l.some((x) => sameCoin(x.sym, sym))) return l; // 그사이 다시 담았으면 그대로
        const out = l.slice();
        for (const { w, i } of removed) out.splice(Math.min(i, out.length), 0, w); // 앞자리부터 원래 자리에
        return out;
      }),
    },
  });
}
