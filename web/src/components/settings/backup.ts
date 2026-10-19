// 백업 코드 — 이전(바닐라) 버전과 같은 형식이라 두 버전 사이에서도 그대로 옮겨진다.
//   만들기: btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, watch, relay }))))
//   읽기:   JSON.parse(decodeURIComponent(escape(atob(code))))
// 폐기 예정인 unescape/escape 대신 TextEncoder/TextDecoder 로 같은 'UTF-8 → base64' 변환을 한다 (만들어지는 글자까지 같다).
// 예전 코드에 들어 있던 보유자산·알림은 기능을 없앴으므로 읽을 때 무시한다.
// 비밀번호를 넣으면 같은 내용을 'ml2:…' 로 잠근다 (backupCrypto.ts — PBKDF2 + AES-GCM, 브라우저 Web Crypto 만). 예전 평문 코드도 그대로 읽힌다.
import { isValidSym, Relay, type RelayCfg } from '@/lib/market';
import { seedNames, watchStore, type WatchItem } from '@/stores';
import { LOCKED_PREFIX, lockText, unlockText } from './backupCrypto';
import { relayTask } from './relayTools';

export type BackupRelay = RelayCfg | { off: true };
export interface ParsedBackup {
  /** null = 백업에 없음 (지금 것을 그대로 둔다) */
  watch: WatchItem[] | null;
  relay: BackupRelay | null;
}

function toBase64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(code: string) {
  const bin = atob(code);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** 백업 코드 만들기 — 비밀번호가 있으면 잠근 코드('ml2:…'), 없으면 예전과 같은 평문 base64 */
export async function makeBackupCode(password = ''): Promise<string> {
  await watchStore.ready(); // 암호화 저장소를 다 읽은 뒤에 (막 연 화면에서 처음 값이 들어가지 않게)
  const json = JSON.stringify({ v: 1, watch: watchStore.get(), relay: Relay.saved() });
  return password ? lockText(json, password) : toBase64(json);
}

/** 메신저로 옮기며 생긴 줄바꿈·공백·따옴표는 무시 */
const cleanCode = (input: string) => input.replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '');
/** 비밀번호로 잠긴 코드인가 */
export const isLockedCode = (input: string) => cleanCode(input).startsWith(LOCKED_PREFIX);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const symOk = (x: Obj) => typeof x.sym === 'string' && isValidSym(x.sym);
/** 배열이면 쓸 수 있는 항목만 남기고, 배열이 아니면 null (= 백업에 없음) */
function listOf<T>(v: unknown, keep: (x: Obj) => boolean): T[] | null {
  return Array.isArray(v) ? (v.filter((x) => isObj(x) && keep(x)) as T[]) : null;
}

/** 붙여넣은 코드 → 적용할 내용. 읽을 수 없으면 사용자에게 보여 줄 문장으로 오류를 던진다 (비밀번호가 틀리면 BackupPasswordError) */
export async function readBackupCode(input: string, password = ''): Promise<ParsedBackup> {
  const code = cleanCode(input);
  if (!code) throw new Error('백업 코드를 붙여넣어 주세요');
  let text: string;
  if (code.startsWith(LOCKED_PREFIX)) {
    if (!password) throw new Error('비밀번호로 잠긴 코드예요. 코드를 만들 때 넣은 비밀번호를 입력해 주세요');
    text = await unlockText(code, password);
  } else {
    try { text = fromBase64(code); } catch { text = ''; }
  }
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error('코드를 읽지 못했어요. 잘리지 않게 처음부터 끝까지 그대로 붙여넣어 주세요');
  }
  if (!isObj(d) || d.v !== 1) throw new Error('마켓 백업 코드가 아니거나 형식이 달라요');

  const r = d.relay;
  let relay: BackupRelay | null = null;
  if (isObj(r)) {
    if (r.off === true) relay = { off: true };
    else if (typeof r.url === 'string' && r.url.trim()) relay = { url: r.url, key: typeof r.key === 'string' ? r.key : '' };
  }
  return {
    watch: listOf<WatchItem>(d.watch, symOk),
    relay,
  };
}

/** 확인을 받은 뒤 저장소에 반영 (중계는 진행 중인 연결 확인이 끝난 다음에 저장) */
export async function applyBackup(p: ParsedBackup) {
  if (p.watch) watchStore.set(p.watch);
  const relay = p.relay;
  if (relay) await relayTask(() => Relay.save(relay));
  seedNames(); // 시세가 오기 전에도 이름이 보이게
}
