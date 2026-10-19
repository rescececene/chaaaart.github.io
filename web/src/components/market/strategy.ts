// 시장 목록 '전략' 칩 — 일봉 패턴 판정(collector/setups.py, 10분마다)과 그 패턴의 과거 성적(setups_stats.json, 하루 1번)
// 화면에 쓰는 규칙만 여기 모은다: 칩 순서·이름(파일이 없어도 칩은 보이게), 바이낸스 주식 토큰 빼기, 과거 성적 → 쉬운 문장
import type { Market, ScreenerRow, SetupHorizon, SetupStat, SetupsStats, Sym } from '@/lib/market';

export interface SetupDef { key: string; emoji: string; name: string; desc: string; dir: 1 | -1 }

/** 칩 순서 + 이름표 — setups_stats.json 의 defs 가 있으면 그 글을 쓰고, 없으면(첫 검증 전) 이 값 */
export const SETUP_DEFS: SetupDef[] = [
  { key: 'squeeze_breakout', emoji: '🚀', name: '분출 임박', desc: '변동폭이 줄어든 채 고점 바로 아래에서 거래량이 붙기 시작했어요', dir: 1 },
  { key: 'breakout', emoji: '⚡', name: '돌파', desc: '20일 고점을 거래량 2배 이상과 함께 넘었어요', dir: 1 },
  { key: 'new_high', emoji: '🆕', name: '신고가', desc: '최근 1년(코인은 200~250일) 중 가장 높은 값을 종가로 넘었어요', dir: 1 },
  { key: 'volume_surge', emoji: '🔥', name: '거래량 폭발', desc: '거래량이 20일 평균의 3배를 넘었어요', dir: 1 },
  { key: 'uptrend', emoji: '📈', name: '상승 추세', desc: '이동평균 정배열에 추세 강도(ADX)도 강해요', dir: 1 },
  { key: 'pullback', emoji: '🎯', name: '눌림목', desc: '상승 추세 속에 20일선 근처까지 쉬어 왔어요', dir: 1 },
  { key: 'golden_cross', emoji: '✨', name: '골든크로스 직후', desc: '20일선이 60일선을 막 뚫고 올라섰어요', dir: 1 },
  { key: 'bottoming', emoji: '🧱', name: '바닥 다지기', desc: '크게 빠진 뒤 저점을 더 깨지 않고 20일선을 되찾았어요', dir: 1 },
  { key: 'oversold_bounce', emoji: '💧', name: '낙폭 과대 반등', desc: '과하게 빠진 뒤 반등이 시작됐어요', dir: 1 },
  { key: 'overheat', emoji: '🌡️', name: '과열 주의', desc: '단기간에 너무 올라 RSI·이격도가 과열 구간이에요', dir: -1 },
  { key: 'downtrend_warn', emoji: '⚠️', name: '하락 경고', desc: '역배열·지지선 이탈 등 하락 추세가 뚜렷해요', dir: -1 },
];
export const isSetupKey = (x: unknown): x is string => typeof x === 'string' && SETUP_DEFS.some((d) => d.key === x);

/** 주소의 전략 — #/market/upbit/squeeze_breakout (s=squeeze_breakout 도 받는다). 모양만 보고, 있는 전략인지는 쓰는 쪽이 defs 로 확인 */
export function stratFromArg(arg: string | undefined): string | null {
  if (!arg) return null;
  const k = arg.startsWith('s=') ? arg.slice(2) : arg;
  return /^[a-z][a-z0-9_]{1,31}$/.test(k) ? k : null;
}

/** 파일의 defs 를 덧씌운 칩 목록 (순서는 위 목록 · 파일에만 있는 새 탭은 뒤에) */
export function setupDefs(stats: SetupsStats | null | undefined): SetupDef[] {
  const file = stats?.defs ?? {};
  const out = SETUP_DEFS.map((d) => (file[d.key] ? { ...d, ...file[d.key], key: d.key } : d));
  for (const [key, d] of Object.entries(file)) if (!out.some((x) => x.key === key)) out.push({ ...d, key });
  return out;
}

/** 바이낸스 주식 토큰 (bStocks — TSLAB · NVDAB · MUB · QQQB …) — 주식 가격을 따라가는 토큰이라 코인 전략에서 뺀다.
 *  규칙: 대문자 2~5자 + 'B', 업비트에 없는 코인(한글 이름이 없음). BNB·CKB 처럼 B 로 끝나는 진짜 코인은 따로 둔다 */
const COIN_B = new Set(['BNB', 'CKB', 'ARB', 'COMB', 'SAB', 'BOB', 'SNB']);
export function isStockToken(sym: Sym, name: string): boolean {
  if (!sym.startsWith('binance:')) return false;
  const base = sym.slice(8).replace(/USDT$/, '');
  return /^[A-Z]{2,5}B$/.test(base) && !COIN_B.has(base) && name === base;
}

/** 근거 글 — 음수의 '-' 를 진짜 빼기표(U+2212)로, '이탈(−5.5%)' 처럼 글자에 붙은 괄호 앞에서는 줄이 바뀌지 않게(U+2060) */
const minus = (t: string) => t.replace(/(^|[\s(~])-(?=\d)/g, '$1−').replace(/([가-힣a-zA-Z0-9])\(/g, '$1\u2060(');

/** 전략에 걸린 종목 — s 강도(0~100), r 근거(빼기표 정리됨) */
export interface Hit { sym: Sym; s: number; r: string[] }
/** 시장 스크리너 행에서 전략별 종목 (강한 순) — name: 바이낸스 주식 토큰을 가려내는 데 쓰는 이름 */
export function setupHits(rows: ScreenerRow[], market: Market, nameOfSym: (sym: Sym) => string): Map<string, Hit[]> {
  const out = new Map<string, Hit[]>();
  for (const row of rows) {
    if (!row.setups?.length) continue;
    if (market === 'binance' && isStockToken(row.sym, nameOfSym(row.sym))) continue;
    for (const st of row.setups) {
      let l = out.get(st.k);
      if (!l) out.set(st.k, (l = []));
      l.push({ sym: row.sym, s: st.s, r: st.r.map(minus) });
    }
  }
  for (const l of out.values()) l.sort((a, b) => b.s - a.s);
  return out;
}

// ── 과거 성적 → 판정 ──
export type Tone = 'good' | 'weak' | 'none' | 'opp' | 'pending';
export interface Verdict {
  tone: Tone;
  /** 탭 머리에 보일 한 줄 */
  title: string;
  /** 한 줄 옆에 붙일 숫자 — 효과가 뚜렷했을 때만 ('20일 +2.1%p, 시장보다 더 오른 비율 56%') */
  nums?: string;
  /** 펼치면 보일, 숫자를 말로 풀어 쓴 문장 */
  detail: string;
}
const MIN_N = 30; // collector/setups.py 의 _grade 와 같은 기준

const p1 = (x: number) => Math.abs(x).toFixed(1);
/** 부호 붙은 %p — 음수는 진짜 빼기표(U+2212) */
export function signedP(x: number, d = 1): string {
  const t = Math.abs(x).toFixed(d);
  if (Number(t) === 0) return t; // −0.0 · +0.0 이 아니라 0.0
  return `${x > 0 ? '+' : '−'}${t}`;
}
const sig = (h: SetupHorizon | undefined, dir: 1 | -1) => !!h?.ci && (dir > 0 ? h.ci[0] > 0 : h.ci[1] < 0);
const against = (h: SetupHorizon | undefined, dir: 1 | -1) => !!h?.ci && (dir > 0 ? h.ci[1] < 0 : h.ci[0] > 0);
const enough = (h: SetupHorizon | undefined): h is SetupHorizon => !!h && h.n >= MIN_N && !!h.ci;

/** 보여 줄 기간 — 판정을 만든 쪽(뚜렷한 쪽)을 먼저, 같으면 20일 */
function pickH(st: SetupStat, test: (h: SetupHorizon | undefined) => boolean): { h: SetupHorizon; days: number } | null {
  if (test(st.h20) && st.h20) return { h: st.h20, days: 20 };
  if (test(st.h5) && st.h5) return { h: st.h5, days: 5 };
  return null;
}

/** 과거 성적 판정 — stat 이 없으면 '아직 검증 전'.
 *  good·weak·none 은 수집기(_grade)의 등급 그대로, opp 는 '반대 방향으로 뚜렷함' (등급보다 먼저 본다) */
export function verdictOf(stat: SetupStat | null | undefined, dir: 1 | -1, stock: boolean): Verdict {
  if (!stat) return { tone: 'pending', title: '아직 과거 검증 전이에요', detail: '검증이 끝나면 이 전략이 과거에 시장보다 나았는지 여기에 보여 드려요.' };
  const unit = stock ? '거래일' : '일';
  const diff = (h: SetupHorizon, days: number) => {
    const x = h.avgEx;
    return Math.abs(x) < 0.05
      ? `신호 뒤 ${days}${unit} 수익이 시장 평균과 거의 같았어요`
      : `신호 뒤 ${days}${unit} 수익이 시장 평균보다 ${p1(x)}%p ${x > 0 ? '높았어요' : '낮았어요'}`;
  };
  if (!enough(stat.h5) || !enough(stat.h20)) {
    const n = Math.max(stat.h5?.n ?? 0, stat.h20?.n ?? 0, 0);
    return { tone: 'none', title: '과거엔 효과가 뚜렷하지 않았어요', detail: `과거 신호가 ${n.toLocaleString('ko-KR')}번뿐이라 판단하기 어려워요.` };
  }
  if (stat.opp) {
    const at = pickH(stat, (h) => against(h, dir)) ?? { h: stat.h20, days: 20 };
    return dir > 0
      ? { tone: 'opp', title: '과거엔 오히려 시장보다 약했어요', detail: `${diff(at.h, at.days)}. 이 신호를 보고 샀다면 평균적으로 불리했어요.` }
      : { tone: 'opp', title: '과거엔 오히려 시장보다 나았어요 — 경고가 맞지 않았어요', detail: `${diff(at.h, at.days)}. 경고와 반대로 움직인 경우가 많았어요.` };
  }
  if (stat.grade === 'good') {
    const at = pickH(stat, (h) => sig(h, dir)) ?? { h: stat.h20, days: 20 };
    const nums = `${at.days}${unit} ${signedP(at.h.avgEx)}%p, 시장보다 더 오른 비율 ${Math.round(at.h.win)}%`;
    return dir > 0
      ? { tone: 'good', title: '과거에 실제로 시장보다 나았어요', nums, detail: `${diff(at.h, at.days)}. 우연으로 보기 어려운 차이였어요.` }
      : { tone: 'good', title: '과거에 실제로 시장보다 약했어요 — 경고가 맞았어요', nums, detail: `${diff(at.h, at.days)}. 우연으로 보기 어려운 차이였어요.` };
  }
  if (stat.grade === 'weak') {
    return {
      tone: 'weak',
      title: dir > 0 ? '조금 나았지만 우연일 수 있어요' : '조금 약했지만 우연일 수 있어요',
      detail: `${diff(stat.h20, 20)}. 차이가 작아 우연히 생길 수 있는 정도예요.`,
    };
  }
  return { tone: 'none', title: '과거엔 효과가 뚜렷하지 않았어요', detail: `${diff(stat.h20, 20)}. 우연히 생길 수 있는 정도의 차이예요.` };
}

/** '분출'(크게 치솟음) 기준 — 기간 안에 고가가 이만큼(%) 넘게 오른 적이 있으면 (collector/setups.py POP) */
export function popThreshold(stats: SetupsStats | null | undefined, stock: boolean): { h5: number; h20: number } {
  const p = (stats as (SetupsStats & { pop?: Record<'coin' | 'stock', { h5: number; h20: number }> }) | null | undefined)?.pop?.[stock ? 'stock' : 'coin'];
  return p ?? (stock ? { h5: 7, h20: 15 } : { h5: 15, h20: 30 });
}

/** 검증에 쓴 기록 — 기간·종목 수 */
export function statsMeta(stats: SetupsStats | null | undefined, market: Market): { from: string; to: string; symbols: number } | null {
  const m = (stats as (SetupsStats & { meta?: Partial<Record<Market, { from?: string; to?: string; symbols?: number }>> }) | null | undefined)?.meta?.[market];
  return m?.from && m.to ? { from: m.from, to: m.to, symbols: m.symbols ?? 0 } : null;
}
