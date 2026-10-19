// 설정 화면 전용 중계 도우미 — 작업 순서 맞추기 · 마지막 확인 결과 공유 · 오류 문장 다듬기 · Worker 코드 복사
import { useSyncExternalStore } from 'react';
import { Relay } from '@/lib/market';

/**
 * 마지막 연결 확인 결과 — 중계 카드가 쓰고 데이터 상태 카드가 읽는다.
 * host: 확인한 중계 주소, reverted: 새 주소 확인에 실패해 이전 설정으로 돌아감 (= 지금 쓰는 중계의 상태는 아님)
 */
export type RelayCheck = { kind: 'busy' | 'ok' | 'bad' | 'info'; msg: string; host?: string; reverted?: boolean };
let lastCheck: RelayCheck | null = null;
const checkSubs = new Set<() => void>();
export const relayCheck = {
  get: () => lastCheck,
  set(v: RelayCheck | null) { lastCheck = v; checkSubs.forEach((fn) => fn()); },
  /** 첫 그리기 전에 값만 넣어 둔다 (알림 없음 — 같은 그리기에서 뒤에 오는 카드가 바로 읽게) */
  prime(v: RelayCheck | null) { lastCheck = v; },
  subscribe(fn: () => void) { checkSubs.add(fn); return () => { checkSubs.delete(fn); }; },
};
export const useRelayCheck = () => useSyncExternalStore(relayCheck.subscribe, relayCheck.get, relayCheck.get);

let tail: Promise<unknown> = Promise.resolve();
/**
 * Relay.test 는 실패하면 '확인 전 설정'으로 되돌린다. 확인하는 동안 끄기·백업 적용 같은 저장이 끼어들면
 * 그 되돌림에 덮어써지므로, 설정 화면의 중계 작업(확인·저장)은 하나씩 차례로 실행한다.
 */
export function relayTask<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
export const saveRelay = (cfg: Parameters<typeof Relay.save>[0]) => relayTask(() => Relay.save(cfg));
export const testRelay = (cfg?: Parameters<typeof Relay.test>[0]) => relayTask(() => Relay.test(cfg));

export function hostOf(url: string) {
  try { return new URL(url).host || url; } catch { return url; }
}

/** 브라우저마다 다른 영어 오류를 알아듣기 쉬운 말로 */
export function friendlyRelayError(msg: string): string {
  if (/failed to fetch|networkerror|load failed|network request failed|err_/i.test(msg)) {
    return '중계 서버에 닿지 못했어요. 주소가 맞는지, 인터넷이 연결돼 있는지 확인해 주세요';
  }
  if (/json|unexpected token|unexpected character|expected pattern/i.test(msg)) {
    return '마켓렌즈 중계가 아닌 곳에서 답이 왔어요. Worker 주소가 맞는지 확인해 주세요';
  }
  return msg;
}

async function fetchWorkerCode(): Promise<string> {
  const r = await fetch('worker.js', { cache: 'no-store' });
  const text = await r.text();
  // 없는 파일에 index.html 을 돌려주는 서버(개발 서버 등)를 걸러 낸다
  if (!r.ok || /html/i.test(r.headers.get('content-type') || '') || /^\s*</.test(text)) throw new Error('worker.js 없음');
  return text;
}

/**
 * worker.js 를 받아 클립보드에 복사 — 성공하면 true.
 * 사파리는 클릭 직후에만 복사를 허락하므로 받아 오는 중인 Promise 를 ClipboardItem 에 바로 넘기고,
 * 그걸 못 쓰는 브라우저는 받은 뒤 writeText 로 한 번 더 시도한다.
 */
export async function copyWorkerCode(): Promise<boolean> {
  const code = fetchWorkerCode();
  code.catch(() => undefined);
  try {
    try {
      const blob = code.then((t) => new Blob([t], { type: 'text/plain' }));
      blob.catch(() => undefined);
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } catch {
      await navigator.clipboard.writeText(await code);
    }
    return true;
  } catch {
    return false;
  }
}
