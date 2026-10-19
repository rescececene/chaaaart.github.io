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
import { SearchCommand } from './SearchCommand';

export const NAV: [PageKey, string][] = [
  ['market', '시장'], ['picks', '유망 종목'], ['chart', '차트'], ['screener', '종목 골라보기'], ['news', '뉴스'],
];

function Logo() {
  return (
    <a href={href('market')} className="flex shrink-0 items-center gap-2 text-[17px] font-extrabold tracking-tight">
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <rect width="28" height="28" rx="8" className="fill-foreground" />
        <rect x="6" y="11" width="4" height="10" rx="1.2" fill="var(--up)" />
        <rect x="12" y="6" width="4" height="13" rx="1.2" fill="var(--down)" />
        <rect x="18" y="9" width="4" height="9" rx="1.2" fill="var(--up)" />
      </svg>
      마켓렌즈
    </a>
  );
}

function IconBtn({ label, onClick, hrefTo, children, badge }: { label: string; onClick?: () => void; hrefTo?: string; children: React.ReactNode; badge?: number }) {
  const cls = 'press relative inline-flex size-10 items-center justify-center rounded-xl text-secondary-foreground hover:bg-secondary';
  const inner = (
    <>
      {children}
      {badge ? <span className="absolute top-1.5 right-1.5 min-w-4 rounded-full bg-up px-1 text-center text-[10px] leading-4 font-bold text-white">{badge > 9 ? '9+' : badge}</span> : null}
    </>
  );
  return hrefTo
    ? <a href={hrefTo} aria-label={label} title={label} className={cls}>{inner}</a>
    : <button onClick={onClick} aria-label={label} title={label} className={cls}>{inner}</button>;
}

function TickerStrip() {
  const { ok } = useRelay();
  const saving = useRelaySaving();
  const { data } = useQuery({ queryKey: ['overview', ok], queryFn: overview, refetchInterval: ok ? (saving ? 60_000 : 15_000) : 60_000, staleTime: 10_000 });
  if (!data?.items.length) return <div className="h-8" />;
  return (
    <div className="no-scrollbar flex h-8 items-center gap-5 overflow-x-auto text-[12.5px] whitespace-nowrap">
      {data.items.map((x) => (
        <span key={x.id} className="inline-flex items-center gap-1.5">
          <span className="font-medium text-muted-foreground">{x.label}</span>
          <span className="tabular font-semibold">{fmt(x.price, 2)}</span>
          <ChangeText value={x.chg} arrowOn={false} className="text-[12px] font-semibold" />
        </span>
      ))}
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {data.live && saving
          ? <span title="오래 조작이 없어서 주식 시세를 30초마다 받고 있어요. 화면을 움직이면 바로 실시간으로 돌아와요." className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-faint" />절약 모드</span>
          : data.live ? <><span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-good" /></span>실시간</> : '10분 단위'}
      </span>
    </div>
  );
}

export function Header() {
  const route = useRoute();
  const theme = useResolvedTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const tabs = (mobile: boolean) => (
    <nav className={cn('no-scrollbar flex overflow-x-auto', mobile ? 'gap-5 px-4' : 'gap-1')}>
      {NAV.map(([page, label]) => {
        const on = route.page === page;
        return mobile ? (
          <a key={page} href={href(page)} className={cn('relative shrink-0 py-2.5 text-[15px] font-semibold', on ? 'text-foreground' : 'text-subtle')}>
            {label}
            {on && <motion.span layoutId="nav-m" className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-foreground" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          </a>
        ) : (
          <a key={page} href={href(page)} className={cn('press relative rounded-xl px-3 py-2 text-[15px] font-semibold transition-colors', on ? 'text-foreground' : 'text-subtle hover:text-foreground')}>
            {on && <motion.span layoutId="nav-d" className="absolute inset-0 rounded-xl bg-secondary" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className="relative">{label}{page === 'picks' && <span className="ml-1 align-top text-[10px] font-bold text-primary">AI</span>}</span>
          </a>
        );
      })}
    </nav>
  );
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-4 px-4 md:px-6">
        <Logo />
        <div className="hidden min-w-0 flex-1 md:block">{tabs(false)}</div>
        <div className="ml-auto flex items-center gap-0.5 md:ml-0">
          <button onClick={() => setSearchOpen(true)} className="press mr-1 hidden h-10 w-56 items-center gap-2 rounded-xl bg-secondary px-3 text-[14px] text-subtle lg:flex">
            <Search className="size-4" /> 종목 검색 <kbd className="ml-auto rounded-md bg-background px-1.5 text-[11px] font-semibold text-muted-foreground">⌘K</kbd>
          </button>
          <span className="lg:hidden"><IconBtn label="종목 검색" onClick={() => setSearchOpen(true)}><Search className="size-5" /></IconBtn></span>
          <IconBtn label={theme === 'dark' ? '밝은 화면' : '어두운 화면'} onClick={() => themeStore.set(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </IconBtn>
          <IconBtn label="설정" hrefTo={href('settings')}><Settings className="size-5" /></IconBtn>
        </div>
      </div>
      <div className="md:hidden">{tabs(true)}</div>
      <div className="mx-auto max-w-[1240px] px-4 md:px-6"><TickerStrip /></div>
      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  );
}
