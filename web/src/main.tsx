import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initTheme } from '@/lib/theme';
import { loadCoins, Relay } from '@/lib/market';
import { seedNames } from '@/stores';
import App from './App';
import './index.css';

// ?relay=주소&key=키 로 열면 중계 설정을 저장하고 주소창에서 지운다 (개발·다른 중계용)
const qs = new URLSearchParams(location.search);
if (qs.get('relay')) {
  Relay.save({ url: qs.get('relay')!, key: qs.get('key') || '' });
  history.replaceState(null, '', location.pathname + location.hash);
}
initTheme();
seedNames();
void loadCoins();

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
