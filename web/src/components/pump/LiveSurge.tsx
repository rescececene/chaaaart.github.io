// '지금 움직이는 코인' — 업비트 원화 전 종목 실시간 시세로 1분·5분 급등 + 거래대금 쏠림을 잡는다 (lib/market/surge.ts)
// 수집기를 기다리지 않는 실시간 감지. 과거 검증을 거친 점수가 아니라서 그렇게 적고, 펌핑 후보 점수가 있으면 같이 보여 준다.
import { memo, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { useInterval, useNamesVersion, useWant } from '@/hooks/market';
import { coinsLoaded, loadCoins, nameOf } from '@/lib/market';
import { pumpData, tickerOfCode } from '@/lib/market/pump';
import { startSurge, surgeList, surgeWatched, SURGE_RULE, type Surge } from '@/lib/market/surge';
import { href } from '@/lib/router';
import { eok, sp } from './parts';

const ALL = ['upbit:*'];

/** 실시간 감지를 켜고 2초마다 결과를 다시 읽는다 */
export function useSurge(on = true) {
  // '업비트 전체' 구독은 코인 목록(coins.json)을 받은 뒤에야 코드로 풀린다
  const [ready, setReady] = useState(coinsLoaded);
  useEffect(() => { if (!ready) void loadCoins().then(() => setReady(true)); }, [ready]);
  useWant(on && ready ? ALL : null);
  useEffect(() => (on ? startSurge() : undefined), [on]);
  const [state, setState] = useState<{ list: Surge[]; watched: number }>({ list: [], watched: 0 });
  useInterval(() => setState({ list: surgeList(), watched: surgeWatched() }), on ? 2000 : null);
  return state;
}

const Row = memo(function Row({ s, cand }: { s: Surge; cand: number | null }) {
  const code = s.sym.slice(6);
  const name = nameOf(s.sym).name || tickerOfCode(code);
  const mv = s.r5 ?? s.r1;
  const mins = Math.max(1, Math.round(s.win / 60e3));
  return (
    <li>
      <a href={href('chart', s.sym, '1m')}
        className="press -mx-2 grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-hover">
        <SymbolLogo sym={s.sym} size={32} />
        <span className="min-w-0">
          <b className="block truncate text-[15px] leading-5 font-semibold">{name}</b>
          <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground tabular">
            {s.r1 != null ? <>1분 <span className={cn(s.r1 > 0 ? 'text-up-text' : s.r1 < 0 ? 'text-down-text' : '')}>{sp(s.r1)}</span> · </> : null}
            거래 평소의 <b className="font-semibold text-secondary-foreground">{s.burst != null ? `${s.burst >= 10 ? Math.round(s.burst) : s.burst.toFixed(1)}배` : '–'}</b>
            {s.val != null ? <span className="max-sm:hidden"> ({mins}분 {eok(s.val)})</span> : null}
            {cand != null ? <> · 후보 점수 {Math.round(cand)}</> : null}
          </span>
        </span>
        <span className="text-right leading-none">
          <b className="text-[18px] font-bold tracking-[-0.02em] text-up-text tabular">{sp(mv)}</b>
          <span className="mt-1 block text-[11px] text-muted-foreground">{mins}분 사이</span>
        </span>
      </a>
    </li>
  );
});

/** count 개까지. 감지된 게 없으면 '조용해요' 한 줄 (지켜본 시간이 짧으면 그만큼 기다려 달라고) */
export function LiveSurge({ className, count = 5 }: { className?: string; count?: number }) {
  const { list, watched } = useSurge(true);
  useNamesVersion();
  const { data } = useQuery({ queryKey: ['pump'], queryFn: pumpData, staleTime: 3 * 60e3, refetchInterval: 5 * 60e3, retry: 1 });
  const cand = useMemo(() => new Map((data?.all ?? []).map((r) => [r[0], r[2]])), [data]);
  const shown = list.slice(0, count);
  const warm = watched < 60e3;
  return (
    <Card className={className}>
      <CardTitle sub={`업비트 원화 전 종목 · ${Math.round(SURGE_RULE.r1 * 1000) / 10}%(1분)·${Math.round(SURGE_RULE.r5 * 100)}%(5분) 넘게 오르면서 거래가 평소의 ${SURGE_RULE.burst}배 넘게 몰린 코인`}>
        <span className="inline-flex items-center gap-1.5">
          지금 움직이는 코인
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-up-text">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-up" />실시간
          </span>
        </span>
      </CardTitle>
      {shown.length ? (
        <ol>{shown.map((s) => <Row key={s.sym} s={s} cand={cand.get(s.sym.slice(6)) ?? null} />)}</ol>
      ) : (
        <p className="flex items-center gap-2 py-3 text-[13.5px] text-muted-foreground">
          <Activity aria-hidden className="size-4 shrink-0" />
          {warm ? '시세를 모으는 중이에요 — 1분쯤 지나면 보여요.' : '지금 급하게 움직이는 코인은 없어요.'}
        </p>
      )}
      <p className="mt-1.5 text-[12px] leading-[1.55] break-keep text-muted-foreground">
        {list.length > count ? `그 밖에 ${list.length - count}개 더 움직이고 있어요. ` : ''}
        이 화면을 연 뒤부터 지켜본 실시간 감지예요{watched >= 60e3 ? ` (${Math.min(10, Math.floor(watched / 60e3))}분째)` : ''}. 과거 검증을 거친 점수가 아니고, 이미 오른 뒤라 꼭대기일 수도 있어요.
      </p>
    </Card>
  );
}
