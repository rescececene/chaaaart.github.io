// 시장 데이터 공통 타입
export type Market = 'upbit' | 'binance' | 'krx' | 'us';
/** "시장:코드" — upbit:KRW-BTC · binance:BTCUSDT · krx:005930 · us:AAPL.O (네이버 reutersCode) */
export type Sym = string;
export type Interval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';

/** t 는 '현지 벽시계 시각을 UTC 로 적은' 초 — 분봉은 한국 시간, 일봉 이상은 거래일 0시 */
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface Quote {
  price: number | null;
  chg: number | null; // 등락률 %
  vol?: number | null; // 거래대금 (원·USD·USDT)
  cap?: number | null; // 시가총액
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null; // 등락 기준가 (전일 종가 · 바이낸스는 24시간 전)
  accVol?: number | null; // 누적 거래량
  accVal?: number | null; // 오늘 누적 거래대금 (업비트: 09:00 KST 에 0으로) — 실시간 급등 감지가 몇 분 사이 거래대금을 잴 때 쓴다
  status?: string; // 네이버 장 상태 OPEN/CLOSE
  ts: number;
  live: boolean; // false 면 GitHub Actions 가 10분마다 만든 지연 시세
  prev?: number | null; // 직전 가격 (깜빡임용)
}

export interface BookLevel { p: number; q: number }
export interface Book {
  asks: BookLevel[]; // 낮은 가격(최우선 매도)부터
  bids: BookLevel[]; // 높은 가격(최우선 매수)부터
  totalAsk: number | null;
  totalBid: number | null;
  prevClose: number | null | undefined;
  ts: number;
}
export type BookState = Book | { unsupported: string } | { error: string };

export interface NameInfo { name: string; sub: string; ex?: string; warn?: boolean; en?: string }

export interface SearchItem { sym: Sym; market: Market; name: string; sub: string; ex?: string }

export interface NewsItem {
  id?: string; // 코인니스: 글 번호 · 네이버 해외 속보: oid-aid (AI 판단을 붙이는 열쇠)
  title: string; src: string; url: string; ts: number; summary?: string;
  bull?: number | null; bear?: number | null; important?: boolean; // 코인니스 속보: 호재·악재 투표, 중요 표시
  codes?: string[]; // 코인니스가 붙인 관련 코인 티커 (BTC, ETH …)
  rel?: { sym: string; name: string }[]; // 네이버가 붙인 관련 종목
  // 거래소 공지(notice) · 코인 SNS(social) — collector/coin_social.py
  rule?: { s: -2 | -1 | 0 | 1 | 2; r: string }; // 규칙 1차 판단 (AI 판단이 없을 때 쓴다)
  caution?: 'listing' | 'delist' | 'warning'; // 상장(과거엔 직후 하락 잦음) · 거래지원 종료 · 유의/경고
  cat?: string; // 거래소 분류
  ch?: string; verified?: boolean; via?: string; // SNS: 채널 @아이디 · 텔레그램 인증 · 다른 곳 글을 옮긴 경우 (예: X)
}
/** AI 호재·악재 판단 — s: 2 미친 호재 · 1 호재 · 0 중립 · -1 악재 · -2 미친 악재, r: 이유, t: 관련 티커·종목 이름 */
export interface AiTag { s: -2 | -1 | 0 | 1 | 2; r: string; t: string[]; at?: number }
/** data/news_ai.json — tags 의 키는 '<주제>:<기사 id>' (예: coinflash:1172242), null 은 판단 실패 */
export interface NewsAi { updatedAt: string; model?: string; usage?: { day: string; neurons: number }; tags: Record<string, AiTag | null>; error?: string }

export interface ScreenerRow {
  sym: Sym; name: string; sub: string; ex?: string | null;
  price: number | null; chg: number | null; vol: number | null; cap: number | null;
  rsi: number | null; volRatio: number | null; sig: string[]; op: string; score: number;
  /** 전략 탭 판정 (collector/setups.py) — 켜진 것만 점수 순: k 키, s 0~100, r 근거 */
  setups?: { k: string; s: number; r: string[] }[];
}
export interface ScreenerData { market: Market; updatedAt: string; count: number; fails: number; rows: ScreenerRow[] }

export interface OverviewItem { id: string; label: string; price: number | null; chg: number | null; status?: string }
/** data/stock_ai.json — 시장별 주요 종목의 AI 해설 (하루 2번 정도) · s: -2 매우 약함 … 2 매우 강함 */
export interface StockAiItem { x: string; s: -2 | -1 | 0 | 1 | 2; at: number }
export interface StockAi { updatedAt: string; model?: string; usage?: { day: string; neurons: number }; items: Record<string, StockAiItem>; error?: string }
