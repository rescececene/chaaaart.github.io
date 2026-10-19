// 다른 기기로 옮기기 — 백업 코드 만들기(자동 복사) · 붙여넣은 코드 적용(바뀌는 내용을 보여 주고 확인)
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { watchStore } from '@/stores';
import { applyBackup, makeBackupCode, readBackupCode, type BackupRelay, type ParsedBackup } from './backup';
import { hostOf } from './relayTools';
import { Btn, CODE_CLS, Notice } from './parts';

const relayText = (r: BackupRelay) => ('off' in r ? '꺼짐' : `직접 입력 · ${hostOf(r.url)}`);

function Panel({ icon, title, sub, children }: { icon: ReactNode; title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl bg-secondary/60 p-4">
      <div className="flex items-center gap-2 text-[15px] font-bold">
        <span className="text-subtle" aria-hidden>{icon}</span>{title}
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{sub}</p>
      {children}
    </div>
  );
}

export function BackupCard({ onApplied }: { onApplied?: (relayChanged: boolean) => void }) {
  const watch = watchStore.use();
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // 확인 창: 닫히는 동안에도 내용이 그대로 보이게 열림 여부와 내용을 따로 둔다
  const [pending, setPending] = useState<{ data: ParsedBackup; cur: number[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [applying, setApplying] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);

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
  const make = () => {
    const code = makeBackupCode();
    setMade(code);
    setCopied(false);
    void copy(code);
  };
  const tryApply = () => {
    try {
      setPending({ data: readBackupCode(paste), cur: [watch.length] });
      setAsking(true);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
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
      <p className="text-[14px] leading-relaxed text-muted-foreground">
        관심종목과 중계 설정은 이 브라우저에만 저장돼요. 백업 코드를 만들어 다른 기기의 설정 화면에 붙여넣으면 똑같이 옮겨져요.
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
          {!made && (
            // PC 에서 오른쪽 붙여넣기 칸과 짝을 맞추는 자리 (휴대폰에선 생략)
            <div className="mt-3 hidden h-24 items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-[13px] leading-snug text-muted-foreground md:flex">
              버튼을 누르면 여기에 코드가 생기고<br />자동으로 복사돼요
            </div>
          )}
          {made && (
            <div className="mt-3">
              <label htmlFor="backup-made" className="sr-only">만든 백업 코드</label>
              <Textarea
                id="backup-made" ref={codeRef} readOnly value={made} onFocus={(e) => e.currentTarget.select()}
                className={cn(CODE_CLS, 'text-[12.5px] md:text-[12.5px]')}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5 text-[12.5px] text-muted-foreground">
                <span className="tabular">{made.length.toLocaleString('ko-KR')}자</span>
                <button type="button" onClick={() => void copy(made)} className="press inline-flex items-center gap-1 rounded-lg px-1.5 py-1 font-semibold text-secondary-foreground hover:bg-card">
                  {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}{copied ? '복사됨' : '복사'}
                </button>
              </div>
            </div>
          )}
          <div className="mt-auto pt-4">
            <Btn tone="primary" onClick={make} className="w-full">{made ? '다시 만들기' : '백업 코드 만들기'}</Btn>
          </div>
        </Panel>

        <Panel icon={<ArrowDownToLine className="size-4" />} title="다른 기기 → 이 기기" sub="다른 기기에서 만든 코드를 붙여넣어요">
          <label htmlFor="backup-paste" className="sr-only">백업 코드 붙여넣기</label>
          <Textarea
            id="backup-paste" value={paste} onChange={(e) => { setPaste(e.target.value); if (err) setErr(null); }}
            placeholder="백업 코드를 여기에 붙여넣으세요" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
            aria-invalid={err ? true : undefined}
            className={cn(CODE_CLS, 'mt-3 text-[16px] md:text-[12.5px]')}
          />
          {err && (
            <p className="mt-2 flex gap-1.5 px-0.5 text-[13px] leading-snug text-secondary-foreground" role="alert">
              <CircleAlert className="mt-px size-4 shrink-0 text-destructive" aria-hidden />{err}
            </p>
          )}
          <div className="mt-auto pt-4">
            <Btn tone="primary" onClick={tryApply} disabled={!paste.trim()} className="w-full">붙여넣은 코드 적용</Btn>
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
          <dl className="mt-5 divide-y divide-border rounded-2xl bg-secondary/60 px-4 text-[14px]">
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
