import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Moon, Search, Settings, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { href, useRoute, type PageKey } from '@/lib/router';
import { overview } from '@/lib/market';
import { fmt } from '@/lib/format';
import { useRelay, useRelaySaving } from '@/hooks/market';
import { useResolvedTheme } from '@/lib/theme';
import { themeStore } from '@/stores';
import { ChangeText } from '@/components/common/Change';
import { LiveBadge } from '@/components/common/Status';
import { SearchCommand } from './SearchCommand';

export const NAV: [PageKey, string][] = [
  ['recommend', '추천'], ['pump', '펌핑 후보'], ['market', '시장'], ['chart', '차트'], ['screener', '종목 골라보기'], ['news', '뉴스'],
];
const MAX_W = 'mx-auto max-w-[1248px]';

/** 사이트 이름 — 마크 없이 굵은 글자만 */
function Logo() {
  return (
    <a href={href('recommend')} aria-label="마켓 — 첫 화면(추천)" className="flex h-10 shrink-0 items-center text-[21px] leading-none font-extrabold tracking-[-0.05em] text-foreground">
      마켓
    </a>
  );
}

/** 아이콘 버튼 — 휴대폰 44px, 넓은 화면 40px */
function IconBtn({ label, onClick, hrefTo, children }: { label: string; onClick?: () => void; hrefTo?: string; children: React.ReactNode }) {
  const cls = 'press relative inline-flex size-11 items-center justify-center rounded-xl text-secondary-foreground transition-colors hover:bg-secondary md:size-10 [&_svg]:size-[22px]';
  return hrefTo
    ? <a href={hrefTo} aria-label={label} title={label} className={cls}>{children}</a>
    : <button type="button" onClick={onClick} aria-label={label} title={label} className={cls}>{children}</button>;
}

const AI = () => <sup className="top-[-0.6em] ml-[3px] text-[10px] font-extrabold tracking-normal text-ai">AI</sup>;
const pad = (n: number) => String(n).padStart(2, '0');

/** 지수 띠 — 헤더 밖 회색 바탕 위. '실시간'은 장이 열린 시장이 하나라도 있을 때만, 아니면 'HH:MM 기준' */
function TickerStrip() {
  const { ok } = useRelay();
  const saving = useRelaySaving();
  const { data, dataUpdatedAt } = useQuery({ queryKey: ['overview', ok], queryFn: overview, refetchInterval: ok ? (saving ? 60_000 : 15_000) : 60_000, staleTime: 10_000 });
  const open = !!data?.live && data.items.some((x) => x.status === 'OPEN');
  const at = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  return (
    <div className={cn(MAX_W, 'flex h-10 items-center sm:px-4 md:h-12 md:px-6')}>
      <div className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-[18px] overflow-x-auto px-4 text-[13px] whitespace-nowrap max-sm:[mask-image:linear-gradient(90deg,#000_88%,transparent)] sm:px-1 md:gap-5 md:[mask-image:linear-gradient(90deg,#000_calc(100%-24px),transparent)]">
        {data?.items.map((x) => (
          <span key={x.id} className="inline-flex shrink-0 items-baseline gap-1.5">
            <span className="font-semibold text-secondary-foreground">{x.label}</span>
            <span className="text-[14px] font-bold text-foreground tabular">{fmt(x.price, 2)}</span>
            <ChangeText value={x.chg} className="font-semibold" />
          </span>
        ))}
        <span className="w-4 shrink-0" aria-hidden />
      </div>
      {/* 기준 시각·상태 — 넓은 화면에서만 오른쪽 끝에 (휴대폰은 목록 위 요약 줄이 알려 준다) */}
      {data?.items.length ? (
        <span className="hidden shrink-0 pl-3 text-[12px] text-muted-foreground sm:block">
          {data.live && saving
            ? <span title="오래 조작이 없어서 주식 시세를 30초마다 받고 있어요. 화면을 움직이면 바로 실시간으로 돌아와요."><LiveBadge state="delayed" label="절약 모드" className="text-[12px]" /></span>
            : open ? <LiveBadge state="live" className="text-[12px]" />
              : at ? <span className="tabular">{pad(at.getHours())}:{pad(at.getMinutes())} 기준</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** 휴대폰: 아래로 내리면 헤더가 올라가 숨고, 조금이라도 위로 올리면 다시 내려온다 (늘 화면을 가리지 않으면서 메뉴는 가깝게) */
function useHideOnScroll() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY, raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY, dy = y - last;
        if (y < 120) { setHidden(false); last = y; return; }
        if (Math.abs(dy) < 8) return;
        setHidden(dy > 0);
        last = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);
  return [hidden, setHidden] as const;
}

export function Header() {
  const route = useRoute();
  const theme = useResolvedTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [hidden, setHidden] = useHideOnScroll();
  useEffect(() => { setHidden(false); }, [route.page, setHidden]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const nav = (mobile: boolean) => (
    <nav aria-label="메뉴" className={cn('no-scrollbar flex overflow-x-auto', mobile ? 'h-11 justify-between px-1 min-[420px]:px-2.5' : 'h-16 self-stretch')}>
      {NAV.map(([page, label]) => {
        const on = route.page === page;
        return (
          <a key={page} href={href(page)} aria-current={on ? 'page' : undefined}
            className={cn('relative flex shrink-0 items-center whitespace-nowrap transition-colors',
              mobile ? 'px-1.5 text-[14px] min-[420px]:px-2.5 min-[420px]:text-[15px]' : 'px-[13px] text-[16px]',
              on ? 'font-bold text-foreground' : 'font-semibold text-muted-foreground hover:text-secondary-foreground')}>
            {label}{page === 'recommend' && <AI />}
            {on && <motion.span layoutId={mobile ? 'nav-m' : 'nav-d'} className={cn('absolute bottom-0 h-[2px] rounded-t-[2px] bg-foreground', mobile ? 'inset-x-1.5 min-[420px]:inset-x-2.5' : 'inset-x-[13px]')} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          </a>
        );
      })}
    </nav>
  );
  return (
    <>
      <header
        onFocusCapture={() => setHidden(false)}
        className={cn('sticky top-0 z-40 bg-background shadow-[0_1px_0_var(--border)] transition-transform duration-200 ease-out motion-reduce:transition-none', hidden && !searchOpen && 'max-md:-translate-y-full')}
      >
        <div className={cn(MAX_W, 'flex h-14 items-center gap-2 px-4 md:h-16 md:px-6')}>
          <Logo />
          <div className="ml-6 hidden min-w-0 flex-1 self-stretch md:flex">{nav(false)}</div>
          <div className="-mr-2.5 ml-auto flex items-center md:mr-0 md:ml-0 md:gap-0.5">
            <button type="button" onClick={() => setSearchOpen(true)} className="press mr-2 hidden h-10 w-[280px] items-center gap-2 rounded-xl bg-secondary pr-2.5 pl-3 text-[15px] text-muted-foreground lg:flex">
              <Search className="size-[18px]" aria-hidden /> <span className="flex-1 text-left">종목 검색</span>
              <kbd className="rounded-md bg-background px-[7px] font-sans text-[12px] leading-5 font-semibold text-muted-foreground">/</kbd>
            </button>
            <span className="lg:hidden"><IconBtn label="종목 검색" onClick={() => setSearchOpen(true)}><Search strokeWidth={1.8} /></IconBtn></span>
            <IconBtn label={theme === 'dark' ? '밝은 화면' : '어두운 화면'} onClick={() => themeStore.set(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun strokeWidth={1.8} /> : <Moon strokeWidth={1.8} />}
            </IconBtn>
            <IconBtn label="설정" hrefTo={href('settings')}><Settings strokeWidth={1.8} /></IconBtn>
          </div>
        </div>
        <div className="md:hidden">{nav(true)}</div>
        <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
      </header>
      <TickerStrip />
    </>
  );
}
