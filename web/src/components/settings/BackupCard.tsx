// 다른 기기로 옮기기 — 백업 코드 만들기(자동 복사, 비밀번호를 넣으면 잠근 코드) · 붙여넣은 코드 적용(바뀌는 내용을 보여 주고 확인)
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, Copy, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { watchStore } from '@/stores';
import { applyBackup, isLockedCode, makeBackupCode, readBackupCode, type BackupRelay, type ParsedBackup } from './backup';
import { hostOf } from './relayTools';
import { Btn, CODE_CLS, FieldLabel, INPUT_CLS, Notice } from './parts';

const relayText = (r: BackupRelay) => ('off' in r ? '꺼짐' : `직접 입력 · ${hostOf(r.url)}`);

function Panel({ icon, title, sub, children }: { icon: ReactNode; title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-[14px] bg-tile p-4">
      <div className="flex items-center gap-2 text-[15px] font-bold">
        <span className="text-muted-foreground" aria-hidden>{icon}</span>{title}
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{sub}</p>
      {children}
    </div>
  );
}

/** 비밀번호 칸 — 눈 버튼으로 보이기/숨기기 (잘못 친 비밀번호로 잠그지 않게) */
function PasswordField({ id, label, value, onChange, help, autoFocus, onEnter, invalid }: {
  id: string; label: string; value: string; onChange: (v: string) => void; help?: ReactNode; autoFocus?: boolean; onEnter?: () => void; invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="mt-3">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          id={id} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && onEnter) { e.preventDefault(); onEnter(); } }}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-describedby={help ? `${id}-help` : undefined} aria-invalid={invalid || undefined}
          className={cn(INPUT_CLS, 'bg-card pr-11 dark:bg-card')}
        />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'} aria-pressed={show}
          className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground">
          {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      </div>
      {help ? <p id={`${id}-help`} className="mt-1.5 px-0.5 text-[12.5px] leading-[1.5] text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function BackupCard({ onApplied }: { onApplied?: (relayChanged: boolean) => void }) {
  const watch = watchStore.use();
  const uid = useId();
  const [made, setMade] = useState<{ code: string; locked: boolean } | null>(null);
  const [making, setMaking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [makePw, setMakePw] = useState('');
  const [paste, setPaste] = useState('');
  const [pastePw, setPastePw] = useState('');
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 확인 창: 닫히는 동안에도 내용이 그대로 보이게 열림 여부와 내용을 따로 둔다
  const [pending, setPending] = useState<{ data: ParsedBackup; cur: number[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [applying, setApplying] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const locked = isLockedCode(paste);

  // 코드를 만들면 바로 전체 선택해 둔다 (복사가 막힌 브라우저에서 길게 눌러 복사하기 쉽게)
  useEffect(() => { if (made) codeRef.current?.select(); }, [made]);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success('백업 코드를 복사했어요', { description: '다른 기기의 설정 화면에 붙여넣으세요' });
    } catch {
      setCopied(false);
      codeRef.current?.select();
      toast('코드를 길게 눌러 복사해 주세요', { description: '이 브라우저는 자동 복사를 막고 있어요' });
    }
  };
  const make = async () => {
    if (making) return;
    setMaking(true);
    try {
      const code = await makeBackupCode(makePw);
      setMade({ code, locked: !!makePw });
      setCopied(false);
      void copy(code);
    } catch (e) {
      toast.error('백업 코드를 만들지 못했어요', { description: (e as Error).message });
    } finally {
      setMaking(false);
    }
  };
  const tryApply = async () => {
    if (reading || !paste.trim()) return;
    setReading(true);
    try {
      const data = await readBackupCode(paste, locked ? pastePw : '');
      setPending({ data, cur: [watch.length] });
      setAsking(true);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const applyNow = async () => {
    const p = pending?.data;
    if (!p || applying) return;
    setApplying(true);
    await applyBackup(p);
    setApplying(false);
    setAsking(false);
    setPaste('');
    setPastePw('');
    setMade(null);
    toast.success('백업을 적용했어요');
    onApplied?.(!!p.relay);
  };

  const counts: [string, number][] = [['관심종목', watch.length]];
  const next = pending?.data;
  const rows: [string, number, number | null][] = pending && next ? [['관심종목', pending.cur[0], next.watch?.length ?? null]] : [];

  return (
    <Card>
      <CardTitle>다른 기기로 옮기기</CardTitle>
      <p className="text-[14px] leading-[1.6] text-muted-foreground">
        관심종목·평단은 이 기기에 암호화해 저장되고 어디로도 보내지 않아요.
        백업 코드를 만들어 다른 기기의 설정 화면에 붙여넣으면 관심종목과 중계 설정이 똑같이 옮겨져요.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Panel icon={<ArrowUpFromLine className="size-4" />} title="이 기기 → 다른 기기" sub="지금 이 기기의 내용을 코드 하나로 묶어요">
          <div className="mt-3 flex flex-wrap gap-1.5">
            {counts.map(([k, n]) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12.5px] font-semibold text-secondary-foreground">
                {k}<span className="text-foreground tabular">{n}</span>
              </span>
            ))}
          </div>
          <PasswordField
            id={`${uid}-make-pw`} label="비밀번호 (선택)" value={makePw} onChange={(v) => { setMakePw(v); if (made) setMade(null); }} onEnter={() => void make()}
            help={makePw
              ? '코드를 붙여넣을 때 이 비밀번호가 필요해요. 잊으면 이 코드는 되살릴 수 없어요.'
              : '비밀번호 없이 만들면 코드를 본 사람은 관심종목을 볼 수 있어요.'}
          />
          {made && (
            <div className="mt-3">
              <label htmlFor="backup-made" className="sr-only">만든 백업 코드</label>
              <Textarea
                id="backup-made" ref={codeRef} readOnly value={made.code} onFocus={(e) => e.currentTarget.select()}
                className={cn(CODE_CLS, 'text-[12.5px] md:text-[12.5px]')}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5 text-[12.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 tabular">
                  {made.locked ? <><Lock className="size-3.5" aria-hidden />비밀번호로 잠근 코드 · </> : null}{made.code.length.toLocaleString('ko-KR')}자
                </span>
                <button type="button" onClick={() => void copy(made.code)} className="press inline-flex items-center gap-1 rounded-lg px-1.5 py-1 font-semibold text-secondary-foreground hover:bg-card">
                  {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}{copied ? '복사됨' : '복사'}
                </button>
              </div>
            </div>
          )}
          <div className="mt-auto pt-4">
            <Btn tone="primary" onClick={() => void make()} disabled={making} className="w-full">
              {making ? <><Loader2 className="size-4 animate-spin" />만드는 중…</> : made ? '다시 만들기' : makePw ? '잠근 백업 코드 만들기' : '백업 코드 만들기'}
            </Btn>
          </div>
        </Panel>

        <Panel icon={<ArrowDownToLine className="size-4" />} title="다른 기기 → 이 기기" sub="다른 기기에서 만든 코드를 붙여넣어요">
          <label htmlFor="backup-paste" className="sr-only">백업 코드 붙여넣기</label>
          <Textarea
            id="backup-paste" value={paste} onChange={(e) => { setPaste(e.target.value); if (err) setErr(null); }}
            placeholder="백업 코드를 여기에 붙여넣으세요" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
            aria-invalid={err && !locked ? true : undefined}
            className={cn(CODE_CLS, 'mt-3 text-[16px] md:text-[12.5px]')}
          />
          {/* 잠근 코드('ml2:…')면 비밀번호 칸이 나타난다 */}
          {locked && (
            <PasswordField
              id={`${uid}-paste-pw`} label="백업 비밀번호" value={pastePw} onChange={(v) => { setPastePw(v); if (err) setErr(null); }} autoFocus
              onEnter={() => void tryApply()} invalid={!!err}
              help={<span className="inline-flex items-center gap-1"><Lock className="size-3.5 shrink-0" aria-hidden />비밀번호로 잠긴 코드예요. 만들 때 넣은 비밀번호를 입력해 주세요.</span>}
            />
          )}
          {err && (
            <p className="mt-2 flex gap-1.5 px-0.5 text-[13px] leading-snug text-secondary-foreground" role="alert">
              <CircleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />{err}
            </p>
          )}
          <div className="mt-auto pt-4">
            <Btn tone="primary" onClick={() => void tryApply()} disabled={!paste.trim() || reading || (locked && !pastePw)} className="w-full">
              {reading ? <><Loader2 className="size-4 animate-spin" />여는 중…</> : '붙여넣은 코드 적용'}
            </Btn>
          </div>
        </Panel>
      </div>

      <Notice tone="warn" className="mt-3">
        사파리는 사이트를 7일 넘게 열지 않으면 저장값을 지울 수 있어요. 백업 코드를 메모해 두면 안심이에요.
      </Notice>

      <Dialog open={asking} onOpenChange={(o) => { if (!o && !applying) setAsking(false); }}>
        <DialogContent showCloseButton={false} className="gap-0 rounded-[20px] p-6 sm:max-w-[400px]">
          <DialogTitle className="text-[19px] leading-snug font-bold tracking-tight">백업 내용으로 바꿀까요?</DialogTitle>
          <DialogDescription className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            지금 이 기기의 관심종목이 백업 내용으로 바뀌어요. 이 기기에만 있던 내용은 사라져요.
          </DialogDescription>
          <dl className="mt-5 divide-y divide-border rounded-[14px] bg-tile px-4 text-[14px]">
            {rows.map(([k, cur, n]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular">
                  {n == null ? <span className="text-muted-foreground">그대로</span>
                    : <>
                      <span className="text-muted-foreground">{cur}개</span><span className="sr-only">에서</span>
                      <span className="mx-1.5 text-faint" aria-hidden>→</span><b className="font-bold">{n}개</b><span className="sr-only">로</span>
                    </>}
                </dd>
              </div>
            ))}
            {next?.relay && (
              <div className="flex items-center justify-between gap-3 py-3">
                <dt className="shrink-0 text-muted-foreground">실시간 중계</dt>
                <dd className="min-w-0 truncate font-bold">{relayText(next.relay)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <Btn size="lg" onClick={() => setAsking(false)} disabled={applying}>취소</Btn>
            <Btn size="lg" tone="primary" onClick={() => void applyNow()} disabled={applying}>바꾸기</Btn>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
