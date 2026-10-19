import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initTheme } from '@/lib/theme';
import { loadCoins, Relay } from '@/lib/market';
import { seedNames, watchStore } from '@/stores';
import App from './App';
import './index.css';

// ?relay=주소&key=키 로 열면 중계 설정을 저장하고 주소창에서 지운다 — 개발용이라 이 컴퓨터(localhost)의 중계만 받는다.
// (다른 주소를 받으면 남이 보낸 링크 하나로 중계를 몰래 바꿔 가짜 시세·뉴스를 보여 줄 수 있다 — 다른 중계는 설정 화면에서 직접)
const qs = new URLSearchParams(location.search);
if (qs.get('relay')) {
  try {
    const u = new URL(qs.get('relay')!);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && /^https?:$/.test(u.protocol)) Relay.save({ url: u.origin, key: qs.get('key') || '' });
  } catch { /* 주소가 아니면 무시 */ }
  history.replaceState(null, '', location.pathname + location.hash);
}
initTheme();
void loadCoins();
// 암호화해 둔 관심종목을 푼 뒤 그린다 (보통 수 ms — 오래 걸려도 0.8초 뒤엔 그냥 그린다)
await Promise.race([watchStore.ready(), new Promise((r) => setTimeout(r, 800))]);
seedNames();
watchStore.subscribe(seedNames);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
