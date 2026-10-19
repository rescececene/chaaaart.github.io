// 시장 목록 한 줄 — 자기 종목 시세만 구독하고(useQuote) memo 로 감싸서, 시세 하나가 바뀌어도 그 줄만 다시 그린다.
// 휴대폰: 토스식 두 줄 행(순위·로고·이름/코드 · 가격/등락) / 태블릿·PC(md): 같은 DOM 을 열 정렬된 표로 펼친다.
import { Fragment, memo } from 'react';
import { cn } from '@/lib/utils';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { ChangeText, Flash, signedPct } from '@/components/common/Change';
import { StarIcon } from '@/components/common/Star';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuote } from '@/hooks/market';
import { tickerOf } from '@/lib/coins';
import { ccyOf, fmtAmount } from '@/lib/format';
import { kimp, MARKETS, nameOf, split, type Sym } from '@/lib/market';
import { href } from '@/lib/router';
import { exLabel, GRID, onStar, priceText, ROW_GRID } from './shared';
import { rememberSpot, type Tab } from './sort';

function WarnBadge() {
  return (
    <span title="업비트 투자 유의 종목" className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-warn/15 px-1 text-[12px] font-bold text-[color-mix(in_srgb,var(--warn)_50%,var(--foreground))]">
      유의
    </span>
  );
}
const Dot = () => <span className="mx-[3px] text-muted-foreground" aria-hidden>·</span>;

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
  /** 전략 탭 — 이 종목이 걸린 근거 (이름 아래 줄 전체 폭에 ' · ' 로 이어 쓴다) */
  why?: readonly string[];
}

const NUM = 'hidden text-right text-[15px] whitespace-nowrap tabular';

export const MarketRow = memo(function MarketRow({ sym, rank, tab, metric, watched, markDelay, why }: RowProps) {
  const q = useQuote(sym);
  const hasWhy = !!why && why.length > 0;
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
        '-mx-2 px-2 md:-mx-3 md:rounded-[14px] md:px-3',
        // 근거 줄이 있으면 두 줄(가격 줄 + 근거) — 높이는 내용대로
        hasWhy ? 'gap-y-1 py-2.5 md:gap-y-0.5 md:py-2' : 'min-h-[62px] md:h-[52px] md:min-h-0',
        'transition-colors duration-150 hover:bg-hover has-[>a:active]:bg-secondary/70',
        // 화면 밖 줄은 그리지 않는다 — 자리 크기는 '안쪽(padding 제외)' 높이: 휴대폰 62, 표 52
        hasWhy ? '[contain-intrinsic-size:auto_64px] [content-visibility:auto] md:[contain-intrinsic-size:auto_62px]'
          : '[contain-intrinsic-size:auto_62px] [content-visibility:auto] md:[contain-intrinsic-size:auto_52px]',
      )}
    >
      {/* 세 자리 순위도 로고와 간격을 지키도록 오른쪽 정렬 (넘치면 왼쪽 여백으로) */}
      <span className="flex justify-end text-[13px] font-semibold whitespace-nowrap text-muted-foreground tabular md:justify-center md:text-[13.5px] md:font-medium">{rank}</span>
      <SymbolLogo sym={sym} size={36} className="md:size-10" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[15px] leading-[21px] font-semibold tracking-[-0.01em] lg:text-[16px] lg:leading-[22px]">{n.name}</span>
          {n.warn && <WarnBadge />}
        </div>
        {/* 코드 · (거래대금|시총) · 김프 — 화면 폭에 따라 덜 중요한 것부터 뺀다 (모든 줄이 같은 규칙: 가격이 긴 줄만 김프가 사라지지 않게)
            360~411: 거래대금을 빼고 김프를 남긴다 · ≥412: 다 보인다 · <360: 코드만 · 태블릿: 코드 · 김프(김프 열이 없으므로) · PC: 코드 · 거래소 */}
        <div className="truncate text-[12.5px] leading-[18px] text-muted-foreground tabular min-[390px]:text-[13px]">
          {/* 관심 탭은 여러 시장이 섞이므로 시장(코인은 거래소) · 코드 — 바이낸스도 'SOL/USDT' 대신 'SOL' (단위는 거래소 이름이 말해 준다) */}
          {watchTab ? <>{MARKETS[market].name}<Dot />{tickerOf(market, n.sub)}</> : (
            <>
              {tickerOf(market, n.sub)}
              {metricText && <span className={cn('md:hidden', market === 'upbit' ? 'hidden min-[412px]:inline' : stock ? 'max-[359px]:hidden' : '')}><Dot />{metricText}</span>}
              {k != null && <span className="max-[359px]:hidden lg:hidden"><Dot />김프 {signedPct(k, 1)}</span>}
              {stock && ex && <span className="hidden min-[400px]:inline"><Dot />{ex}</span>}
            </>
          )}
          {delayed && <span className="ml-1.5 rounded-[4px] bg-secondary px-1 text-[12px] font-semibold text-muted-foreground">지연</span>}
        </div>
      </div>
      {/* 가격·등락 — 휴대폰은 오른쪽 두 줄, 표에서는 각자 열 (md:contents) */}
      <div className="flex flex-col items-end md:contents">
        {q ? (
          <>
            <Flash value={q.price} className="-mx-1 px-1 md:justify-self-end">
              <span className="text-[15px] leading-[21px] font-semibold tracking-[-0.01em] tabular lg:text-[16px]">{priceText(q.price, market)}</span>
            </Flash>
            <ChangeText value={q.chg} className="text-[13px] leading-[18px] font-medium md:justify-self-end md:text-[15px] md:font-semibold" />
          </>
        ) : (
          <>
            <Skeleton className="h-4 w-20 bg-secondary md:justify-self-end" />
            <Skeleton className="mt-1 h-3.5 w-12 bg-secondary md:mt-0 md:justify-self-end" />
          </>
        )}
      </div>
      {/* 거래대금 — 코인·관심은 태블릿부터, 주식은 PC 에서만 (태블릿은 시가총액 열) */}
      <span className={cn(NUM, 'text-secondary-foreground', stock && !watchTab ? 'lg:block' : 'md:block')}>{q ? fmtAmount(q.vol, ccy) : ''}</span>
      {/* 김프 — 부호만, 중립색 (방향이 아닌 값) */}
      {tab === 'upbit' && <span className={cn(NUM, 'text-text-3 lg:block')}>{k == null ? '–' : signedPct(k)}</span>}
      {(tab === 'krx' || tab === 'us') && <span className={cn(NUM, 'text-secondary-foreground md:block')}>{q ? fmtAmount(q.cap, ccy) : ''}</span>}
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
      {/* 별 — 휴대폰은 보이는 별 17px · 누르는 곳 44×44 */}
      <button
        type="button"
        onClick={() => onStar(sym)}
        aria-pressed={watched}
        aria-label={watched ? `${n.name} 관심 종목에서 빼기` : `${n.name} 관심 종목에 담기`}
        className={cn(
          'press relative z-10 -mr-2 grid size-11 place-items-center justify-self-end rounded-lg transition-colors hover:bg-secondary md:mr-0 md:size-8',
          watched ? '' : 'text-faint hover:text-muted-foreground',
        )}
      >
        <StarIcon on={watched} className="size-[17px] md:size-[18px]" />
      </button>
      {/* 전략 근거 — 이름 칸부터 줄 끝까지 (휴대폰은 두 줄까지) — 별 버튼 뒤에 둬야 첫 줄 칸 배치가 그대로다.
          줄은 어절 사이에서만 바뀌고(break-keep), '·' 는 앞 근거에 붙여 줄 머리에 오지 않게 */}
      {hasWhy && (
        <p className="col-[3/-1] line-clamp-2 text-[12.5px] leading-[18px] break-keep text-text-3 min-[390px]:text-[13px] md:line-clamp-1">
          {why.map((t, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              {t}{i < why.length - 1 && <span className="text-faint">{'\u00a0·'}</span>}
            </Fragment>
          ))}
        </p>
      )}
    </div>
  );
});
