// 데이터 상태 — 시세 출처별 상태 · GitHub Actions 수집기의 마지막 수집 · 소요 · 오류
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardTitle } from '@/components/common/Card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInterval, useRelay, useStockError } from '@/hooks/market';
import { timeAgo } from '@/lib/format';
import { collectMeta, MARKETS, newsAi, Relay, type Market } from '@/lib/market';
import { Dot } from './parts';
import { useRelayCheck } from './relayTools';

const whenFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const STALE_MIN = 30; // 10분마다 돌지만 GitHub 사정으로 몇 분씩 밀리곤 한다
const secsText = (s: number) => { const v = Math.round(s); return v < 60 ? `${v}초` : `${Math.floor(v / 60)}분 ${v % 60}초`; };
const sourceName = (k: string) => (k in MARKETS ? MARKETS[k as Market].name : k);

function Group({ title, sub, children, className }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[14px] font-bold">{title}</h3>
        {sub ? <span className="text-[12.5px] text-muted-foreground">{sub}</span> : null}
      </div>
      <dl className="mt-1 divide-y divide-border">{children}</dl>
    </section>
  );
}
function Row({ k, value, sub }: { k: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 text-[14px] leading-6 text-muted-foreground">{k}</dt>
      <dd className="min-w-0 text-right">
        <div className="text-[14px] leading-6 font-semibold">{value}</div>
        {sub ? <div className="text-[12.5px] text-muted-foreground">{sub}</div> : null}
      </dd>
    </div>
  );
}
const withDot = (tone: 'good' | 'warn' | 'bad' | 'off', text: ReactNode, pulse?: boolean) => (
  <span className="inline-flex items-center gap-1.5"><Dot tone={tone} pulse={pulse} />{text}</span>
);

export function DataStatusCard() {
  const { ok: relayOk } = useRelay();
  const stockErr = useStockError();
  const check = useRelayCheck();
  const meta = useQuery({ queryKey: ['collect-meta'], queryFn: collectMeta, refetchInterval: 60_000, staleTime: 30_000, retry: 1 });
  const ai = useQuery({ queryKey: ['news-ai'], queryFn: newsAi, refetchInterval: 120_000, staleTime: 60_000, retry: false });
  // 'n분 전'이 저절로 바뀌도록 30초마다 다시 그린다
  const [, setTick] = useState(0);
  useInterval(() => setTick((t) => t + 1), 30_000);

  // 주식: 중계 꺼짐 → 지연 / 지금 쓰는 중계의 연결 확인 결과 우선 / 확인 전이면 시세 받기 오류로 판단
  const current = check && !check.reverted ? check : null;
  const stock = !relayOk ? { v: withDot('warn', '10~20분 지연'), s: '중계가 꺼져 있어요' }
    : current?.kind === 'bad' ? { v: withDot('warn', '10~20분 지연'), s: '중계에 연결하지 못했어요' }
      : current?.kind === 'busy' ? { v: withDot('off', '확인 중', true), s: '중계 연결을 확인하고 있어요' }
        : current?.kind !== 'ok' && stockErr ? { v: withDot('warn', '지연 시세'), s: '최근 중계 요청이 실패했어요' }
          : { v: withDot('good', '실시간'), s: '중계를 거쳐 네이버 증권에서' };

  const m = meta.data;
  const at = m ? Date.parse(m.updatedAt) : NaN;
  const fresh = Number.isFinite(at) && Date.now() - at < STALE_MIN * 60e3;
  const errs = m ? Object.entries(m.errors || {}) : [];
  const skel = <Skeleton className="ml-auto h-4 w-20" />;
  const none = <span className="text-muted-foreground">–</span>;

  return (
    <Card>
      <CardTitle>데이터 상태</CardTitle>
      <Group title="시세">
        <Row k="코인" value={withDot('good', '실시간')} sub="업비트·바이낸스에서 직접" />
        <Row k="국내·미국 주식" value={stock.v} sub={stock.s} />
      </Group>
      <Group title="스크리너·뉴스 수집" sub="GitHub Actions · 약 10분마다" className="mt-4">
        <Row
          k="마지막 수집"
          value={meta.isLoading ? skel : Number.isFinite(at) ? withDot(fresh ? 'good' : 'warn', <span className="tabular">{timeAgo(at)}</span>) : <span className="text-muted-foreground">아직 없음</span>}
          sub={Number.isFinite(at) ? (
            <><span className="whitespace-nowrap tabular">{whenFmt.format(at)}</span>{fresh ? null : <>{' '}<span className="whitespace-nowrap">· 늦어지고 있어요</span></>}</>
          ) : undefined}
        />
        <Row k="수집 소요" value={meta.isLoading ? skel : m && Number.isFinite(m.secs) ? <span className="tabular">{secsText(m.secs)}</span> : none} />
        <Row k="수집 오류" value={meta.isLoading ? skel : !m ? none : errs.length ? withDot('bad', `${errs.length}건`) : '없음'} />
      </Group>
      <Group title="무료 사용량" sub="Cloudflare 무료 플랜 · 넘으면 그날만 멈추고 요금은 없어요" className="mt-4">
        <Row
          k="중계 요청 (이 기기)"
          value={<span className="tabular">오늘 {Relay.today().toLocaleString('ko-KR')}건</span>}
          sub="계정 전체 하루 10만 건 · 오전 9시 초기화"
        />
        <Row
          k="뉴스 AI 판단"
          value={ai.isLoading ? skel : ai.data
            ? withDot(ai.data.error ? 'warn' : 'good', <span className="tabular">오늘 약 {Math.round(ai.data.usage?.day === new Date().toISOString().slice(0, 10) ? ai.data.usage.neurons : 0).toLocaleString('ko-KR')} 뉴런</span>)
            : <span className="text-muted-foreground">꺼짐</span>}
          sub={ai.data ? <>하루 1만 뉴런 중 8천에서 멈춰요 · {timeAgo(Date.parse(ai.data.updatedAt))} 판단{ai.data.error ? <> · {ai.data.error.slice(0, 40)}</> : null}</> : '토큰을 등록하면 코인·주식 속보를 AI가 판단해요'}
        />
      </Group>
      {errs.length > 0 && (
        <ul className="mt-2 space-y-1.5 rounded-[14px] bg-tile px-4 py-3 text-[13px] leading-snug">
          {errs.map(([k, v]) => (
            <li key={k} className="break-words"><b className="font-semibold">{sourceName(k)}</b> <span className="text-secondary-foreground">{String(v)}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}
