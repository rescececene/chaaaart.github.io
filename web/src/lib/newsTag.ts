// 뉴스 호재·악재 판단 + 관련 코인·종목 찾기
//  근거는 아래 순서로 하나만 쓰고, 무엇으로 정했는지 화면에 밝힌다
//   1) AI — GitHub Actions 가 Cloudflare Workers AI 로 만든 data/news_ai.json (코인·주식 속보만. 해외 속보는 판단하지 않는다)
//   2) 코인니스 이용자 투표 — 표 수까지 감안한 Wilson 구간. 피드마다 '보통 뉴스'의 호재 표 비율이 달라 기준점을 따로 둔다
//   3) 핵심 단어 — 제목·요약의 좋은 말·나쁜 말 점수 (어느 단어였는지 함께 돌려준다)
import { binanceTop, isValidSym, listOrder, nameOf, namesVersion, upbitMarkets, type AiTag, type NewsItem, type Sym } from './market';

export type Level = 2 | 1 | 0 | -1 | -2;
export type Basis = 'ai' | 'votes' | 'keywords' | 'none';
export interface Sentiment {
  level: Level; label: string; basis: Basis;
  /** AI 가 적은 이유 */
  reason?: string;
  /** 이용자 투표 — 표가 충분할 때만 (근거가 AI 여도 함께 보여 줄 수 있게) */
  bullPct?: number; votes?: number;
  /** 투표로 정했을 때 이 피드의 '보통 뉴스' 호재 표 비율 — 한쪽으로 기울었는데 중립이면 '평소 수준'이라 알려 준다 */
  base?: number;
  /** 제목·요약에서 찾은 좋은 말 · 나쁜 말 */
  pos?: string[]; neg?: string[];
}
export const LEVEL_LABEL: Record<Level, string> = { 2: '미친 호재', 1: '호재', 0: '중립', [-1]: '악재', [-2]: '미친 악재' } as Record<Level, string>;
const isLevel = (s: unknown): s is Level => s === 2 || s === 1 || s === 0 || s === -1 || s === -2;

/** 피드 성격 — 관련 종목을 코인에서 찾을지 주식에서 찾을지 */
export type FeedKind = 'coin' | 'stock' | 'mixed';

/** 이 수 이상 투표가 모여야 투표로 판단한다 */
export const MIN_VOTES = 20;
/** 피드별 '보통 뉴스'의 호재 표 비율 — 코인 속보 이용자는 호재 쪽으로, 지정학 소식이 많은 주식 속보 이용자는 악재 쪽으로 기운다
 *  코인 속보: 2024-01~2026-10 코인니스 1만 4천여 건 실측 — 보통 기사도 호재 표가 84~92% (중앙값 0.84).
 *  예전 기준(0.55)으로는 기사 82% 가 '호재'로 나와 뜻이 없었다 → 중앙값 기준으로 위·아래 꼬리만 호재·악재로 본다. */
export const VOTE_NEUTRAL: Record<string, number> = { coinflash: 0.84, stockflash: 0.4 };
/** 투표 판단 기준 — 호재: 표 비율 하한이 good 이상 · 악재: 상한이 bad 이하 · 미친: 관심 폭발(중요·평소 2배 표)이면서 더 극단 */
interface VoteRef { good: number; bad: number; crazyGood: number; crazyBad: number }
function voteRef(base: number): VoteRef {
  // 코인 속보처럼 기준이 높은 피드는 위쪽 여유가 좁다 (실측 분포: 호재 ≥ 0.89, 악재 ≤ 0.66)
  if (base >= 0.75) return { good: base + 0.05, bad: base - 0.18, crazyGood: Math.min(0.97, base + 0.11), crazyBad: base - 0.34 };
  return { good: base + 0.12, bad: base - 0.1, crazyGood: base + 0.3, crazyBad: base - 0.25 };
}

/** k/n 비율의 Wilson 구간 (z=1 ≈ 68%) — 표가 적을수록 넓어져 섣불리 판단하지 않는다 */
function wilson(k: number, n: number, z = 1): [number, number] {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z, c = p + z2 / (2 * n), d = 1 + z2 / n;
  const m = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(c - m) / d, (c + m) / d];
}

// 핵심 단어 (가중치) — 제목·요약에 들어 있으면 더한다
const POS: [RegExp, number][] = [
  [/폭등|급등|불기둥|사상\s?최고|역대\s?최[대고]|신고가|최고치\s?경신/, 2],
  [/(?:ETF|상장)\s?승인|승인\s?(?:받|획득)|현물\s?ETF/, 2],
  [/상향|호실적|어닝\s?서프라이즈|흑자\s?전환|수주|대규모\s?(?:투자|계약)|파트너십|인수|합병|자사주\s?(?:매입|소각)|추가\s?매수|매집/, 1],
  [/상승|반등|강세|돌파|순매수|순유입|유입|기대감|수혜|호재|증가|확대|상장(?!\s?(?:폐지|사|기업|된|한))|채택|협력|출시|승인|획득/, 1],
];
const NEG: [RegExp, number][] = [
  [/폭락|급락|붕괴|해킹|파산|상장\s?폐지|사기|뱅크런|디폴트|청산\s?폭탄|러그\s?풀/, 2],
  [/소송|기소|제재|조사\s?착수|압수수색|규제\s?강화|금지/, 2],
  [/하향|어닝\s?쇼크|적자|손실|감원|리콜|중단|연기|부진|경고|우려|악재|최저|급감|하회|전량\s?매도/, 1],
  [/하락|약세|순매도|순유출|유출|매도\s?(?:압력|세)|감소|축소|둔화|불안/, 1],
];
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
// '급락 출발했지만… 반등 성공'처럼 앞뒤가 뒤집히면 뒤쪽 말이 결론이다
const CONTRAST = /지만|에도\s|는데\s|불구하고/g;
// 금리·환율·물가·유가처럼 오르내림만으로 좋고 나쁨을 가를 수 없는 지표 — 이런 기사에선 '급등·하락·최저' 같은 움직임 낱말을 세지 않는다
// ('국채금리 급등'은 호재가 아니고, '환율 하락·2년 만에 최저'는 악재가 아니다. '1억 달러 규모'의 달러, '유가증권'은 지표가 아니다)
const MACRO = /금리|국채|채권|환율|원[/·]달러|달러\s?(?:인덱스|지수|가치)|물가|인플레(?:이션)?|CPI|PPI|PCE|실업률|국제\s?유가|(?<![가-힣])유가(?!증권)|WTI|브렌트유|VIX|변동성\s?지수|공포\s?지수/;
const MOVE = /폭등|급등|폭락|급락|불기둥|사상\s?최[고저]|역대\s?최[대고저]|신고가|신저가|최고치(?:\s?경신)?|최저치?|상승|하락|반등|강세|약세|돌파|상회|하회|급감|증가|감소|확대|축소|둔화/g;
/** 좋은 말·나쁜 말 점수와 찾은 단어 — 마지막 '~지만/~에도' 뒤쪽은 1.5배, 앞쪽은 0.5배 */
export function keywordHits(text: string) {
  let cut = -1, len = 0;
  for (const m of text.matchAll(CONTRAST)) { cut = m.index; len = m[0].length; }
  const segs: [string, number][] = cut < 0 ? [[text, 1]] : [[text.slice(0, cut), 0.5], [text.slice(cut + len), 1.5]];
  const parts = MACRO.test(text) ? segs.map(([t, k]): [string, number] => [t.replace(MOVE, ' '), k]) : segs;
  let score = 0;
  const pos: string[] = [], neg: string[] = [];
  for (const [part, k] of parts) {
    for (const [re, w] of POS) { const m = re.exec(part); if (m) { score += w * k; if (!pos.includes(tidy(m[0]))) pos.push(tidy(m[0])); } }
    for (const [re, w] of NEG) { const m = re.exec(part); if (m) { score -= w * k; if (!neg.includes(tidy(m[0]))) neg.push(tidy(m[0])); } }
  }
  return { score, pos, neg };
}

/** 같은 피드의 투표 수 중앙값 — '관심 폭발' 판단 기준 */
export function medianVotes(items: NewsItem[]) {
  const ns = items.map((x) => (x.bull ?? 0) + (x.bear ?? 0)).filter((n) => n > 0).sort((a, b) => a - b);
  return ns.length ? ns[Math.floor(ns.length / 2)] : 0;
}

/** 호재·악재 판단 — ai 가 있으면 AI, 없으면 투표(표가 충분할 때), 그것도 없으면 핵심 단어.
 *  neutral: 이 피드에서 '보통 뉴스'로 보는 호재 표 비율 (VOTE_NEUTRAL) */
export function sentimentOf(it: NewsItem, feedMedianVotes: number, ai?: AiTag | null, neutral = 0.5): Sentiment {
  const bull = Math.max(0, it.bull ?? 0), bear = Math.max(0, it.bear ?? 0), n = bull + bear;
  const v: Pick<Sentiment, 'bullPct' | 'votes'> = n >= MIN_VOTES ? { bullPct: bull / n, votes: n } : {};
  if (ai && isLevel(ai.s)) {
    return { level: ai.s, label: LEVEL_LABEL[ai.s], basis: 'ai', reason: typeof ai.r === 'string' && ai.r.trim() ? ai.r.trim() : undefined, ...v };
  }
  if (n >= MIN_VOTES) {
    const p = bull / n, [lo, hi] = wilson(bull, n);
    const hot = !!it.important || (feedMedianVotes > 0 && n >= 2 * feedMedianVotes); // 중요 표시거나 관심이 평소의 2배 이상
    const r = voteRef(neutral);
    let level: Level = 0;
    if (lo >= r.good) level = hot && p >= r.crazyGood ? 2 : 1;
    else if (hi <= r.bad) level = hot && p <= r.crazyBad ? -2 : -1;
    return { level, label: LEVEL_LABEL[level], basis: 'votes', base: neutral, ...v };
  }
  const k = keywordHits(`${it.title} ${it.summary || ''}`);
  const level: Level = k.score >= 4 ? 2 : k.score >= 2 ? 1 : k.score <= -4 ? -2 : k.score <= -2 ? -1 : 0;
  return { level, label: LEVEL_LABEL[level], basis: level ? 'keywords' : 'none', pos: k.pos, neg: k.neg, ...v };
}

// ── 관련 코인·종목 ──
// 본문의 영문 대문자 낱말 중 티커처럼 보이지만 흔한 단어·약어라 거르는 것
const STOP = new Set(['THE', 'FOR', 'AND', 'ALL', 'ONE', 'NOW', 'NEW', 'CEO', 'CFO', 'COO', 'CTO', 'ETF', 'SEC', 'USD', 'KRW', 'GDP', 'CPI', 'PPI', 'PCE', 'FED', 'IPO', 'API',
  'DEX', 'CEX', 'NFT', 'DAO', 'TOP', 'BIG', 'ANY', 'KEY', 'MAX', 'CAN', 'HAS', 'ARE', 'WAS', 'NOT', 'BUT', 'YOU', 'OUT', 'GET', 'SET', 'RUN', 'WIN', 'TRUE',
  'FOMC', 'ECB', 'BOJ', 'IMF', 'OPEC', 'NYSE', 'AMEX', 'ESG', 'EPS', 'YOY', 'QOQ', 'AMA', 'DEFI', 'USDT', 'USDC', 'LIVE', 'NEXT', 'OPEN', 'HIGH', 'MOVE',
  'USA', 'UAE', 'LNG', 'WTI', 'GPU', 'CPU', 'HBM', 'DRAM', 'NAND', 'RWA', 'TVL', 'ATH', 'OTC', 'KYC', 'AML', 'CBDC', 'MSCI', 'NASDAQ', 'KOSPI', 'KOSDAQ',
  'HOME', 'TREE', 'SAFE', 'DEEP', 'DATA', 'BEAM', 'RED', 'SUN', 'BIO', 'ERA', 'LIT', 'HIVE', 'MEGA', 'SUPER', 'SIGN', 'PUMP', 'EDGE', 'TRUST', 'MASK',
  'GAME', 'ORDER', 'LAYER', 'CHIP', 'HUNT', 'HOLO', 'CAP', 'ARK', 'META', 'AI', 'IR', 'EU', 'UK', 'US', 'UN']);
// AI 가 고른 티커에서 거를 것 (스테이블코인은 AI 가 고르면 그대로 쓴다)
const AI_STOP = new Set([...STOP].filter((t) => t !== 'USDT' && t !== 'USDC' && t !== 'META'));
// 한글 이름으로 본문에서 찾을 코인 — 이름이 흔한 낱말과 겹치는 코인(샌드박스·모멘텀·가스 …)은 티커나 AI 로만 잇는다
const MAJOR = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'SUI', 'SHIB', 'PEPE', 'BCH', 'NEAR', 'APT', 'ARB', 'OP', 'ETC',
  'XLM', 'HBAR', 'UNI', 'AAVE', 'INJ', 'TIA', 'WLD', 'ONDO', 'ENA', 'POL', 'FIL', 'ICP', 'IMX', 'TRUMP', 'WLFI', 'USDT', 'USDC', 'BSV', 'ALGO', 'VET', 'XTZ', 'KAIA']);
const COIN_ALIAS: Record<string, string[]> = { POL: ['폴리곤'], NEAR: ['니어'], XRP: ['리플'], TRUMP: ['트럼프코인'] };
// 미국 종목 한글 이름 중 본문에서 찾지 않을 것 (지수 이름 등)
const US_NAME_SKIP = new Set(['나스닥', '플렉스', '파카', '린드', '옥타']);
// 미국 종목 이름 꼬리 — '아마존닷컴' 기사엔 '아마존'만 나온다
const US_SUFFIX = /\s*(?:Class\s?[A-C]|ADR|닷컴|홀딩스?|그룹|글로벌|인터내셔널|코퍼레이션|컴퍼니|테크놀로지스?|테크놀러지|시스템즈|파마슈티컬스?)$/i;

const HANGUL = /[가-힣]/;
const ALNUM = /[A-Za-z0-9]/;
const PARTICLE = /^[은는이가을를의에와과도로만측]/;
/** 본문에 이 이름이 '낱말로' 들어 있나 — 앞에 다른 글자가 붙어 있으면 아니다 (엔지니어 ≠ 니어).
 *  두 글자 이름은 뒤에도 조사 말고 다른 글자가 붙으면 아니다 (메타플래닛 ≠ 메타) */
export function hasWord(text: string, w: string): boolean {
  if (!w) return false;
  for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) {
    const prev = i > 0 ? text[i - 1] : ' ';
    if (HANGUL.test(prev) || ALNUM.test(prev)) continue;
    const next = text[i + w.length] ?? ' ';
    if (ALNUM.test(w[w.length - 1]) && ALNUM.test(next)) continue; // SKC ≠ SKCX
    if (w.length <= 2 && HANGUL.test(next) && !PARTICLE.test(next)) continue;
    return true;
  }
  return false;
}
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

interface Entry { sym: Sym; words: string[] }
interface Index {
  coins: Entry[]; stocks: Entry[];
  coinTickers: Map<string, Sym>; usTickers: Map<string, Sym>; krxCodes: Set<string>;
  coinNames: Map<string, Sym>; krxNames: Map<string, Sym>; usNames: Map<string, Sym>; enNames: Map<string, Sym>;
  prefix: [string, Sym][];
  coin: (code: string) => Sym | null;
}
let index: Index | null = null;
let indexKey = '';
function buildIndex(): Index {
  const up = upbitMarkets(), bn = binanceTop();
  const key = `${Object.keys(up).length}|${listOrder.krx.length}|${listOrder.us.length}|${bn.length}|${namesVersion()}`;
  if (index && key === indexKey) return index;
  const bnSet = new Set(bn);
  const coin = (c: string): Sym | null => (up['KRW-' + c] ? 'upbit:KRW-' + c : bnSet.has(c + 'USDT') ? 'binance:' + c + 'USDT' : null);
  const coins: Entry[] = [], stocks: Entry[] = [];
  const coinTickers = new Map<string, Sym>(), usTickers = new Map<string, Sym>(), krxCodes = new Set<string>();
  const coinNames = new Map<string, Sym>(), krxNames = new Map<string, Sym>(), usNames = new Map<string, Sym>(), enNames = new Map<string, Sym>();
  const prefix: [string, Sym][] = [];
  const setOnce = (m: Map<string, Sym>, k: string, s: Sym) => { if (k && !m.has(k)) m.set(k, s); };

  for (const [code, [name, en]] of Object.entries(up)) {
    const t = code.slice(4), sym = 'upbit:' + code;
    const words = name.split(/[()]/).map((w) => w.trim()).filter((w) => w.length >= 2 && HANGUL.test(w));
    for (const w of words) setOnce(coinNames, norm(w), sym);
    if (en) setOnce(enNames, norm(en), sym);
    if (MAJOR.has(t)) coins.push({ sym, words: [...words, ...(COIN_ALIAS[t] || [])] });
    if (t.length >= 3 && !STOP.has(t)) coinTickers.set(t, sym);
  }
  for (const s of bn) {
    const t = s.replace(/USDT$/, '');
    if (t.length >= 3 && !STOP.has(t) && !coinTickers.has(t)) coinTickers.set(t, 'binance:' + s);
  }
  listOrder.krx.forEach((sym, i) => {
    const n = nameOf(sym), code = sym.slice(4);
    krxCodes.add(code);
    if (!n.name || n.name === code) return;
    setOnce(krxNames, norm(n.name), sym);
    prefix.push([norm(n.name), sym]);
    // 두 글자 이름(기아 등)은 시가총액 상위만 · 영문 이름은 세 글자 이상만
    const ascii = !HANGUL.test(n.name);
    if (ascii ? n.name.length >= 3 : n.name.length >= 3 || (i < 60 && n.name.length === 2)) stocks.push({ sym, words: [n.name] });
  });
  listOrder.us.forEach((sym, i) => {
    const n = nameOf(sym);
    if (n.sub && n.sub !== sym.slice(3)) setOnce(usTickers, n.sub.toUpperCase(), sym);
    if (!n.name || n.name === sym.slice(3)) return;
    const names = n.name.split(/[()]/).map((w) => w.trim()).filter(Boolean);
    const words: string[] = [];
    for (const full of names) {
      let short = full;
      for (let k = 0; k < 3 && US_SUFFIX.test(short); k++) short = short.replace(US_SUFFIX, '');
      for (const w of new Set([full, short])) {
        // 'SK하이닉스 ADR' 의 줄인 이름은 국내 종목 이름과 같다 — 국내 종목으로만 잇는다
        if (w.length < 2 || !HANGUL.test(w) || (w !== full && krxNames.has(norm(w)))) continue;
        setOnce(usNames, norm(w), sym);
        prefix.push([norm(w), sym]);
        // 미국 종목 한글 이름은 짧은 것(애플 등)도 시총 상위면 쓴다
        if (!US_NAME_SKIP.has(w) && (w.length >= 3 || i < 120)) words.push(w);
      }
    }
    if (words.length) stocks.push({ sym, words });
  });
  index = { coins, stocks, coinTickers, usTickers, krxCodes, coinNames, krxNames, usNames, enNames, prefix, coin };
  indexKey = key;
  return index;
}

/** AI 가 적은 관련 자산 하나 → 종목 (BTC → 업비트/바이낸스, NVDA → 미국, 삼성전기 → 국내) */
function resolveOne(t: string, kind: FeedKind, idx: Index): Sym | null {
  if (/^\d{6}$/.test(t)) return idx.krxCodes.has(t) ? 'krx:' + t : null;
  if (/^[A-Za-z][A-Za-z0-9.-]{0,11}$/.test(t)) {
    const T = t.toUpperCase();
    if (AI_STOP.has(T)) return null;
    const coin = T.length >= 2 ? idx.coin(T) : null;
    const us = idx.usTickers.get(T) ?? null, en = idx.enNames.get(T) ?? null;
    return kind === 'coin' ? coin ?? en ?? us : us ?? coin ?? en;
  }
  const key = norm(t);
  if (key.length < 2) return null;
  const order = kind === 'coin' ? [idx.coinNames, idx.krxNames, idx.usNames] : [idx.krxNames, idx.usNames, idx.coinNames];
  for (const m of order) { const s = m.get(key); if (s) return s; }
  if (key.length >= 3 && HANGUL.test(key)) for (const [name, sym] of idx.prefix) if (name.startsWith(key)) return sym; // 삼성바이오 → 삼성바이오로직스
  return null;
}
export function resolveTag(raw: string, kind: FeedKind): Sym | null {
  const idx = buildIndex();
  // '엔비디아(NVDA)' 처럼 오면 괄호 안팎 둘 다 본다
  for (const part of String(raw || '').split(/[()]/).map((s) => s.trim().replace(/^\$/, '')).filter(Boolean)) {
    const s = resolveOne(part, kind, idx);
    if (s) return s;
  }
  return null;
}

export interface Related { sym: Sym; name?: string }
/** 관련 코인·종목 (최대 max 개) — 코인니스 코드 → 네이버 관련 종목 → AI 가 고른 것 → 본문 속 이름·티커 순.
 *  kind: 피드 성격 (coin / stock / mixed) */
export function relatedOf(it: NewsItem, kind: FeedKind, ai?: AiTag | null, max = 4): Related[] {
  const out: Related[] = [];
  const seen = new Set<Sym>();
  const add = (sym: Sym | null | undefined, name?: string) => {
    if (!sym || seen.has(sym) || out.length >= max) return;
    seen.add(sym);
    out.push(name ? { sym, name } : { sym });
  };
  const idx = buildIndex();
  for (const c of it.codes || []) if (c) add(idx.coin(String(c).toUpperCase()));
  for (const r of it.rel || []) if (r?.sym && isValidSym(r.sym)) add(r.sym, r.name);
  for (const t of ai && Array.isArray(ai.t) ? ai.t : []) add(resolveTag(t, kind));
  if (out.length >= 3) return out;
  const text = `${it.title} ${it.summary || ''}`;
  const coinText = kind !== 'stock' && !(it.codes && it.codes.length); // 코인니스가 코인을 붙여 줬으면 그걸 믿는다
  if (coinText) for (const e of idx.coins) if (e.words.some((w) => hasWord(text, w))) add(e.sym);
  if (kind !== 'coin') for (const e of idx.stocks) if (e.words.some((w) => hasWord(text, w))) add(e.sym);
  for (const m of text.matchAll(/(?<![A-Za-z0-9$])\$?([A-Z][A-Z0-9]{2,9})(?![A-Za-z0-9])/g)) {
    const t = m[1];
    if (STOP.has(t)) continue;
    if (coinText) add(idx.coinTickers.get(t));
    if (kind !== 'coin') add(idx.usTickers.get(t));
  }
  return out;
}
