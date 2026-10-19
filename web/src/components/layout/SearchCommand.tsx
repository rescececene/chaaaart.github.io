import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import { Loader2, Search } from 'lucide-react';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { SymbolLogo } from '@/components/common/SymbolLogo';
import { VenueBadges } from '@/components/market/CoinVenues';
import { coinBase } from '@/lib/coins';
import { MARKETS, search, type SearchItem } from '@/lib/market';
import { navigate } from '@/lib/router';
import { distinctWatch, watchStore } from '@/stores';

type Group = 'coin' | 'krx' | 'us';
const GROUP_NAME: Record<Group, string> = { coin: '코인', krx: '국내주식', us: '미국주식' };
const groupOf = (it: SearchItem): Group => (MARKETS[it.market].coin ? 'coin' : it.market === 'krx' ? 'krx' : 'us');
/** 줄 오른쪽 끝 — command-shortcut 표시가 있으면 CommandItem 이 붙이는 빈 체크 아이콘이 숨는다(그게 ml-auto 자리를 반씩 나눠 가졌다) */
const Right = ({ children }: { children: React.ReactNode }) => (
  <span data-slot="command-shortcut" className="ml-auto flex shrink-0 items-center text-[12px] text-muted-foreground">{children}</span>
);

/** ⌘K / Ctrl+K / '/' 로 여는 종목 검색 — 코인은 거래소와 상관없이 한 번만 나오고, 볼 수 있는 거래소는 배지로 */
export function SearchCommand({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 180); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (!open) { setQ(''); setDebounced(''); } }, [open]);
  const { data = [], isFetching } = useQuery({ queryKey: ['search', debounced], queryFn: () => search(debounced), enabled: !!debounced, staleTime: 60_000 });
  const watchAll = watchStore.use();
  const watch = useMemo(() => distinctWatch(watchAll), [watchAll]);
  const groups = useMemo(() => {
    const by = new Map<Group, SearchItem[]>();
    for (const it of data) { const g = groupOf(it); const l = by.get(g) || []; l.push(it); by.set(g, l); }
    return [...by.entries()];
  }, [data]);
  const go = (sym: string) => { onOpenChange(false); navigate('chart', sym); };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="종목 검색" description="코인·국내·미국 종목을 이름이나 코드로 찾기" className="sm:max-w-lg">
      {/* 검색 결과는 search() 가 이미 걸러 오므로 cmdk 자체 필터는 끈다 */}
      <Command shouldFilter={false} className="rounded-none! p-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-[18px] shrink-0 text-subtle" aria-hidden />
          <CommandPrimitive.Input
            value={q} onValueChange={setQ} placeholder="비트코인, 삼성전자, AAPL…" aria-label="종목 이름이나 코드"
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle"
          />
          {isFetching && <Loader2 className="size-4 shrink-0 animate-spin text-subtle" aria-label="찾는 중" />}
        </div>
        <CommandList className="max-h-[min(60vh,520px)] p-1.5">
          {debounced && !isFetching && <CommandEmpty className="py-10 text-[14px] text-muted-foreground">찾는 종목이 없어요</CommandEmpty>}
          {!debounced && watch.length > 0 && (
            <CommandGroup heading="관심 종목">
              {watch.map((w) => {
                const base = coinBase(w.sym);
                return (
                  <CommandItem key={w.sym} value={w.sym} onSelect={() => go(w.sym)} className="gap-3 py-2">
                    <SymbolLogo sym={w.sym} size={28} />
                    <span className="min-w-0 truncate text-[15px] font-semibold">{w.name}</span>
                    {base ? (
                      // 코인은 아래 검색 결과와 같은 모양 — 티커 + 볼 수 있는 거래소 ('SOL/USDT' 대신)
                      <>
                        {w.name !== base && <span className="shrink-0 text-[12px] text-muted-foreground">{base}</span>}
                        <Right><VenueBadges sym={w.sym} className="group-data-selected/command-item:*:bg-background" /></Right>
                      </>
                    ) : <Right>{w.sub}</Right>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {groups.map(([g, items]) => (
            <CommandGroup key={g} heading={GROUP_NAME[g]}>
              {items.map((it) => (
                <CommandItem key={it.sym} value={it.sym} onSelect={() => go(it.sym)} className="gap-3 py-2">
                  <SymbolLogo sym={it.sym} size={28} />
                  <span className="min-w-0 truncate text-[15px] font-semibold">{it.name}</span>
                  {g === 'coin' ? (
                    <>
                      {it.name !== it.sub && <span className="shrink-0 text-[12px] text-muted-foreground">{it.sub}</span>}
                      {/* 고른 줄은 바탕이 배지와 같은 회색이 되므로 배지를 흰색으로 */}
                      <Right><VenueBadges sym={it.sym} className="group-data-selected/command-item:*:bg-background" /></Right>
                    </>
                  ) : (
                    <Right>{it.sub}{it.ex ? ` · ${it.ex}` : ''}</Right>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
