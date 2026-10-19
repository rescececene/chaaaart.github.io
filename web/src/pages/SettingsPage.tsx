// 설정 — 실시간 중계 · 다른 기기로 옮기기 · 화면(테마) · 데이터 상태
// #/settings/<relay|backup|theme|data> 로 열면 그 카드로 바로 내려간다 (예: 내 자산의 '백업 코드' 안내 → #/settings/backup)
import { useEffect, useState } from 'react';
import type { PageProps } from '@/App';
import { PageTitle } from '@/components/common/Card';
import { RelayCard } from '@/components/settings/RelayCard';
import { BackupCard } from '@/components/settings/BackupCard';
import { ThemeCard } from '@/components/settings/ThemeCard';
import { DataStatusCard } from '@/components/settings/DataStatusCard';

const SECTIONS = ['relay', 'backup', 'theme', 'data'];
// 고정 머리글(PC 64px) 아래로 카드 머리가 보이게 — 휴대폰 머리글은 내려갈 때 숨는다
const ANCHOR = 'scroll-mt-3 md:scroll-mt-20';

export default function SettingsPage({ args }: PageProps) {
  // 백업으로 중계 설정이 바뀌면 중계 카드를 새로 띄워 입력값·상태를 다시 읽는다
  const [relayKey, setRelayKey] = useState(0);
  const section = SECTIONS.includes(args[0]) ? args[0] : null;

  useEffect(() => {
    document.title = '설정 — 마켓';
    return () => { document.title = '마켓'; };
  }, []);
  useEffect(() => {
    if (!section) return;
    const id = requestAnimationFrame(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => cancelAnimationFrame(id);
  }, [section]);

  return (
    <>
      <PageTitle>설정</PageTitle>
      <div className="grid items-start gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-4">
        <div className="min-w-0 space-y-2 sm:space-y-3 lg:space-y-4">
          <div id="settings-relay" className={ANCHOR}><RelayCard key={relayKey} /></div>
          <div id="settings-backup" className={ANCHOR}>
            <BackupCard onApplied={(relayChanged) => { if (relayChanged) setRelayKey((k) => k + 1); }} />
          </div>
        </div>
        <div className="min-w-0 space-y-2 sm:space-y-3 lg:space-y-4">
          <div id="settings-theme" className={ANCHOR}><ThemeCard /></div>
          <div id="settings-data" className={ANCHOR}><DataStatusCard /></div>
        </div>
      </div>
    </>
  );
}
