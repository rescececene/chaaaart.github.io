// AI 사용량 — 뉴스 판단·종목 해설은 Gemma(Cloudflare 무료, data/ai_usage.json),
// 예측 문장(비트코인 결론·펌핑 설명·순위 이유)은 클로드 하이쿠(사용자 Anthropic Console 크레딧, data/claude_usage.json —
// 이 사이트 몫 누적 150달러까지, 키가 없거나 한도에 닿으면 Gemma). 둘 다 GitHub Actions 가 만드는 정적 파일이라 중계와 상관없다.
import { staticJSON } from './staticData';

/** data/ai_usage.json — Gemma 하루(UTC 0시 초기화) 뉴런 어림 · by: 모듈별 (news · stock · btc …) */
export interface GemmaUsage { day: string; neurons: number; by?: Record<string, number> }

export interface ClaudeCell { usd: number; calls: number }
/** data/claude_usage.json — 클로드 돈 장부 (collector/claude_ai.py). 마켓 사이트 사용분만 센다(같은 Console 조직의 야구 게임은 빠짐) */
export interface ClaudeUsage {
  updatedAt: string;
  model?: string;
  limitUsd: number; // 누적 한도 (150)
  dailyLimitUsd: number; // 하루 안전장치 (3, 한국 날짜)
  totalUsd: number | null; // 장부를 못 읽은 상태(unknown)면 null
  unknown?: boolean;
  calls?: number;
  days?: Record<string, ClaudeCell>; // 한국 날짜별
  by?: Record<string, ClaudeCell>; // 모듈별 (btc · pump · rank …)
  status?: { code: string; msg?: string; at?: string };
}

export const gemmaUsage = () => staticJSON<GemmaUsage>('ai_usage.json', 2 * 60e3);
export const claudeUsage = () => staticJSON<ClaudeUsage>('claude_usage.json', 2 * 60e3);

/** 한국 날짜 'YYYY-MM-DD' (클로드 장부의 하루) */
export const kstDay = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
/** UTC 날짜 (Gemma 무료 사용량의 하루) */
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** 오늘 Gemma 뉴런 (날짜가 지난 장부면 0) */
export const gemmaToday = (u: GemmaUsage | null | undefined): number | null =>
  u && typeof u.neurons === 'number' && Number.isFinite(u.neurons) ? (u.day === utcDay() ? u.neurons : 0) : null;
/** 오늘(한국 날짜) 클로드 달러 */
export const claudeToday = (u: ClaudeUsage | null | undefined): number => {
  const v = u?.days?.[kstDay()]?.usd;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

const REASON: Record<string, string> = {
  nokey: '클로드 키가 아직 없어요',
  nosdk: '클로드 SDK를 설치하지 못했어요',
  limit: '누적 한도에 닿았어요',
  daily: '오늘 한도에 닿았어요 · 내일 다시 써요',
  auth: '클로드 키 인증에 실패했어요',
  perm: '클로드 키에 권한이 없어요',
  model: '하이쿠 모델을 쓸 수 없어요',
  credit: 'Console 크레딧이 부족해요',
  error: '클로드 연결 오류가 이어졌어요',
  ledger: '사용 장부를 확인하지 못해 쉬고 있어요',
};

/** 예측 문장 AI 상태 — on: 클로드로 쓰는 중 / 아니면 Gemma 로 쓰는 이유. tone: 화면 점 색 */
export function claudeState(u: ClaudeUsage | null | undefined): { on: boolean; reason: string; tone: 'good' | 'warn' | 'off' } {
  if (!u) return { on: false, reason: '아직 기록이 없어요', tone: 'off' };
  if (u.unknown || typeof u.totalUsd !== 'number') return { on: false, reason: REASON.ledger, tone: 'warn' };
  const code = u.status?.code || 'ok';
  if (code === 'ok' || (code === 'daily' && claudeToday(u) < u.dailyLimitUsd * 0.98)) { // 날짜가 바뀌면 다시 쓴다
    return u.totalUsd >= u.limitUsd ? { on: false, reason: REASON.limit, tone: 'warn' } : { on: true, reason: '', tone: 'good' };
  }
  return { on: false, reason: REASON[code] || u.status?.msg || '클로드를 쓸 수 없어요', tone: code === 'nokey' ? 'off' : 'warn' };
}

/** 쓴 돈 — $1.23 (0보다 크고 0.5센트 미만은 '$0.01 미만') */
export const usdText = (v: number) => (v > 0 && v < 0.005 ? '$0.01 미만' : `$${v.toFixed(2)}`);
/** 한도 — 딱 떨어지면 $150 · $3 */
export const usdLimit = (v: number) => (Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);
