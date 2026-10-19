// localStorage 에 저장되는 작은 상태 + React 구독. 키·형식은 이전(바닐라) 버전과 같아서 저장된 값이 그대로 이어진다.
import { useSyncExternalStore } from 'react';
import { Store } from './market';

export interface LocalStore<T> {
  get(): T;
  set(v: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
  use(): T;
}
export function createLocalStore<T>(key: string, initial: T): LocalStore<T> {
  let value = Store.get<T>(key, initial);
  const listeners = new Set<() => void>();
  const s: LocalStore<T> = {
    get: () => value,
    set(v) {
      value = typeof v === 'function' ? (v as (p: T) => T)(value) : v;
      Store.set(key, value);
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    use: () => useSyncExternalStore(s.subscribe, s.get, s.get),
  };
  // 다른 탭에서 바꾼 값도 반영
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== key) return;
      value = Store.get<T>(key, initial);
      listeners.forEach((fn) => fn());
    });
  }
  return s;
}
