import { describe, expect, it } from 'vitest';
import { BackupPasswordError, LOCKED_PREFIX, lockText, unlockText } from './backupCrypto';

describe('백업 코드 잠그기', () => {
  const text = JSON.stringify({ v: 1, watch: [{ sym: 'upbit:KRW-BTC', name: '비트코인', sub: 'BTC' }], relay: null });

  it('같은 비밀번호로 풀면 원래 글이 나온다', async () => {
    const code = await lockText(text, '사과-1234');
    expect(code.startsWith(LOCKED_PREFIX)).toBe(true);
    expect(code).not.toContain('비트코인');
    expect(await unlockText(code, '사과-1234')).toBe(text);
  });

  it('같은 글도 잠글 때마다 다른 코드가 된다 (무작위 소금·iv)', async () => {
    const a = await lockText(text, 'pw'), b = await lockText(text, 'pw');
    expect(a).not.toBe(b);
  });

  it('비밀번호가 틀리면 BackupPasswordError', async () => {
    const code = await lockText(text, 'right');
    await expect(unlockText(code, 'wrong')).rejects.toBeInstanceOf(BackupPasswordError);
  });

  it('잘리거나 깨진 코드는 읽기 오류', async () => {
    const code = await lockText(text, 'pw');
    await expect(unlockText(code.slice(0, 20), 'pw')).rejects.toThrow(/잘린/);
    await expect(unlockText(LOCKED_PREFIX + '!!!', 'pw')).rejects.toThrow(/읽지 못했어요/);
  });
});
