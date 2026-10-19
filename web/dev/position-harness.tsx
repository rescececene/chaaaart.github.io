// 개발용(빌드에 포함 안 됨) — dev/position.html 에서 PositionCard 를 실제 데이터로 띄운다. 쓰는 법은 position.html 주석
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Card, CardTitle } from '@/components/common/Card';
import { PositionCard, positionStore } from '@/components/chart/PositionCard';
import { useQuote } from '@/hooks/market';
import { initTheme } from '@/lib/theme';
import { isValidSym, loadCoins, nameOf, Relay, type Sym } from '@/lib/market';
import { seedNames } from '@/stores';
import '@/index.css';

const qs = new URLSearchParams(location.search);
if (qs.get('relay')) Relay.save({ url: qs.get('relay')!, key: qs.get('key') || '' });
initTheme();
seedNames();
void loadCoins();

const sym: Sym = qs.get('sym') && isValidSym(qs.get('sym')!) ? qs.get('sym')! : 'upbit:KRW-BTC';
const layout = qs.get('layout') || 'mobile';
const num = (k: string) => { const v = Number(qs.get(k)); return qs.get(k) && Number.isFinite(v) && v > 0 ? v : undefined; };
if (qs.get('clear')) positionStore.set((p) => { const n = { ...p }; delete n[sym]; return n; });
else if (num('avg')) positionStore.set((p) => ({ ...p, [sym]: { avg: num('avg')!, ...(num('qty') ? { qty: num('qty') } : {}), at: Date.now() } }));

/** mul 이 있으면 현재가가 처음 왔을 때(페이지마다 한 번) 평단 = 현재가 × mul 로 저장 */
let seeded = false;
function Seeder() {
  const q = useQuote(sym);
  const mul = num('mul');
  useEffect(() => {
    if (seeded || !mul || q?.price == null || qs.get('clear') || num('avg')) return;
    seeded = true;
    const avg = +(q.price * mul).toPrecision(6);
    positionStore.set((p) => ({ ...p, [sym]: { avg, ...(num('qty') ? { qty: num('qty') } : {}), at: Date.now() } }));
  }, [q?.price, mul]);
  return null;
}

function Harness() {
  const card = <PositionCard sym={sym} />;
  const n = nameOf(sym);
  return (
    <main className="mx-auto max-w-[1240px] px-3 py-4 sm:px-4 md:px-6 md:py-6">
      <Seeder />
      <p className="mb-3 px-1 text-[13px] text-muted-foreground">{n.name} · {sym}</p>
      {layout === 'mobile' ? card : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            {layout === 'left' ? card : <Card><CardTitle>AI 예측</CardTitle><div className="h-40 rounded-2xl bg-secondary/60" /></Card>}
          </div>
          <div className="min-w-0 space-y-3">
            {layout === 'right' ? card : null}
            <Card><CardTitle>뉴스</CardTitle><div className="h-40 rounded-2xl bg-secondary/60" /></Card>
          </div>
        </div>
      )}
    </main>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <Harness />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
