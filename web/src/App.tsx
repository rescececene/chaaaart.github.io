import { lazy, Suspense, type ComponentType } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster } from '@/components/ui/sonner';
import { Header } from '@/components/layout/Header';
import { RelayBanner } from '@/components/layout/RelayBanner';
import { RowSkeleton } from '@/components/common/Card';
import { useRoute } from '@/lib/router';

export interface PageProps { args: string[] }
// 화면별로 코드를 나눠 처음 열 때 필요한 것만 받는다 (차트 라이브러리는 차트 화면에서만)
const PAGES: Record<string, ComponentType<PageProps>> = {
  market: lazy(() => import('@/pages/MarketPage')),
  picks: lazy(() => import('@/pages/PicksPage')),
  chart: lazy(() => import('@/pages/ChartPage')),
  screener: lazy(() => import('@/pages/ScreenerPage')),
  news: lazy(() => import('@/pages/NewsPage')),
  settings: lazy(() => import('@/pages/SettingsPage')),
};

function PageFallback() {
  return <div className="rounded-[20px] bg-card p-4"><RowSkeleton rows={8} /></div>;
}

export default function App() {
  const route = useRoute();
  const Page = PAGES[route.page] || PAGES.market;
  return (
    <>
      <Header />
      <RelayBanner />
      <main className="mx-auto max-w-[1240px] px-3 py-4 sm:px-4 md:px-6 md:py-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={route.page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: 'easeOut' }}>
            <Suspense fallback={<PageFallback />}>
              <Page args={route.args} />
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      <footer className="mx-auto max-w-[1240px] px-4 pt-2 pb-10 text-[12px] leading-relaxed break-keep text-subtle md:px-6">
        데이터: 업비트 · 바이낸스 · 네이버 증권 · 야후 파이낸스 · 코인니스 · Google 뉴스. 시세는 지연·오류가 있을 수 있고,
        기술적 신호와 예측은 과거 데이터에 기반한 참고 자료일 뿐 투자 권유가 아닙니다.
      </footer>
      <Toaster />
    </>
  );
}
