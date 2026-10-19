// 종목 로고 — 코인은 업비트 로고(티커), 주식은 네이버 증권 로고. 없으면 이니셜 원으로 대체(SymbolLogo 컴포넌트)
import { nameOf, split, type Sym } from './market';

export function logoUrl(sym: Sym): string {
  const [market, code] = split(sym);
  if (market === 'upbit') return `https://static.upbit.com/logos/${code.slice(4)}.png`;
  if (market === 'binance') return `https://static.upbit.com/logos/${nameOf(sym).sub.split('/')[0]}.png`;
  return `https://ssl.pstatic.net/imgstock/fn/real/logo/stock/Stock${code}.svg`;
}
