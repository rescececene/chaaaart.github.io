// 1시간 뒤 예상을 브라우저에서 — 업비트 시간봉 200개를 화면을 열 때 한 번, 그 뒤 정시(+20초)마다 한 번만 받는다.
// 카드가 여러 개여도 한 시간에 요청은 한 번 (모듈에서 나눠 씀). 탭이 숨었다 돌아왔을 때 시간이 지났으면 그때 다시.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { btcH1Model, upbitHours200, type UpbitHourRaw } from '@/lib/market/btc';
import { forecastH1, toBars, type H1Forecast } from './h1';

const shared: { hour: number; p: Promise<UpbitHourRaw[]> | null } = { hour: -1, p: null };
/** 정시 20초 뒤를 경계로 한 시간 열쇠 — 같은 시간 안에서는 받은 것을 다시 쓴다 */
const hourKey = (ms: number) => Math.floor((ms / 1000 - 20) / 3600);
function hours(ms: number) {
  const k = hourKey(ms);
  if (shared.hour !== k || !shared.p) {
    shared.hour = k;
    shared.p = upbitHours200().catch((e) => { shared.p = null; throw e; });
  }
  return shared.p;
}

export interface H1State { f: H1Forecast | null; loading: boolean; failed: boolean }

export function useBtcH1(): H1State {
  const model = useQuery({ queryKey: ['btc-h1-model'], queryFn: btcH1Model, staleTime: 30 * 60e3, refetchInterval: 60 * 60e3, retry: 1 });
  const [st, setSt] = useState<H1State>({ f: null, loading: true, failed: false });
  const m = model.data;
  useEffect(() => {
    if (!m) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = -1;
    const run = async () => {
      if (timer) clearTimeout(timer);
      const now = Date.now();
      lastKey = hourKey(now);
      try {
        const f = forecastH1(m, toBars(await hours(now), Date.now() / 1000));
        if (alive) setSt({ f, loading: false, failed: !f });
      } catch {
        if (alive) setSt((s) => ({ ...s, loading: false, failed: true }));
      }
      const next = (lastKey + 1) * 3600 * 1000 + 20_000;
      timer = setTimeout(run, Math.max(5_000, next - Date.now()));
    };
    const onVis = () => { if (!document.hidden && hourKey(Date.now()) !== lastKey) void run(); };
    void run();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [m]);
  if (model.isError) return { f: null, loading: false, failed: true };
  return st;
}
