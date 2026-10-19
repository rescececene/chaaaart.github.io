// 실시간 중계 — 지금 상태 · 연결 확인 · 고급(다른 중계 주소·키 저장, 기본값으로, 끄기, Worker 코드 복사)
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown, CircleAlert, CircleCheck, Copy, Info, Loader2, Power, PowerOff, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Card, CardTitle } from '@/components/common/Card';
import { Input } from '@/components/ui/input';
import { useRelay } from '@/hooks/market';
import { Relay, type RelayCfg } from '@/lib/market';
import { Btn, Dot, FieldLabel, INPUT_CLS } from './parts';
import { copyWorkerCode, friendlyRelayError, hostOf, relayCheck, saveRelay, testRelay, type RelayCheck as Result } from './relayTools';

type Mode = 'off' | 'custom' | 'default';
const OFF_MSG = '중계가 꺼져 있어요. 주식은 10~20분 지연된 시세로 보여요';
const HELP_CLS = 'mt-1.5 px-0.5 text-[12.5px] text-muted-foreground';

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-foreground">{children}</b>;
const STEPS: ReactNode[] = [
  <>Cloudflare <B>Workers &amp; Pages → Create → Worker</B>에서 Hello World를 골라 <B>Deploy</B></>,
  <><B>Edit code</B>에서 기존 코드를 지우고, 아래 [Worker 코드 복사]로 복사한 내용을 붙여넣은 뒤 <B>Deploy</B></>,
  <>
    이 사이트에서 온 요청만 받으므로 키 없이도 돼요. 다른 곳에서도 쓰려면 <B>Settings → Variables and Secrets</B>에 Secret{' '}
    <code className="rounded-md bg-card px-1.5 py-0.5 font-mono text-[12px] text-foreground">ACCESS_KEY</code> 추가
  </>,
  <>만든 Worker 주소(…workers.dev)를 위 <B>Worker 주소</B>에 넣고 [저장하고 확인]</>,
];

function StatePill({ mode, result }: { mode: Mode; result: Result | null }) {
  const label = mode === 'off' ? '꺼짐' : mode === 'default' ? '기본 중계 사용 중' : '직접 입력한 중계';
  // 새 주소 확인에 실패해 되돌린 경우는 지금 쓰는 중계의 상태가 아니므로 빨간 점을 켜지 않는다
  const tone = mode === 'off' ? 'off' : result?.kind === 'bad' && !result.reverted ? 'bad' : 'good';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[12.5px] font-semibold whitespace-nowrap text-secondary-foreground">
      <Dot tone={tone} pulse={result?.kind === 'busy'} />
      {label}
    </span>
  );
}

/** 연결 확인 결과(확인 중 · 연결됨 · 실패 · 안내, 아래 줄: 확인한 주소) + 오른쪽(휴대폰은 아래) 버튼 */
function StatusBox({ mode, result, host, action }: { mode: Mode; result: Result | null; host: string | null; action: ReactNode }) {
  const r: Result = (mode === 'off' && result?.kind !== 'info') || !result ? { kind: 'info', msg: mode === 'off' ? OFF_MSG : '아직 확인하지 않았어요' } : result;
  const icon =
    r.kind === 'busy' ? <Loader2 className="size-[18px] animate-spin text-muted-foreground" />
      : r.kind === 'ok' ? <CircleCheck className="size-[18px] text-good" />
        : r.kind === 'bad' ? <CircleAlert className="size-[18px] text-warn" />
          : <Info className="size-[18px] text-muted-foreground" />;
  const where = r.host ?? (mode !== 'off' ? host : null);
  return (
    <div className="mt-4 rounded-[14px] bg-tile p-4 sm:flex sm:items-center sm:gap-4">
      <div role="status" className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-px shrink-0" aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className={cn('text-[14px] leading-snug font-semibold break-words', r.kind === 'busy' && 'text-muted-foreground')}>{r.msg}</p>
          {where ? (
            <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
              {where}{r.reverted ? ' · 이전 설정으로 되돌렸어요' : ''}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3.5 sm:mt-0 sm:shrink-0">{action}</div>
    </div>
  );
}

export function RelayCard() {
  const { mode, cfg } = useRelay();
  // 화면을 열면 바로 한 번 확인한다 (꺼져 있으면 생략) — 첫 화면부터 '확인 중'을 보여 줘 자리가 튀지 않게
  const [result, setResult] = useState<Result | null>(() => {
    const first: Result | null = Relay.mode() === 'off' ? null : { kind: 'busy', msg: '연결 확인 중…' };
    relayCheck.prime(first); // 아래쪽 데이터 상태 카드가 첫 그리기부터 같은 값을 읽게
    return first;
  });
  const busy = result?.kind === 'busy';
  const [open, setOpen] = useState(() => Relay.mode() === 'custom');
  const [url, setUrl] = useState(() => (Relay.mode() === 'custom' ? Relay.cfg()?.url ?? '' : ''));
  const [key, setKey] = useState(() => (Relay.mode() === 'custom' ? Relay.cfg()?.key ?? '' : ''));
  const [copying, setCopying] = useState(false);
  const reduceMotion = useReducedMotion();
  const seq = useRef(0);
  // 데이터 상태 카드의 '주식 시세' 줄도 같은 결과를 보도록 (그리기 전에 맞춰 깜빡임 없게)
  useLayoutEffect(() => { relayCheck.set(result); }, [result]);

  const check = async (next?: RelayCfg | null) => {
    const my = ++seq.current;
    const host = next ? hostOf(next.url) : undefined;
    setResult({ kind: 'busy', msg: '연결 확인 중…', host });
    const r = await testRelay(next);
    if (my !== seq.current) return; // 그사이 새 확인·끄기가 있었다
    if (r.ok) setResult({ kind: 'ok', msg: r.msg, host });
    else setResult({ kind: 'bad', msg: friendlyRelayError(r.msg), host, reverted: !!next });
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (Relay.mode() !== 'off') void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const turnOn = () => { void saveRelay(null); void check(); };
  const saveAndTest = () => {
    let u = url.trim();
    if (!u) { void saveRelay(null); void check(); return; }
    if (!/^https?:\/\//i.test(u)) { u = 'https://' + u; setUrl(u); }
    void check({ url: u, key });
  };
  const reset = () => { setUrl(''); setKey(''); void saveRelay(null); void check(); };
  const turnOff = () => {
    seq.current++;
    void saveRelay({ off: true });
    setResult({ kind: 'info', msg: '중계를 껐어요. 주식은 10~20분 지연된 시세로 보여요' });
  };
  const onEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!busy) saveAndTest();
  };
  const copyWorker = async () => {
    setCopying(true);
    const ok = await copyWorkerCode();
    setCopying(false);
    if (ok) { toast.success('Worker 코드를 복사했어요', { description: 'Cloudflare 편집기에 붙여넣으세요' }); return; }
    // 복사가 안 되면 코드를 새 창으로 열어 직접 복사하게 한다
    const w = window.open('worker.js', '_blank');
    if (w) w.opener = null;
    else toast.error('Worker 코드를 열지 못했어요', { description: '팝업 차단을 풀고 다시 눌러 주세요' });
  };

  return (
    <Card>
      <CardTitle right={<StatePill mode={mode} result={result} />}>실시간 중계</CardTitle>
      <p className="text-[14px] leading-relaxed text-muted-foreground">
        주식 실시간 시세·차트·종목 뉴스는 네이버 증권에서 받아요. 다른 사이트에서는 바로 받을 수 없어서 이 사이트 전용 중계 서버(Cloudflare Worker)를 거쳐요.
        기본으로 연결돼 있어 어느 기기에서든 따로 설정할 필요가 없어요.
      </p>

      <StatusBox
        mode={mode} result={result} host={cfg ? hostOf(cfg.url) : null}
        action={mode === 'off' ? (
          <Btn tone="primary" onClick={turnOn} disabled={busy} className="w-full sm:w-auto"><Power className="size-4" />기본 중계로 다시 켜기</Btn>
        ) : (
          <Btn tone="card" onClick={() => void check()} disabled={busy} className="w-full sm:w-auto">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}지금 연결 확인
          </Btn>
        )}
      />

      {/* 고급 — 접혀 있다가 펼친다 (직접 입력한 중계를 쓰는 중이면 펼친 채로 시작) */}
      <div className="mt-5 border-t border-border pt-2">
        <button
          type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="relay-advanced"
          className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left text-[14px] font-semibold text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          고급 — 다른 중계 쓰기 · 끄기
          <ChevronDown className={cn('size-4 shrink-0 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="adv" id="relay-advanced"
              initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 0.1, 0.25, 1] }}
              className="-mx-1 overflow-hidden px-1"
            >
              <div className="space-y-4 pt-2 pb-1">
                {/* PC: 주소(넓게) · 키(좁게) 한 줄, 휴대폰: 위아래 */}
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
                  <div>
                    <FieldLabel htmlFor="relay-url">Worker 주소</FieldLabel>
                    <Input
                      id="relay-url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={onEnter}
                      placeholder="https://….workers.dev" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                      aria-describedby="relay-url-help" className={INPUT_CLS}
                    />
                    <p id="relay-url-help" className={HELP_CLS}>비워 두면 기본 중계를 써요</p>
                  </div>
                  <div>
                    <FieldLabel htmlFor="relay-key">접근 키 (ACCESS_KEY)</FieldLabel>
                    <Input
                      id="relay-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={onEnter}
                      autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                      aria-describedby="relay-key-help" className={INPUT_CLS}
                    />
                    <p id="relay-key-help" className={HELP_CLS}>이 사이트에서 쓰면 필요 없어요</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Btn tone="primary" onClick={saveAndTest} disabled={busy} className="col-span-2">저장하고 확인</Btn>
                  <Btn onClick={reset} disabled={busy}><RotateCcw className="size-4" />기본값으로</Btn>
                  <Btn onClick={turnOff} disabled={busy || mode === 'off'}><PowerOff className="size-4" />중계 끄기</Btn>
                </div>

                <div className="rounded-[14px] bg-tile p-4">
                  <div className="text-[14px] font-bold">내 Worker 만들기</div>
                  <ol className="mt-3 space-y-2.5">
                    {STEPS.map((s, i) => (
                      <li key={i} className="flex gap-2.5 text-[13.5px] leading-relaxed text-secondary-foreground">
                        <span className="mt-[2px] flex size-5 shrink-0 items-center justify-center rounded-full bg-card text-[11px] font-bold text-foreground tabular">{i + 1}</span>
                        <span className="min-w-0">{s}</span>
                      </li>
                    ))}
                  </ol>
                  <Btn tone="card" size="sm" onClick={() => void copyWorker()} disabled={copying} className="mt-4">
                    {copying ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}Worker 코드 복사
                  </Btn>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}
