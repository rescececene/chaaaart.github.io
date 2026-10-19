// 시장 목록 한 줄 — 자기 종목 시세만 구독하고(useQuote) memo 로 감싸서, 시세 하나가 바뀌어도 그 줄만 다시 그린다.
// 휴대폰: 토스식 두 줄 행(순위·로고·이름/코드 · 가격/등락) / PC(lg): 같은 DOM 을 열 정렬된 표로 펼친다.
import { memo } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText, Flash } from '@/components/common/Change';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuote } from '@/hooks/market';
import { tickerOf } from '@/lib/coins';
import { ccyOf, fmtAmount, fmtPct } from '@/lib/format';
import { kimp, MARKETS, nameOf, split, type Sym } from '@/lib/market';
import { href } from '@/lib/router';
import { exLabel, GRID, onStar, priceText, ROW_GRID } from './shared';
import { rememberSpot, type Tab } from './sort';

function WarnBadge() {
  return (
    <span title="업비트 투자 유의 종목" className="shrink-0 rounded-[5px] bg-warn/15 px-1 text-[10.5px] leading-4 font-bold text-[color-mix(in_srgb,var(--warn)_55%,var(--foreground))]">
      유의
    </span>
  );
}
const Dot = () => <span className="mx-[3px] text-faint" aria-hidden>·</span>;

export interface RowProps {
  sym: Sym;
  rank: number;
  tab: Tab;
  /** 휴대폰 둘째 줄에 보일 값 — 정렬 기준에 맞춘다 */
  metric: 'vol' | 'cap';
  watched: boolean;
  /** 일부만 지연 시세일 때만 줄마다 '지연' 표시 (전부 지연이면 위에서 한 번만 알린다) */
  markDelay: boolean;
  /** 김프 기준(바이낸스 가격·환율)이 바뀌면 값이 달라지므로 다시 그린다 */
  kimpKey: string;
  /** 종목 이름표가 바뀌면 다시 그린다 */
  namesV: number;
}

export const MarketRow = memo(function MarketRow({ sym, rank, tab, metric, watched, markDelay }: RowProps) {
  const q = useQuote(sym);
  const [market] = split(sym);
  const n = nameOf(sym);
  const ccy = ccyOf(market);
  const watchTab = tab === 'watch';
  const stock = market === 'krx' || market === 'us';
  const k = market === 'upbit' && !watchTab ? kimp(n.sub, q?.price) : null;
  const delayed = markDelay && q != null && !q.live;
  const ex = exLabel(n.ex);
  const metricText = !q ? null
    : metric === 'cap' ? (q.cap != null ? `시총 ${fmtAmount(q.cap, ccy)}` : null)
      : q.vol != null ? (stock ? `거래 ${fmtAmount(q.vol, ccy)}` : fmtAmount(q.vol, ccy)) : null;

  return (
    <div
      data-sym={sym}
      className={cn(
        'relative grid', ROW_GRID, GRID[tab],
        'min-h-[62px] py-2 pr-1 pl-4 lg:h-14 lg:min-h-0 lg:rounded-[12px] lg:px-2 lg:py-0',
        'transition-colors duration-150 hover:bg-hover has-[>a:active]:bg-secondary/70',
        // 화면 밖 줄은 그리지 않는다 — 자리 크기는 '안쪽(padding 제외)' 높이: 휴대폰 62-16=46, PC 56
        '[contain-intrinsic-size:auto_46px] [content-visibility:auto] lg:[contain-intrinsic-size:auto_56px]',
      )}
    >
      {/* 세 자리 순위도 로고와 간격을 지키도록 오른쪽 정렬 (넘치면 왼쪽 여백으로) */}
      <span className="flex justify-end text-[13px] font-semibold whitespace-nowrap text-muted-foreground tabular lg:justify-center lg:text-[13.5px] lg:font-medium">{rank}</span>
      <SymbolLogo sym={sym} size={36} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{n.name}</span>
          {n.warn && <WarnBadge />}
        </div>
        {/* PC: 코드 · 거래소 (값은 오른쪽 열에)
            휴대폰: 코드 · (거래대금|시총) · 김프 — 화면 폭에 따라 덜 중요한 것부터 뺀다
            (기준 폭은 가장 긴 가격 줄 기준으로 잰 값: 업비트 110,000,000 · 국내 1,000,000) — 줄마다 들쭉날쭉하지 않게 화면 폭으로 정한다 */}
        <div className="truncate text-[12.5px] leading-[18px] text-muted-foreground tabular">
          {/* 관심 탭은 여러 시장이 섞이므로 시장(코인은 거래소) · 코드 — 바이낸스도 'SOL/USDT' 대신 'SOL' (단위는 거래소 이름이 말해 준다) */}
          {watchTab ? <>{MARKETS[market].name}<Dot />{tickerOf(market, n.sub)}</> : (
            <>
              <span className="hidden lg:inline">{tickerOf(market, n.sub)}{ex && <><Dot />{ex}</>}</span>
              <span className="lg:hidden">
                {tickerOf(market, n.sub)}
                {metricText && <span className={cn(market === 'upbit' ? 'hidden min-[412px]:inline' : stock ? 'max-[359px]:hidden' : '')}><Dot />{metricText}</span>}
                {k != null && <span className="max-[359px]:hidden"><Dot />김프 {fmtPct(k, 1)}</span>}
                {stock && ex && <span className="hidden min-[400px]:inline"><Dot />{ex}</span>}
              </span>
            </>
          )}
          {delayed && <span className="ml-1.5 rounded-[4px] bg-secondary px-1 text-[10.5px] font-semibold text-muted-foreground">지연</span>}
        </div>
      </div>
      {/* 가격·등락 — 휴대폰은 오른쪽 두 줄, PC 는 각자 열 (lg:contents) */}
      <div className="flex flex-col items-end gap-px lg:contents">
        {q ? (
          <>
            <Flash value={q.price} className="-mx-1 px-1 lg:justify-self-end">
              <span className="text-[15px] leading-5 font-semibold tracking-[-0.01em] tabular">{priceText(q.price, market)}</span>
            </Flash>
            <ChangeText value={q.chg} className="text-[13px] leading-[18px] font-medium lg:justify-self-end lg:text-[14px] lg:font-semibold" />
          </>
        ) : (
          <>
            <Skeleton className="h-4 w-20 lg:justify-self-end" />
            <Skeleton className="mt-1 h-3.5 w-12 lg:mt-0 lg:justify-self-end" />
          </>
        )}
      </div>
      <span className="hidden text-right text-[14px] text-secondary-foreground tabular lg:block">{q ? fmtAmount(q.vol, ccy) : ''}</span>
      {tab === 'upbit' && <span className="hidden text-right text-[14px] text-secondary-foreground tabular lg:block">{k == null ? '–' : fmtPct(k)}</span>}
      {(tab === 'krx' || tab === 'us') && <span className="hidden text-right text-[14px] text-secondary-foreground tabular lg:block">{q ? fmtAmount(q.cap, ccy) : ''}</span>}
      {/* 줄 전체가 차트로 가는 링크 — 별 버튼만 그 위에 따로 */}
      <a
        href={href('chart', sym)}
        onClick={(e) => {
          // 새 탭으로 여는 클릭(⌘/Ctrl/Shift/가운데)은 이 화면을 떠나지 않으므로 자리를 기억하지 않는다
          if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) rememberSpot(tab, sym, e.currentTarget.getBoundingClientRect().top);
        }}
        aria-label={`${n.name} 차트 보기`}
        className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <button
        type="button"
        onClick={() => onStar(sym)}
        aria-pressed={watched}
        aria-label={watched ? `${n.name} 관심 종목에서 빼기` : `${n.name} 관심 종목에 담기`}
        className={cn(
          'press relative z-10 grid h-10 w-8 place-items-center justify-self-end rounded-lg transition-colors hover:bg-secondary lg:mr-1 lg:size-8',
          watched ? 'text-warn' : 'text-faint hover:text-muted-foreground',
        )}
      >
        <Star className={cn('size-[18px]', watched && 'fill-current')} strokeWidth={watched ? 1.5 : 2} />
      </button>
    </div>
  );
});
