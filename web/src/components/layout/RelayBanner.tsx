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
    <div className="mx-auto mt-3 max-w-[1240px] px-4 md:px-6">
      <div className="flex items-center gap-2 rounded-2xl bg-card px-4 py-3 text-[13.5px] text-secondary-foreground">
        <CircleAlert className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1">
          {!ok ? <>주식 시세가 <b>10~20분 지연</b>된 값입니다.</> : <>실시간 중계 연결에 문제가 있어요 ({err?.message}). 지연 시세로 보여 드려요.</>}
        </span>
        <a href={href('settings')} className="shrink-0 font-semibold text-primary">설정</a>
      </div>
    </div>
  );
}
