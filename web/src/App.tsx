import { lazy, Suspense, type ComponentType } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Toaster } from '@/components/ui/sonner';
import { Header } from '@/components/layout/Header';
import { RelayBanner } from '@/components/layout/RelayBanner';
import { CARD_CLS, RowSkeleton } from '@/components/common/Card';
import { useRoute } from '@/lib/router';

export interface PageProps { args: string[] }
// 화면별로 코드를 나눠 처음 열 때 필요한 것만 받는다 (차트 라이브러리는 차트 화면에서만)
const PAGES: Record<string, ComponentType<PageProps>> = {
  recommend: lazy(() => import('@/pages/RecommendPage')),
  market: lazy(() => import('@/pages/MarketPage')),
  picks: lazy(() => import('@/pages/PicksPage')),
  chart: lazy(() => import('@/pages/ChartPage')),
  screener: lazy(() => import('@/pages/ScreenerPage')),
  news: lazy(() => import('@/pages/NewsPage')),
  settings: lazy(() => import('@/pages/SettingsPage')),
};

function PageFallback() {
  return <div className={`${CARD_CLS} p-4`}><RowSkeleton rows={8} /></div>;
}

export default function App() {
  const route = useRoute();
  const Page = PAGES[route.page] || PAGES.recommend;
  return (
    // 기기에서 '동작 줄이기'를 켜면 세그먼트·밑줄이 미끄러지지 않고 바로 바뀐다
    <MotionConfig reducedMotion="user">
      <Header />
      <RelayBanner />
      {/* 휴대폰(<640)은 좌우 여백 없이 카드가 화면 끝까지 닿는다 */}
      <main className="mx-auto max-w-[1248px] px-0 pb-6 sm:px-4 md:px-6 md:pb-8">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={route.page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: 'easeOut' }}>
            <Suspense fallback={<PageFallback />}>
              <Page args={route.args} />
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      <footer className="mx-auto max-w-[1248px] px-4 pt-2 pb-10 text-[12.5px] leading-[1.6] text-muted-foreground md:px-7">
        데이터: 업비트 · 바이낸스 · 네이버 증권 · 야후 파이낸스 · 코인니스 · Google 뉴스. 차트: TradingView Lightweight Charts.
        시세는 늦거나 틀릴 수 있고, 기술적 신호와 AI 예측은 지난 데이터로 만든 참고 자료일 뿐 투자 권유가 아니에요.
      </footer>
      <Toaster />
    </MotionConfig>
  );
}
