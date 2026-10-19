// 캔들 — 시장·주기별 출처
//  업비트: 중계 우선(제한 없음), 없으면 직접(브라우저 요청은 IP당 10초 1번 → 간격 두고 세 번까지)
//  바이낸스: 직접 / 국내·미국 일봉 이상: 네이버(중계) → 실패하거나 중계가 없으면 GitHub Actions 가 저장한 일봉
//  국내 분봉: 네이버(중계) / 미국 분봉: 야후(중계, 3분봉은 1분봉을 합침)
import { dedupe, getJSON, groupBars, NeedRelay, sleep, split, wallTs, ymdTs } from './core';
import { nameOf } from './names';
import { Relay } from './relay';
import { staticJSON } from './staticData';
import type { Candle, Interval, Sym } from './types';

export const INTERVALS: Record<'coin' | 'stock', Interval[]> = {
  coin: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'],
  stock: ['1m', '3m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'],
};
export const IV_SEC: Partial<Record<Interval, number>> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
export const DAILY = new Set<Interval>(['1d', '1w', '1M']);
export const IV_LABEL: Record<Interval, string> = { '1m': '1분', '3m': '3분', '5m': '5분', '15m': '15분', '30m': '30분', '1h': '1시간', '4h': '4시간', '1d': '일', '1w': '주', '1M': '월' };
export const IV_UNIT: Partial<Record<Interval, string>> = { '1d': '일', '1w': '주', '1M': '개월' };

const UPBIT_PATH: Record<Interval, string> = {
  '1m': 'minutes/1', '3m': 'minutes/3', '5m': 'minutes/5', '15m': 'minutes/15', '30m': 'minutes/30',
  '1h': 'minutes/60', '4h': 'minutes/240', '1d': 'days', '1w': 'weeks', '1M': 'months',
};
const UPBIT_BLOCKED = '업비트가 잠시 요청을 막았습니다 — 같은 인터넷에서 여러 기기·탭으로 열면 생길 수 있어요. 잠시 뒤 다시 시도해 주세요.';
const upbitGate = { next: 0 };
type OnWait = (sec: number) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upbitGet(path: string, onWait?: OnWait): Promise<any> {
  if (Relay.ok()) {
    try { return await Relay.json('upbit', path); } catch (e) { const s = (e as { status?: number }).status; if (s !== 429 && s !== 502) throw e; }
  }
  for (let attempt = 0; ; attempt++) {
    const now = Date.now(), at = Math.max(now, upbitGate.next);
    upbitGate.next = at + 10500;
    if (at > now) { onWait?.(Math.ceil((at - now) / 1000)); await sleep(at - now); }
    try {
      return await getJSON('https://api.upbit.com/v1/' + path);
    } catch (e) {
      // 제한에 걸리면 업비트가 CORS 헤더 없는 429 를 돌려줘서 브라우저에선 TypeError 로 보인다
      const s = (e as { status?: number }).status;
      if (s && s !== 429) throw e;
      if (attempt >= 2) throw new Error(UPBIT_BLOCKED);
    }
  }
}
interface UpbitCandle { candle_date_time_kst: string; candle_date_time_utc: string; opening_price: number; high_price: number; low_price: number; trade_price: number; candle_acc_trade_volume: number }
async function upbitCandles(code: string, iv: Interval, onWait?: OnWait): Promise<Candle[]> {
  const pages = Relay.ok() ? 2 : 1;
  let raw: UpbitCandle[] = [];
  let to: string | null = null;
  for (let p = 0; p < pages; p++) {
    const page: UpbitCandle[] = await upbitGet(`candles/${UPBIT_PATH[iv]}?market=${code}&count=200${to ? '&to=' + encodeURIComponent(to) : ''}`, onWait);
    raw = raw.concat(page);
    if (page.length < 200) break;
    to = page[page.length - 1].candle_date_time_utc.replace('T', ' ');
  }
  const daily = DAILY.has(iv);
  return dedupe(raw.map((d) => ({
    t: wallTs(daily ? d.candle_date_time_kst.slice(0, 10) : d.candle_date_time_kst),
    o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.candle_acc_trade_volume,
  })));
}
async function binanceCandles(code: string, iv: Interval): Promise<Candle[]> {
  const d = await getJSON<string[][]>(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(code)}&interval=${iv}&limit=500`);
  const shift = DAILY.has(iv) ? 0 : 9 * 3600; // 분봉은 한국 시간으로
  return d.map((k) => ({ t: +k[0] / 1000 + shift, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
// 네이버 분봉은 최근 8거래일 정도까지만 준다
const NAVER_PERIOD: Partial<Record<Interval, string>> = { '1m': 'minute', '3m': 'minute3', '5m': 'minute5', '15m': 'minute15', '30m': 'minute30', '1h': 'minute60', '1d': 'day', '1w': 'week', '1M': 'month' };
const NAVER_DAYS: Partial<Record<Interval, number>> = { '1m': 4, '3m': 10, '5m': 14, '15m': 20, '30m': 30, '1h': 40, '1d': 620, '1w': 2900, '1M': 12500 };
interface NaverCandle { localDateTime?: string; localDate?: string; closePrice?: number; currentPrice?: number; openPrice: number; highPrice: number; lowPrice: number; accumulatedTradingVolume?: number }
async function naverCandles(market: 'krx' | 'us', code: string, iv: Interval): Promise<Candle[]> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '') + '0000';
  const now = Date.now();
  const d = await Relay.json<NaverCandle[]>('naver-api', `chart/${market === 'krx' ? 'domestic' : 'foreign'}/item/${code}/${NAVER_PERIOD[iv]}`, {
    startDateTime: ymd(new Date(now - (NAVER_DAYS[iv] || 620) * 864e5)), endDateTime: ymd(new Date(now + 2 * 864e5)),
  });
  return dedupe(d.map((x) => {
    const c = (x.closePrice ?? x.currentPrice) as number;
    return { t: ymdTs((x.localDateTime || x.localDate) as string), o: x.openPrice || c, h: x.highPrice || c, l: x.lowPrice || c, c, v: x.accumulatedTradingVolume || 0 };
  })).slice(-500);
}
// 미국 주식 분봉 — 야후엔 3분봉이 없어 1분봉을 합친다
const YAHOO_IV: Partial<Record<Interval, [string, string]>> = { '1m': ['2d', '1m'], '3m': ['5d', '1m'], '5m': ['5d', '5m'], '15m': ['1mo', '15m'], '30m': ['1mo', '30m'], '1h': ['6mo', '60m'] };
async function yahooCandles(sym: Sym, iv: Interval): Promise<Candle[]> {
  const ticker = nameOf(sym).sub.replace(/\./g, '-');
  const [range, interval] = YAHOO_IV[iv]!;
  const d = await Relay.json('yahoo', encodeURIComponent(ticker), { range, interval });
  const r = d.chart.result[0], q = r.indicators.quote[0];
  const out: Candle[] = [];
  (r.timestamp || []).forEach((ts: number, i: number) => {
    if (q.open[i] == null || q.close[i] == null) return;
    out.push({ t: ts + 9 * 3600, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  const bars = dedupe(out);
  return iv === '3m' ? groupBars(bars, (t) => Math.floor(t / 180) * 180) : bars;
}
/** GitHub Actions 가 스크리너를 계산하며 남긴 일봉 (collector/collect.py 의 candle_path 와 같은 규칙) */
export const safeCode = (code: string) => code.replace(/[^A-Za-z0-9._-]/g, '_');
async function staticCandles(sym: Sym): Promise<Candle[]> {
  const [market, code] = split(sym);
  const d = await staticJSON<{ c: number[][] }>(`candles/${market}/${safeCode(code)}.json`, 5 * 60e3);
  return d.c.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}
/** 일봉 → 주봉(월요일 시작) · 월봉 */
function aggregate(daily: Candle[], iv: Interval): Candle[] {
  if (iv === '1d') return daily;
  return groupBars(daily, (t) => {
    const d = new Date(t * 1000);
    return iv === '1w' ? t - ((d.getUTCDay() + 6) % 7) * 86400 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  });
}

/** onWait(초): 업비트 제한으로 기다릴 때 화면에 알려 주는 콜백 */
export async function candles(sym: Sym, iv: Interval, onWait?: OnWait): Promise<Candle[]> {
  const [market, code] = split(sym);
  if (market === 'binance') return binanceCandles(code, iv);
  if (Relay.ok()) {
    try {
      if (market === 'upbit') return await upbitCandles(code, iv, onWait);
      if (market === 'us' && !DAILY.has(iv)) return await yahooCandles(sym, iv);
      return await naverCandles(market, code, iv);
    } catch (e) {
      if (!DAILY.has(iv)) throw e; // 일봉 이상은 아래 저장된 일봉으로 대신
    }
  }
  if (DAILY.has(iv)) {
    try {
      return aggregate(await staticCandles(sym), iv);
    } catch (e) {
      if (market !== 'upbit') throw (e as { status?: number }).status === 404 ? new Error('이 종목은 저장된 일봉이 없습니다 — 실시간 중계(Worker)를 연결하면 볼 수 있습니다') : e;
    }
  }
  if (market === 'upbit') return upbitCandles(code, iv, onWait);
  throw new NeedRelay();
}
