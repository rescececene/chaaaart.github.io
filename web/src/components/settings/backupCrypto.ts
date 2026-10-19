// 백업 코드 잠그기 — 비밀번호를 넣으면 브라우저 내장 암호(Web Crypto)로만 암호화한다 (서버·외부 라이브러리 없음).
//   열쇠: PBKDF2-SHA256(비밀번호, 무작위 소금 16바이트, 21만 회) → AES-GCM 256
//   코드: 'ml2:' + base64(소금 16 | iv 12 | 암호문+인증 태그)
// 비밀번호가 틀리면 AES-GCM 인증이 실패하므로 엉뚱한 내용이 풀리는 일은 없다.
export const LOCKED_PREFIX = 'ml2:';
const ITERATIONS = 210_000;
const SALT_LEN = 16, IV_LEN = 12;

export class BackupPasswordError extends Error {}

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('이 브라우저에서는 암호 기능을 쓸 수 없어요. https 주소로 열었는지 확인해 주세요');
  return s;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const s = subtle();
  const base = await s.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 글을 비밀번호로 잠근다 → 'ml2:…' */
export async function lockText(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(SALT_LEN + IV_LEN + ct.length);
  out.set(salt);
  out.set(iv, SALT_LEN);
  out.set(ct, SALT_LEN + IV_LEN);
  return LOCKED_PREFIX + b64(out);
}

/** 'ml2:…' 를 비밀번호로 푼다 — 비밀번호가 틀리면 BackupPasswordError */
export async function unlockText(code: string, password: string): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unb64(code.slice(LOCKED_PREFIX.length));
  } catch {
    throw new Error('코드를 읽지 못했어요. 잘리지 않게 처음부터 끝까지 그대로 붙여넣어 주세요');
  }
  if (bytes.length <= SALT_LEN + IV_LEN + 16) throw new Error('코드가 잘린 것 같아요. 처음부터 끝까지 그대로 붙여넣어 주세요');
  const key = await deriveKey(password, bytes.slice(0, SALT_LEN));
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.slice(SALT_LEN, SALT_LEN + IV_LEN) }, key, bytes.slice(SALT_LEN + IV_LEN));
    return new TextDecoder('utf-8', { fatal: true }).decode(pt);
  } catch {
    throw new BackupPasswordError('비밀번호가 맞지 않아요. 코드를 만들 때 넣은 비밀번호를 다시 확인해 주세요');
  }
}
