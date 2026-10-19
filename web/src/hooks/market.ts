// 시장 데이터 React 훅 — 바뀐 종목만 다시 그리도록 종목별로 구독한다
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  getQuote, namesVersion, onIdleChange, onNames, onQuotes, onStockError, Relay, relaySaving, stockError, subscribeSym, unwant, want, watchBook,
  type BookState, type Quote, type Sym,
} from '@/lib/market';

/** 한 종목의 실시간 시세 (구독 등록은 useWant 로 따로) */
export function useQuote(sym: Sym | null | undefined): Quote | undefined {
  return useSyncExternalStore(
    (cb) => (sym ? subscribeSym(sym, cb) : () => {}),
    () => (sym ? getQuote(sym) : undefined),
  );
}

/** "이 화면은 이 종목들 시세가 필요하다" — 'upbit:*' 는 업비트 전체 */
export function useWant(syms: Sym[] | null) {
  const owner = useId();
  const key = syms ? syms.join('|') : '';
  useEffect(() => {
    if (!syms || !syms.length) { unwant(owner); return; }
    want(owner, syms);
    return () => unwant(owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, key]);
}

/** 아무 시세나 바뀌면 최대 ms 간격으로 다시 그린다 (목록 정렬처럼 전체를 보는 곳용) */
export function useQuotesTick(ms = 500, filter?: (changed: Set<Sym>) => boolean) {
  const [tick, setTick] = useState(0);
  const pending = useRef(false);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onQuotes((changed) => {
      if (filterRef.current && !filterRef.current(changed)) return;
      if (pending.current) return;
      pending.current = true;
      timer = setTimeout(() => { pending.current = false; setTick((t) => t + 1); }, ms);
    });
    return () => { off(); if (timer) clearTimeout(timer); pending.current = false; };
  }, [ms]);
  return tick;
}

/** 호가 */
export function useBook(sym: Sym | null | undefined): BookState | null {
  const [book, setBook] = useState<BookState | null>(null);
  useEffect(() => {
    setBook(null);
    if (!sym) return;
    return watchBook(sym, setBook);
  }, [sym]);
  return book;
}

export function useRelay() {
  useSyncExternalStore(Relay.subscribe, Relay.version);
  return { ok: Relay.ok(), mode: Relay.mode(), cfg: Relay.cfg() };
}
export function useNamesVersion() { return useSyncExternalStore(onNames, namesVersion); }
/** 절약 모드 (오래 조작이 없거나 오늘 중계를 너무 많이 불러서 주식 시세를 천천히 받는 중) */
export function useRelaySaving() { return useSyncExternalStore(onIdleChange, relaySaving); }
export function useStockError() { return useSyncExternalStore(onStockError, stockError); }

/** 탭이 보이는 동안만 ms 마다 fn */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    return () => clearInterval(id);
  }, [ms]);
}
