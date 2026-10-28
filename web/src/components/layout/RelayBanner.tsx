import { CircleAlert } from 'lucide-react';
import { useRelay, useStockError } from '@/hooks/market';
import { href, useRoute } from '@/lib/router';

/** 주식이 지연 데이터일 때만 보이는 안내 */
export function RelayBanner() {
  const { ok } = useRelay();
  const err = useStockError();
  const route = useRoute();
  if (route.page === 'settings' || route.page === 'news') return null;
  if (ok && !err) return null;
  return (
    <div className="mx-auto mb-2 max-w-[1248px] sm:mb-3 sm:px-4 md:px-6">
      <div className="flex items-center gap-2.5 bg-card px-4 py-3 text-[13.5px] break-keep text-secondary-foreground sm:rounded-2xl">
        <CircleAlert className="size-4 shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 flex-1">
          {!ok ? <>주식 시세가 <b className="font-semibold text-foreground">늦은(보통 1시간 안쪽)</b> 값이에요.</> : <>실시간 중계 연결에 문제가 있어요 ({err?.message}). 지연 시세로 보여 드려요.</>}
        </span>
        <a href={href('settings', 'relay')} className="shrink-0 font-semibold text-foreground underline-offset-2 hover:underline">설정</a>
      </div>
    </div>
  );
}
