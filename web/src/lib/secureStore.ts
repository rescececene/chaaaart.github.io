// 개인 데이터(내 평단·수량·관심종목)를 이 기기 안에서도 암호화해 저장하는 저장소 — createLocalStore 와 같은 사용법.
//  - 브라우저 내장 암호(Web Crypto, AES-GCM 256)로 암호화해 localStorage 에 'enc1:…' 로 넣는다.
//  - 열쇠는 이 기기 브라우저의 IndexedDB 에 '꺼낼 수 없는(non-extractable)' 열쇠로 둔다 — 코드에도, 서버에도 없다.
//    저장 파일을 그대로 복사해 가도 내용은 읽을 수 없고, 열쇠 자체를 밖으로 꺼낼 수도 없다.
//  - 이 데이터는 어디로도 보내지 않는다 (서버·중계 없음). 사이트 데이터를 지우면 열쇠와 함께 사라진다.
//  - 예전처럼 평문으로 저장돼 있던 값은 처음 읽을 때 암호화해 다시 저장한다.
//  - 브라우저가 암호 기능을 못 쓰면(아주 오래된 브라우저·일부 비공개 모드) 예전처럼 평문으로 저장한다.
import { useSyncExternalStore } from 'react';
import type { LocalStore } from './localStore';

const PREFIX = 'enc1:';
const DB = 'ml-secure', OBJ = 'keys', KEY_ID = 'aes1';

function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(OBJ);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(OBJ, mode);
      const req = fn(tx.objectStore(OBJ));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    };
  });
}

let keyPromise: Promise<CryptoKey | null> | null = null;
/** 이 기기의 열쇠 (없으면 만든다). 못 쓰는 환경이면 null */
function deviceKey(): Promise<CryptoKey | null> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle || !globalThis.isSecureContext) return null;
    try {
      const found = await idb<CryptoKey | undefined>((s) => s.get(KEY_ID) as IDBRequest<CryptoKey | undefined>, 'readonly');
      if (found) return found;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await idb((s) => s.put(key, KEY_ID), 'readwrite');
      // 다른 탭이 동시에 만들었을 수 있으니 저장된 것을 다시 읽어 그것을 쓴다
      return (await idb<CryptoKey | undefined>((s) => s.get(KEY_ID) as IDBRequest<CryptoKey | undefined>, 'readonly')) || key;
    } catch {
      return null;
    }
  })();
  return keyPromise;
}

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(value: unknown, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return PREFIX + b64(out);
}
async function open<T>(raw: string, key: CryptoKey): Promise<T> {
  const bytes = unb64(raw.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

const readRaw = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeRaw = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } };

export interface SecureStore<T> extends LocalStore<T> {
  /** 저장된 값을 다 읽었을 때 (암호 풀기는 비동기) */
  ready(): Promise<void>;
}

export function createSecureStore<T>(name: string, initial: T): SecureStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  let writeChain: Promise<void> = Promise.resolve();
  let touched = false; // 다 읽기 전에 사용자가 바꾼 값이 있으면 읽은 값으로 덮지 않는다

  const persist = (v: T) => {
    writeChain = writeChain.then(async () => {
      const key = await deviceKey();
      writeRaw(name, key ? await seal(v, key) : JSON.stringify(v));
    }).catch(() => { writeRaw(name, JSON.stringify(v)); });
  };

  const load = async (raw: string | null) => {
    if (raw == null) return;
    let next: T | undefined;
    if (raw.startsWith(PREFIX)) {
      const key = await deviceKey();
      if (key) { try { next = await open<T>(raw, key); } catch { /* 열쇠가 바뀌었거나 깨짐 — 처음 값으로 */ } }
    } else {
      try { next = JSON.parse(raw) as T; } catch { /* 깨진 값 */ }
      if (next !== undefined) persist(next); // 예전 평문 → 암호화해 다시 저장
    }
    if (next !== undefined && !touched) { value = next; notify(); }
  };
  const readyPromise = load(readRaw(name)).catch(() => {});

  const s: SecureStore<T> = {
    get: () => value,
    set(v) {
      touched = true;
      value = typeof v === 'function' ? (v as (p: T) => T)(value) : v;
      persist(value);
      notify();
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    use: () => useSyncExternalStore(s.subscribe, s.get, s.get),
    ready: () => readyPromise,
  };
  // 다른 탭에서 바꾼 값도 반영
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => { if (e.key === name) { touched = false; void load(e.newValue); } });
  }
  return s;
}
