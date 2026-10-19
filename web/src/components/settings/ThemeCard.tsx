// 화면 — 테마 (기기 설정 · 밝게 · 어둡게)
import { Card, CardTitle } from '@/components/common/Card';
import { Segmented, type SegItem } from '@/components/common/Segmented';
import { useResolvedTheme } from '@/lib/theme';
import { themeStore, type ThemePref } from '@/stores';

const ITEMS: SegItem<ThemePref>[] = [
  { value: 'auto', label: '기기 설정' },
  { value: 'light', label: '밝게' },
  { value: 'dark', label: '어둡게' },
];

export function ThemeCard() {
  const pref = themeStore.use();
  const shown = useResolvedTheme();
  return (
    <Card>
      <CardTitle>화면</CardTitle>
      <div className="mb-2 px-0.5 text-[13px] font-semibold text-secondary-foreground" id="theme-label">테마</div>
      <div role="group" aria-labelledby="theme-label">
        <Segmented full items={ITEMS} value={pref} onChange={(v) => themeStore.set(v)} />
      </div>
      <p className="mt-3 px-0.5 text-[13px] leading-relaxed text-muted-foreground">
        {pref === 'auto'
          ? <>휴대폰·PC의 다크 모드 설정을 따라가요. 지금은 <b className="font-semibold text-secondary-foreground">{shown === 'dark' ? '어둡게' : '밝게'}</b> 보여요.</>
          : '이 기기에서만 바뀌어요. 화면 위쪽 해·달 버튼으로도 바꿀 수 있어요.'}
      </p>
    </Card>
  );
}
