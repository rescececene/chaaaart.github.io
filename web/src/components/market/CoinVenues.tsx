// 코인 거래소 — 거래소 고르기(시장 · 종목 골라보기 · 유망 종목)와 검색 결과의 거래소 배지
import { cn } from '@/lib/utils';
import { Segmented } from '@/components/common/Segmented';
import { COIN_EXES, coinExOf, EX_NAME, EX_UNIT, venuesOf, type CoinEx } from '@/lib/coins';
import type { Sym } from '@/lib/market';

const EX_ITEMS = COIN_EXES.map((ex) => ({
  value: ex,
  // 보조 글자는 500 회색 — 앞 공백이 flex 에서 사라지므로 여백으로 띄운다
  label: <>{EX_NAME[ex]}<span className="ml-[.3em] font-medium text-muted-foreground">· {EX_UNIT[ex]}</span></>,
}));

/** [업비트 · 원화 | 바이낸스 · USDT] — 휴대폰은 폭 가득, 넓은 화면은 320px.
 *  회색 바탕 위에 놓이면 홈이 바탕과 같은 색이 되어 흰 손잡이만 보인다 (토스식) */
export function CoinExSwitch({ value, onChange, className }: { value: CoinEx; onChange: (ex: CoinEx) => void; className?: string }) {
  return (
    <div role="group" aria-label="코인 거래소" className={className}>
      <Segmented full items={EX_ITEMS} value={value} onChange={onChange} className="md:w-80" />
    </div>
  );
}

/** 이 코인을 볼 수 있는 거래소 — 업비트 · 바이낸스 (주식이면 아무것도 그리지 않는다) */
export function VenueBadges({ sym, className }: { sym: Sym; className?: string }) {
  const list = coinExOf(sym) ? venuesOf(sym) : [];
  if (!list.length) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {list.map((s) => (
        <span key={s} className="rounded-md bg-secondary px-1.5 text-[12px] leading-5 font-semibold whitespace-nowrap text-muted-foreground">
          {EX_NAME[coinExOf(s)!]}
        </span>
      ))}
    </span>
  );
}
