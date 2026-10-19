// 뉴스 과거 검증 (data/news_state.json — collector/news_hist.py) 을 화면에 옮기는 부품
//  - 호재·악재 표시는 참고용 — 과거 가격 차이는 거의 없었다는 한 줄 (+ 펼치면 요약 표)
//  - 업비트 신규 상장 뒤 과거 결과 (뉴스 공지 카드 한 줄 · 차트 화면 주의 카드)
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { signedPct } from '@/components/common/Change';
import { newsState } from '@/lib/market';
import { listingStudy, moodEffect, type ListingStudy, type NewsState, type StudyGroup } from '@/lib/newsTag';
import { cn } from '@/lib/utils';

/** 뉴스 과거 검증 파일 — 정적 파일(11KB 안팎), 중계 요청 없음 */
export function useNewsState(enabled = true) {
  return useQuery({ queryKey: ['newsState'], queryFn: () => newsState() as Promise<NewsState>, enabled, staleTime: 5 * 60e3, retry: 0 });
}

/** 주황 경고 글자 — 빨강·파랑은 가격 방향 전용이라 주의 표시에 쓰지 않는다 (흰 카드·옅은 주황 바탕 모두 4.5:1 이상) */
export const WARN_TEXT = 'text-[color-mix(in_srgb,var(--warn)_58%,var(--foreground))]';
const pct0 = (x: number) => `${Math.round(x)}%`;
const B = 'font-semibold text-foreground tabular';

/** 14289 → '1만 4천여', 2350 → '2천여', 830 → '830' */
export function approxCount(n: number) {
  if (n >= 1e4) {
    const man = Math.floor(n / 1e4), cheon = Math.floor((n % 1e4) / 1e3);
    return `${man}만${cheon ? ` ${cheon}천` : ''}여`;
  }
  if (n >= 1e3) return `${Math.floor(n / 1e3)}천여`;
  return String(n);
}

/** '과거 업비트 신규 상장 153건: 7일 뒤 중앙값 −11.4%, 오른 비율 24%' (공지 카드용 짧은 줄) */
export function ListingStudyLine({ ls, className }: { ls: ListingStudy; className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 rounded-xl bg-warn/12 px-3 py-2 text-[13px] leading-[1.5] text-secondary-foreground', className)}>
      <TriangleAlert aria-hidden className="mt-[2px] size-3.5 shrink-0 text-warn" />
      <span className="min-w-0 break-keep">
        과거 업비트 신규 상장 <b className={B}>{ls.n}건</b>: 7일 뒤 중앙값 <b className={B}>{signedPct(ls.med7, 1)}</b>, 오른 비율 <b className={B}>{pct0(ls.win7)}</b>
      </span>
    </p>
  );
}

/** 차트 화면 — 최근 업비트에 새로 상장한 코인의 주의 카드 (같은 숫자 + 보통 코인과 비교) */
export function ListingCaution({ ls, className }: { ls: ListingStudy; className?: string }) {
  return (
    <div role="note" className={cn('rounded-2xl bg-warn/12 px-4 py-3.5', className)}>
      <p className="flex items-center gap-1.5 text-[15px] font-bold text-foreground">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />최근 업비트에 새로 상장한 코인이에요
      </p>
      <p className="mt-1.5 text-[13.5px] leading-[1.6] break-keep text-secondary-foreground">
        과거 업비트 신규 상장 <b className={B}>{ls.n}건</b>: 7일 뒤 중앙값 <b className={B}>{signedPct(ls.med7, 1)}</b>, 오른 비율 <b className={B}>{pct0(ls.win7)}</b>
        {ls.med30 != null ? <> (30일 뒤 중앙값 <span className="tabular">{signedPct(ls.med30, 1)}</span>)</> : null}.
        {ls.baseMed7 != null && ls.baseWin7 != null ? (
          <> 같은 기간 뉴스가 나온 보통 코인은 7일 뒤 중앙값 <span className="tabular">{signedPct(ls.baseMed7, 1)}</span>, 오른 비율 <span className="tabular">{pct0(ls.baseWin7)}</span>였어요.</>
        ) : null}
      </p>
      <p className="mt-1 text-[12.5px] leading-[1.55] break-keep text-muted-foreground">상장 직후 오른 뒤 내린 경우가 많았어요. 앞으로도 그렇다는 뜻은 아니니 참고만 해 주세요.</p>
    </div>
  );
}

// 요약 표에 보여 줄 묶음과 짧은 이름 (보통 기사가 기준)
const ROWS: [key: string, name: string][] = [
  ['news', '보통 기사'], ['voteGood', '투표 호재'], ['voteBad', '투표 악재'], ['kwGood', '제목에 좋은 말'], ['kwBad', '제목에 나쁜 말'],
  ['hack', '해킹·도난'], ['delist', '상폐·유의 소식'], ['glList', '해외 거래소 상장'], ['krListNew', '업비트 신규 상장'],
];
const VERDICT: Record<StudyGroup['use'], string> = { base: '기준', weak: '차이 작음', none: '뚜렷한 차이 없음', caution: '뚜렷하게 약함' };

/** 펼친 근거 — 묶음별 7일 뒤 수익률 중앙값 · 오른 비율 (기사 다음 날 종가에 샀다고 보고) */
function StudyTable({ st }: { st: NewsState }) {
  const g = st.study?.groups ?? {};
  const d = st.study?.data;
  const rows = ROWS.flatMap(([k, name]) => {
    const grp = g[k], h = grp?.h?.['7'];
    return grp && h && h.raw?.length === 5 && Number.isFinite(h.rawWin) ? [{ k, name, use: grp.use, h }] : [];
  });
  const base = g.news?.h?.['7'];
  if (!rows.length) return null;
  return (
    <div className="mt-2.5 rounded-xl bg-tile px-3.5 py-3 text-secondary-foreground sm:max-w-[600px]">
      {d?.articles ? (
        <p className="text-[12.5px] leading-[1.55] break-keep">
          코인니스 코인 속보 <b className="font-semibold tabular">{d.articles.toLocaleString('ko-KR')}건</b>
          {d.period?.[0] && d.period?.[1] ? <span className="tabular"> ({d.period[0].slice(0, 7).replace('-', '.')}~{d.period[1].slice(0, 7).replace('-', '.')})</span> : null}이
          나온 다음 날 종가에 샀다고 보고, 7일 뒤 업비트 가격을 확인했어요.
        </p>
      ) : null}
      <table className="mt-2 w-full border-collapse text-[12.5px]">
        <caption className="sr-only">뉴스 묶음별 7일 뒤 수익률</caption>
        <thead>
          <tr className="text-left text-[12px] text-muted-foreground">
            <th scope="col" className="py-1 font-medium">묶음</th>
            <th scope="col" className="py-1 text-right font-medium whitespace-nowrap">7일 뒤 중앙값</th>
            <th scope="col" className="py-1 pl-3 text-right font-medium whitespace-nowrap">오른 비율</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ k, name, use, h }) => {
            const warn = use === 'caution';
            return (
              <tr key={k} className={cn('border-t border-border', warn && 'bg-warn/12')}>
                <th scope="row" className={cn('py-1.5 text-left font-normal', warn && 'pl-1.5')}>
                  <span className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className={cn('font-semibold', warn ? WARN_TEXT : 'text-foreground')}>{name}</span>
                    <span className="text-[11.5px] text-muted-foreground tabular">{h.n.toLocaleString('ko-KR')}건</span>
                  </span>
                  <span className={cn('block text-[11.5px]', warn ? cn('font-semibold', WARN_TEXT) : 'text-muted-foreground')}>{VERDICT[use]}</span>
                </th>
                <td className="py-1.5 text-right align-top font-semibold tabular">{signedPct(h.raw[2], 1)}</td>
                <td className={cn('py-1.5 pl-3 text-right align-top font-semibold tabular', warn && 'pr-1.5')}>{pct0(h.rawWin)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {base ? (
        <p className="mt-2 text-[12px] leading-[1.55] break-keep text-muted-foreground">
          코인 7일 수익률은 보통 가운데 절반이 <span className="tabular">{signedPct(base.raw[1], 0)}~{signedPct(base.raw[3], 0)}</span> 사이로 움직여요.
          그에 비하면 호재·악재 뒤 차이는 아주 작았고, 업비트 신규 상장만 뚜렷하게 약했어요. BTC·ETH 는 날마다 기사가 있어 뺐어요.
        </p>
      ) : null}
    </div>
  );
}

/** 뉴스 화면 — 호재·악재 표시가 참고용임을 정직하게 한 줄 + 근거(요약 표) 펼치기. 아래엔 이 주제의 판단 방식(children).
 *  coin: 코인 주제(과거 검증 숫자를 쓴다) · 주식 주제는 코인 속보로만 검증했으니 숫자 없이 말한다 */
export function MoodNote({ st, coin, children, className }: { st: NewsState | undefined; coin: boolean; children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const eff = coin ? moodEffect(st) : null;
  const ls = coin ? listingStudy(st) : null;
  return (
    <div className={cn('text-[12.5px] leading-[1.6] text-muted-foreground', className)}>
      <p className="break-keep">
        <b className="font-semibold text-secondary-foreground">호재·악재 표시는 참고용이에요.</b>{' '}
        {eff ? <>{eff.articles ? `과거 코인 속보 ${approxCount(eff.articles)} 건을` : '과거 코인 속보를'} 확인해 보니 일반 호재·악재 뒤 가격 차이는 거의 없었어요{ls ? ' (업비트 신규 상장만 예외)' : ''}.</>
          : coin ? '기사 분위기일 뿐, 가격이 그렇게 움직인다는 뜻은 아니에요.' : '기사 분위기일 뿐, 주가가 그렇게 움직인다는 뜻은 아니에요.'}
        {eff && st ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            className="press ml-1 inline-flex items-center gap-0.5 rounded font-semibold whitespace-nowrap text-secondary-foreground hover:text-foreground">
            근거 {open ? '접기' : '보기'}<ChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        ) : null}
      </p>
      {open && eff && st ? <StudyTable st={st} /> : null}
      {children ? <p className="mt-1 break-keep">{children}</p> : null}
    </div>
  );
}
