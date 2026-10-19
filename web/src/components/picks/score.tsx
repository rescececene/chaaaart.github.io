// 예측 점수 표현 공용 — 점수는 '시장 이길 확률'(대략 35~60%)이고, 큰 'NN점' 숫자는 쓰지 않는다
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { MARKETS, predictHourly, type Market, type ModelGrade, type OutlookGrade, type OutlookItem, type PredictHourly, type PredictScoreFields } from '@/lib/market';

export const GRADE_INFO: Record<ModelGrade, { text: string; title: string; cls: string }> = {
  strong: { text: '검증 강함', title: '이 시장 모델은 학습에 안 쓴 과거 기간에서도 순위 예측력이 뚜렷했어요', cls: 'text-secondary-foreground before:size-1.5 before:rounded-full before:bg-good' },
  weak: { text: '검증 약함', title: '과거 검증에서 순위 예측력이 약했어요 — 확률을 절반만 반영했어요', cls: 'text-muted-foreground before:size-1.5 before:rounded-full before:bg-faint' },
  none: { text: '근거 없음', title: '과거 검증에서 순위 예측력이 없었어요', cls: 'bg-secondary px-1.5 text-muted-foreground' },
};

/** 검증 등급 배지 — 점(색) + 글자 */
export function GradeBadge({ grade, label, className }: { grade: ModelGrade | undefined; label?: string; className?: string }) {
  if (!grade) return null;
  const g = GRADE_INFO[grade] ?? GRADE_INFO.none;
  return (
    <span title={g.title} className={cn('inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md text-[12.5px] font-semibold whitespace-nowrap', g.cls, className)}>
      {label || g.text}
    </span>
  );
}

/** 기간 단위 — 코인 '일', 주식 '거래일' */
export const dayUnit = (market: Market) => (MARKETS[market].coin ? '일' : '거래일');

/** '시장 상위 2%' — pctRank 100 = 1등 */
export function topText(pctRank: number | null | undefined) {
  if (pctRank == null || !Number.isFinite(pctRank)) return null;
  const top = 100 - pctRank;
  return `시장 상위 ${top < 1 ? '1' : Math.round(top)}%`;
}

/** 시장 이길 확률(0~1). 옛 파일은 probUp, 그것도 없으면 null */
export const beatProb = (p: PredictScoreFields & { probUp?: number | null }) =>
  p.hold ? null : p.probBeat ?? p.probUp ?? null;

/** '1시간' · '1일' · '1주' — unit 'h' 는 시간, 'd' 는 코인 일·주식 거래일(5거래일 = 1주) */
export function outlookName(o: Pick<OutlookItem, 'h' | 'unit'>, coin: boolean) {
  if (o.unit === 'h') return `${o.h}시간`;
  if (o.h === 1) return '1일';
  const week = coin ? 7 : 5;
  if (o.h >= week && o.h % week === 0) return `${o.h / week}주`;
  if (!coin && o.h >= 20 && o.h % 20 === 0) return `${o.h / 20}달`;
  return `${o.h}${coin ? '일' : '거래일'}`;
}

/** 1시간 예측 파일 (시장별 작은 정적 파일, 매시간 갱신) */
export function useHourly(market: Market | null | undefined) {
  return useQuery({
    queryKey: ['predict-hourly', market], queryFn: () => predictHourly(market!), enabled: !!market,
    staleTime: 5 * 60e3, refetchInterval: 10 * 60e3, retry: false,
  });
}

type HourlyCell = PredictHourly['items'][string];
/** outlook 의 1시간 줄(unit 'h')을 최신 1시간 파일 값으로 덮는다 — 파일이 더 새것일 때만. code = sym 의 코드 부분 */
export function withHourly<T extends { h: number; unit?: 'h' | 'd'; grade: OutlookGrade; asOf?: string }>(
  items: T[], hr: PredictHourly | undefined, code: string,
): (T & Partial<HourlyCell> & { asOf?: string; src?: string })[] {
  const cell = hr?.items?.[code];
  if (!hr || !cell) return items;
  return items.map((o) => {
    if (o.unit !== 'h') return o;
    if (o.asOf && hr.asOf && Date.parse(o.asOf) > Date.parse(hr.asOf)) return o;
    return { ...o, ...cell, grade: hr.grade ?? o.grade, asOf: hr.asOf, src: 'hourly' };
  });
}
