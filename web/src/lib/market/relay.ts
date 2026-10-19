// 중계(Cloudflare Worker) — 브라우저에서 직접 못 부르는 네이버 증권·업비트 REST·야후를 대신 호출
// 기본 Worker 는 이 사이트 주소(Origin)에서 온 요청만 받는다 (worker/worker.js) → 사이트에는 비밀값이 없다.
// 설정 화면에서 다른 주소·키를 넣으면 그게 우선하고, 끄면 {off: true} 로 저장한다. (저장 형식은 이전 버전과 같다)
import { getJSON, getText, HttpError, Store } from './core';

export interface RelayCfg { url: string; key: string }
type Saved = RelayCfg | { off: true } | null;

const DEFAULT_RELAY: RelayCfg = {
  url: (import.meta.env.VITE_RELAY_URL as string | undefined) || 'https://market-relay.get943.workers.dev',
  key: '',
};
const listeners = new Set<() => void>();
let version = 0;

// 이 기기에서 오늘 부른 중계 횟수 — Cloudflare 무료 플랜은 계정 전체 하루 10만 건(UTC 0시 초기화)이라
// 한 기기가 4만 건을 넘기면 실시간 호출을 줄인다 (고장 난 화면이 계속 부르는 경우 등의 안전장치)
const COUNT_KEY = 'ml.relayCount';
const SOFT_LIMIT = 40_000;
const utcDay = () => new Date().toISOString().slice(0, 10);
let count = Store.get<{ day: string; n: number }>(COUNT_KEY, { day: '', n: 0 });
function bump() {
  const day = utcDay();
  if (count.day !== day) count = { day, n: 0 };
  if (++count.n % 25 === 0) Store.set(COUNT_KEY, count);
}

export const Relay = {
  saved(): Saved { return Store.get<Saved>('ml.relay', null); },
  cfg(): RelayCfg | null {
    const s = this.saved();
    if (s && 'off' in s) return null;
    return s && 'url' in s && s.url ? s : DEFAULT_RELAY;
  },
  mode(): 'off' | 'custom' | 'default' {
    const s = this.saved();
    return s && 'off' in s ? 'off' : s && 'url' in s && s.url ? 'custom' : 'default';
  },
  defaultUrl: DEFAULT_RELAY.url,
  save(cfg: RelayCfg | { off: true } | null) {
    if (cfg && 'url' in cfg && cfg.url) Store.set('ml.relay', { url: cfg.url.trim().replace(/\/+$/, ''), key: (cfg.key || '').trim() });
    else if (cfg && 'off' in cfg) Store.set('ml.relay', { off: true });
    else Store.set('ml.relay', null);
    version++;
    listeners.forEach((fn) => fn());
  },
  ok(): boolean { const c = this.cfg(); return !!(c && c.url); },
  url(route: string, path = '', params?: Record<string, string | number>): string {
    const c = this.cfg();
    if (!c) throw new Error('중계가 꺼져 있습니다');
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) q.set(k, String(v));
    if (c.key) q.set('k', c.key);
    const qs = q.toString();
    return `${c.url}/${route}${path ? '/' + path : ''}${qs ? '?' + qs : ''}`;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json<T = any>(route: string, path = '', params?: Record<string, string | number>): Promise<T> { const u = this.url(route, path, params); bump(); return getJSON<T>(u); },
  text(route: string, path = '', params?: Record<string, string | number>) { const u = this.url(route, path, params); bump(); return getText(u); },
  /** 이 기기에서 오늘(UTC) 부른 중계 횟수 */
  today(): number { return count.day === utcDay() ? count.n : 0; },
  /** 오늘 너무 많이 불렀으면 true → 실시간 호출을 줄인다 */
  overBudget(): boolean { return this.today() > SOFT_LIMIT; },
  /** 설정 화면의 [연결 확인] — 성공하면 저장, 실패하면 이전 설정으로 되돌린다 (cfg 없으면 지금 설정 확인) */
  async test(cfg?: RelayCfg | null): Promise<{ ok: boolean; msg: string }> {
    const prev = this.saved();
    if (cfg) this.save(cfg);
    try {
      const c = this.cfg();
      if (!c) throw new Error('중계가 꺼져 있습니다');
      const head = await getJSON<{ access?: boolean; keyOk?: boolean }>(`${c.url}/${c.key ? '?k=' + encodeURIComponent(c.key) : ''}`);
      if (!(head.access ?? head.keyOk)) throw new Error('이 사이트에서 쓸 수 없는 중계입니다 — Worker 코드가 최신인지, 접근 키가 맞는지 확인하세요');
      const d = await this.json('naver-poll', 'domestic/stock/005930');
      const s = d.datas && d.datas[0];
      if (!s) throw new Error('네이버 응답이 비어 있습니다');
      return { ok: true, msg: `연결됨 — ${s.stockName} ${s.closePrice}원 (실시간)` };
    } catch (e) {
      Store.set('ml.relay', prev);
      version++;
      listeners.forEach((fn) => fn());
      const err = e as HttpError;
      return { ok: false, msg: err.status === 403 ? '네이버가 중계 서버를 막았습니다 (403)' : err.status === 401 ? '중계가 이 요청을 거부했습니다 (401) — Worker 코드를 최신으로 바꿔 주세요' : err.message || String(e) };
    }
  },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  version: () => version,
};
