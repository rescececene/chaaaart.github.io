// 실시간 연결 — 화면들이 want() 로 요청한 종목만 받는다
//  - 업비트: 웹소켓 하나로 시세(ticker)·호가(orderbook) (브라우저 REST 는 IP당 10초 1번 제한이라)
//  - 바이낸스: 웹소켓 종목별 24시간 미니 티커 + 호가 20단계 스트림
//  - 주식: 중계(Worker)로 네이버 실시간 시세를 2.5초마다, 없으면 10분 단위 정적 데이터
import { isIdle, onWake } from './activity';
import { getJSON, num, split, upbitSlot } from './core';
import { binanceTop, remember, upbitCodes } from './names';
import { getQuote, hasQuote, onWantsChange, putQuote, wanted } from './quotes';
import { Relay } from './relay';
import { staticJSON } from './staticData';
import type { BookLevel, BookState, Sym } from './types';

// ── 중계 아끼기 ── Cloudflare 무료 플랜은 계정 전체 하루 10만 건 (넘으면 UTC 0시 = 오전 9시까지 중계가 멈춘다)
// 실시간이 필요 없을 때는 천천히 부른다 (화면이 숨겨지면 아예 멈춘다)
const STOCK_POLL_MS = 2500; // 보고 있는 종목
const LIST_MS = 5000; // 시장 전체 목록 (최대 400종목 · 4페이지)
const BOOK_MS = 1500; // 국내 호가
const SLOW_MS = 30e3; // 장이 닫혔거나 · 15분 넘게 조작이 없거나 · 이 기기가 오늘 너무 많이 불렀을 때
/** 절약 모드 — 오래 조작이 없거나 오늘 중계를 너무 많이 불렀으면 주식 시세·호가를 30초마다 */
export const relaySaving = () => isIdle() || Relay.overBudget();
/** 이 종목들이 모두 장 마감 상태인가 (네이버 marketStatus) */
function allClosed(syms: Iterable<Sym>) {
  let any = false;
  for (const s of syms) {
    const st = getQuote(s)?.status;
    if (!st) continue;
    if (st !== 'CLOSE') return false;
    any = true;
  }
  return any;
}

// ── 호가 구독 ──────────────────────────────────────────
const bookWatchers = new Map<Sym, Set<(b: BookState) => void>>();
const bookLast = new Map<Sym, BookState>();
const bookTimers = new Map<Sym, ReturnType<typeof setTimeout>>();
function emitBook(sym: Sym, book: BookState) {
  if (!bookWatchers.has(sym)) return;
  bookLast.set(sym, book);
  if (bookTimers.has(sym)) return;
  // 초당 수십 번 와도 화면엔 최대 초당 ~8번
  bookTimers.set(sym, setTimeout(() => {
    bookTimers.delete(sym);
    const b = bookLast.get(sym);
    if (b) for (const cb of bookWatchers.get(sym) || []) { try { cb(b); } catch (e) { console.error(e); } }
  }, 120));
}
const sumQ = (lv: BookLevel[]) => lv.reduce((s, x) => s + x.q, 0);

// ── 업비트 ─────────────────────────────────────────────
interface UpbitMsg {
  ty?: string; type?: string; cd?: string; code?: string; error?: unknown;
  tp?: number; trade_price?: number; scr?: number; signed_change_rate?: number; atp24h?: number; acc_trade_price_24h?: number;
  op?: number; opening_price?: number; hp?: number; high_price?: number; lp?: number; low_price?: number;
  pcp?: number; prev_closing_price?: number; atv?: number; acc_trade_volume?: number; atp?: number; acc_trade_price?: number;
  obu?: { ap: number; bp: number; as: number; bs: number }[];
  orderbook_units?: { ask_price: number; bid_price: number; ask_size: number; bid_size: number }[];
  tas?: number; total_ask_size?: number; tbs?: number; total_bid_size?: number;
}
const UpbitLive = {
  ws: null as WebSocket | null,
  key: '', codes: [] as string[], books: [] as string[], lastOpen: 0, timer: null as ReturnType<typeof setTimeout> | null,
  dec: new TextDecoder(),
  sync() {
    const w = wanted('upbit');
    const codes = (w.has('upbit:*') ? upbitCodes() : [...w].map((s) => split(s)[1])).filter(Boolean).sort();
    const books = [...bookWatchers.keys()].filter((s) => s.startsWith('upbit:')).map((s) => split(s)[1]).sort();
    const key = codes.join(',') + '|' + books.join(',');
    if (key === this.key && (this.ws || (!codes.length && !books.length))) return;
    this.key = key; this.codes = codes; this.books = books;
    if (!codes.length && !books.length) return this.close();
    if (this.ws && this.ws.readyState === 1) this.send();
    else this.open();
  },
  open() {
    if (this.ws || this.timer) return;
    // 업비트는 브라우저 접속을 10초 간격으로 제한 — REST(시간봉 등)와 같은 차례 줄을 쓴다
    const wait = upbitSlot(Math.max(0, this.lastOpen + 11000 - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.codes.length && !this.books.length) return;
      this.lastOpen = Date.now();
      const ws = new WebSocket('wss://api.upbit.com/websocket/v1');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => this.send();
      ws.onmessage = (e) => this.onMsg(e.data);
      ws.onerror = () => ws.close();
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (this.codes.length || this.books.length) this.open(); } };
      this.ws = ws;
    }, wait);
  },
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
  },
  send() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const req: object[] = [{ ticket: 'ml-' + Date.now() }];
    if (this.codes.length) req.push({ type: 'ticker', codes: this.codes });
    if (this.books.length) req.push({ type: 'orderbook', codes: this.books });
    req.push({ format: 'SIMPLE' });
    this.ws.send(JSON.stringify(req));
  },
  onMsg(data: string | ArrayBuffer) {
    let d: UpbitMsg;
    try { d = JSON.parse(typeof data === 'string' ? data : this.dec.decode(data)); } catch { return; }
    const code = d.cd || d.code;
    if (!code || d.error) return;
    const sym = 'upbit:' + code;
    if ((d.ty || d.type) === 'orderbook') {
      const units = d.obu ? d.obu.map((u) => ({ ap: u.ap, bp: u.bp, as: u.as, bs: u.bs }))
        : (d.orderbook_units || []).map((u) => ({ ap: u.ask_price, bp: u.bid_price, as: u.ask_size, bs: u.bid_size }));
      emitBook(sym, {
        asks: units.map((u) => ({ p: u.ap, q: u.as })), bids: units.map((u) => ({ p: u.bp, q: u.bs })),
        totalAsk: d.tas ?? d.total_ask_size ?? null, totalBid: d.tbs ?? d.total_bid_size ?? null,
        prevClose: getQuote(sym)?.prevClose, ts: Date.now(),
      });
      return;
    }
    putQuote(sym, {
      price: d.tp ?? d.trade_price ?? null, chg: ((d.scr ?? d.signed_change_rate) ?? 0) * 100, vol: d.atp24h ?? d.acc_trade_price_24h,
      open: d.op ?? d.opening_price, high: d.hp ?? d.high_price, low: d.lp ?? d.low_price,
      prevClose: d.pcp ?? d.prev_closing_price, accVol: d.atv ?? d.acc_trade_volume, accVal: d.atp ?? d.acc_trade_price, ts: Date.now(), live: true,
    });
  },
};

// ── 바이낸스 ───────────────────────────────────────────
interface MiniTicker { e?: string; s: string; c: string; o: string; h: string; l: string; q: string }
const BinanceLive = {
  ws: null as WebSocket | null, streams: new Set<string>(), id: 1, timer: null as ReturnType<typeof setTimeout> | null,
  sync() {
    const w = wanted('binance');
    const syms = w.has('binance:*') ? binanceTop() : [...w].map((s) => split(s)[1]);
    const next = new Set(syms.filter(Boolean).map((s) => s.toLowerCase() + '@miniTicker'));
    if (!next.size) { this.streams = next; return this.close(); }
    if (!this.ws) { this.streams = next; return this.open(); }
    if (this.ws.readyState === 1) {
      const add = [...next].filter((s) => !this.streams.has(s));
      const del = [...this.streams].filter((s) => !next.has(s));
      if (del.length) this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: del, id: this.id++ }));
      if (add.length) this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add, id: this.id++ }));
    }
    this.streams = next;
    const missing = syms.filter((s) => !hasQuote('binance:' + s));
    if (missing.length) binanceRest(missing).catch(() => {});
  },
  open() {
    if (this.timer) return;
    const ws = new WebSocket('wss://stream.binance.com:9443/ws');
    ws.onopen = () => ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [...this.streams], id: this.id++ }));
    ws.onmessage = (e) => {
      let d: MiniTicker | MiniTicker[];
      try { d = JSON.parse(e.data); } catch { return; }
      if (Array.isArray(d)) d.forEach((x) => this.put(x));
      else if (d.e === '24hrMiniTicker') this.put(d);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.streams.size) this.timer = setTimeout(() => { this.timer = null; this.open(); }, 5000);
    };
    this.ws = ws;
    const syms = [...this.streams].map((s) => s.split('@')[0].toUpperCase());
    const missing = syms.filter((s) => !hasQuote('binance:' + s));
    if (missing.length) binanceRest(missing).catch(() => {});
  },
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
  },
  put(x: MiniTicker) {
    const c = +x.c, o = +x.o; // 바이낸스 등락은 24시간 전 가격 기준
    putQuote('binance:' + x.s, { price: c, chg: o ? (c / o - 1) * 100 : 0, vol: +x.q, high: +x.h, low: +x.l, open: o, prevClose: o, ts: Date.now(), live: true });
  },
};
async function binanceRest(syms: string[]) {
  for (let i = 0; i < syms.length; i += 100) {
    const part = syms.slice(i, i + 100);
    const d = await getJSON<{ symbol: string; lastPrice: string; openPrice: string; quoteVolume: string; highPrice: string; lowPrice: string }[]>(
      'https://api.binance.com/api/v3/ticker/24hr?type=MINI&symbols=' + encodeURIComponent(JSON.stringify(part)));
    for (const x of d) {
      const c = +x.lastPrice, o = +x.openPrice;
      if (!hasQuote('binance:' + x.symbol)) {
        putQuote('binance:' + x.symbol, { price: c, chg: o ? (c / o - 1) * 100 : 0, vol: +x.quoteVolume, high: +x.highPrice, low: +x.lowPrice, open: o, prevClose: o, ts: Date.now(), live: true });
      }
    }
  }
}

// ── 주식 (네이버) ──────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NaverStock = Record<string, any>;
function naverChg(s: NaverStock): number {
  let v = num(s.fluctuationsRatioRaw ?? s.fluctuationsRatio) || 0;
  const code = s.compareToPreviousPrice && s.compareToPreviousPrice.code;
  if ((code === '4' || code === '5') && v > 0) v = -v; // 하락인데 부호가 빠진 경우
  return v;
}
export { naverChg };
function putNaver(market: 'krx' | 'us', s: NaverStock, ex?: string): Sym {
  const sym = market === 'krx' ? 'krx:' + s.itemCode : 'us:' + s.reutersCode;
  const exName = ex || (s.stockExchangeType && s.stockExchangeType.name);
  remember(sym, { name: s.stockName, sub: market === 'krx' ? s.itemCode : s.symbolCode, ex: exName });
  const price = num(s.closePriceRaw ?? s.closePrice), chg = naverChg(s);
  putQuote(sym, {
    price, chg, prevClose: price != null ? price / (1 + chg / 100) : null, vol: num(s.accumulatedTradingValueRaw),
    cap: num(s.marketValueRaw ?? s.marketValueFullRaw), open: num(s.openPriceRaw), high: num(s.highPriceRaw), low: num(s.lowPriceRaw),
    accVol: num(s.accumulatedTradingVolumeRaw), status: s.marketStatus, ts: Date.now(), live: true,
  });
  return sym;
}
const LISTS: Record<'krx' | 'us', [string, number][]> = { krx: [['KOSPI', 2], ['KOSDAQ', 2]], us: [['NASDAQ', 2], ['NYSE', 1]] };
/** 목록 화면 기본 순서 (시가총액 순) */
export const listOrder: Record<'krx' | 'us', Sym[]> = { krx: [], us: [] };
async function loadList(market: 'krx' | 'us') {
  const jobs: Promise<Sym[]>[] = [];
  for (const [cat, pages] of LISTS[market]) {
    for (let p = 1; p <= pages; p++) {
      const req = market === 'krx'
        ? Relay.json('naver-m', `stocks/marketValue/${cat}`, { page: p, pageSize: 100 })
        : Relay.json('naver-api', `stock/exchange/${cat}/marketValue`, { page: p, pageSize: 100 });
      jobs.push(req.then((d: { stocks?: NaverStock[] }) => (d.stocks || []).filter((s) => !s.stockEndType || s.stockEndType === 'stock').map((s) => putNaver(market, s, cat))));
    }
  }
  const res = await Promise.allSettled(jobs);
  const syms = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (syms.length) listOrder[market] = syms;
  if (res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
}
export async function loadStaticStocks() {
  for (const market of ['krx', 'us'] as const) {
    try {
      const d = await staticJSON<{ updatedAt: string; rows: { sym: Sym; name: string; sub: string; ex?: string; price: number; chg: number; vol: number; cap: number }[] }>(market + '.json', 5 * 60e3);
      if (!listOrder[market].length) listOrder[market] = d.rows.map((r) => r.sym);
      for (const r of d.rows) {
        remember(r.sym, { name: r.name, sub: r.sub, ex: r.ex });
        const q = getQuote(r.sym);
        if (!q || !q.live) putQuote(r.sym, { price: r.price, chg: r.chg, vol: r.vol, cap: r.cap, prevClose: r.price / (1 + r.chg / 100), ts: Date.parse(d.updatedAt), live: false });
      }
    } catch { /* 아직 데이터 없음 */ }
  }
}
const stockErrListeners = new Set<() => void>();
export const onStockError = (fn: () => void) => { stockErrListeners.add(fn); return () => { stockErrListeners.delete(fn); }; };
const StockLive = {
  timer: null as ReturnType<typeof setTimeout> | null, running: false, busy: false, lastError: null as Error | null,
  last: {} as Record<string, number>, // 마지막으로 부른 시각 — krx · us · krxList · usList
  setError(e: Error | null) { if (e?.message !== this.lastError?.message) { this.lastError = e; stockErrListeners.forEach((fn) => fn()); } },
  kick() { if (!this.running) void this.loop(); },
  /** force: 간격을 무시하고 지금 받는다 (화면으로 돌아왔을 때 등) */
  async loop(force = false) {
    if (this.busy) return; // 받는 중이면 그게 곧 새 시세
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const wk = wanted('krx'), wu = wanted('us');
    if (!wk.size && !wu.size) { this.running = false; return; }
    this.running = true;
    this.busy = true;
    try {
      if (!document.hidden) {
        try {
          if (Relay.ok()) await this.poll(wk, wu, force);
          else await loadStaticStocks();
          this.setError(null);
        } catch (e) {
          this.setError(e as Error);
          await loadStaticStocks();
        }
      }
    } finally {
      this.busy = false;
    }
    this.timer = setTimeout(() => void this.loop(), Relay.ok() ? STOCK_POLL_MS : 60e3);
  },
  /** 시장마다 간격이 된 것만 부른다 — 목록 5초, 종목 2.5초, 장 마감·절약 모드면 30초 */
  async poll(wk: Set<Sym>, wu: Set<Sym>, force: boolean) {
    const now = Date.now(), saving = relaySaving();
    const due = (key: string, gap: number) => force || now - (this.last[key] || 0) >= gap - 200;
    const jobs: Promise<unknown>[] = [];
    for (const [market, w] of [['krx', wk], ['us', wu]] as const) {
      if (w.has(market + ':*')) {
        const list = listOrder[market];
        const gap = saving || allClosed(list) ? SLOW_MS : LIST_MS;
        if (!list.length || due(market + 'List', gap)) { this.last[market + 'List'] = now; jobs.push(loadList(market)); }
      }
      const syms = [...w].filter((s) => !s.endsWith('*'));
      if (!syms.length) continue;
      const gap = saving || allClosed(syms) ? SLOW_MS : STOCK_POLL_MS;
      // 아직 실시간 시세가 없는 종목이 있으면 (방금 연 화면) 기다리지 않는다
      if (!due(market, gap) && syms.every((s) => getQuote(s)?.live)) continue;
      this.last[market] = now;
      const codes = syms.map((s) => split(s)[1]);
      const path = market === 'krx' ? 'domestic/stock/' : 'worldstock/stock/';
      for (let i = 0; i < codes.length; i += 20) {
        jobs.push(Relay.json('naver-poll', path + codes.slice(i, i + 20).join(',')).then((d: { datas?: NaverStock[] }) => (d.datas || []).forEach((s) => putNaver(market, s))));
      }
    }
    if (!jobs.length) return;
    const res = await Promise.allSettled(jobs);
    const bad = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (bad.length && bad.length === res.length) throw bad[0].reason;
  },
};
export const stockError = () => StockLive.lastError;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden && StockLive.running) void StockLive.loop(true); });
}

// ── 바이낸스·국내 호가 ─────────────────────────────────
const BinanceBook = { // 종목별 20단계 호가 스트림 (0.1초마다)
  sockets: new Map<string, WebSocket>(),
  open(code: string) {
    if (this.sockets.has(code)) return;
    const sym = 'binance:' + code;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${code.toLowerCase()}@depth20@100ms`);
    this.sockets.set(code, ws);
    ws.onmessage = (e) => {
      let d: { asks?: [string, string][]; bids?: [string, string][] };
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d.asks || !d.bids) return;
      const asks = d.asks.map(([p, q]) => ({ p: +p, q: +q })), bids = d.bids.map(([p, q]) => ({ p: +p, q: +q }));
      emitBook(sym, { asks, bids, totalAsk: sumQ(asks), totalBid: sumQ(bids), prevClose: getQuote(sym)?.prevClose, ts: Date.now() });
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.sockets.get(code) !== ws) return;
      this.sockets.delete(code);
      if (bookWatchers.has(sym)) setTimeout(() => { if (bookWatchers.has(sym)) this.open(code); }, 3000);
    };
  },
  close(code: string) { const ws = this.sockets.get(code); this.sockets.delete(code); if (ws) ws.close(); },
};
const KrxBook = { // 네이버 5단계 호가를 중계로 1.5초마다 (장 마감·절약 모드면 30초)
  timers: new Map<string, ReturnType<typeof setTimeout>>(),
  gens: new Map<string, number>(), // 다시 시작하면 이전 루프는 멈춘다
  start(code: string) {
    if (this.timers.has(code)) return;
    const sym = 'krx:' + code;
    const gen = (this.gens.get(code) || 0) + 1;
    this.gens.set(code, gen);
    const tick = async () => {
      if (this.gens.get(code) !== gen) return;
      if (!bookWatchers.has(sym)) { this.timers.delete(code); return; }
      if (!Relay.ok()) emitBook(sym, { error: '국내 주식 호가는 실시간 중계가 연결돼야 보입니다' });
      else if (!document.hidden) {
        try {
          const d = await Relay.json('naver-m', `stock/${code}/askingPrice`);
          const lv = (x: { price: string; count: string }) => ({ p: num(x.price) || 0, q: num(x.count) || 0 });
          const asks = ((d.sellInfo || []) as { price: string; count: string }[]).map(lv).filter((x) => x.p > 0).sort((a, b) => a.p - b.p);
          const bids = ((d.buyInfos || d.buyInfo || []) as { price: string; count: string }[]).map(lv).filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
          emitBook(sym, { asks, bids, totalAsk: num(d.totalSell), totalBid: num(d.totalBuy), prevClose: num(d.lastClosePrice), ts: Date.now() });
        } catch {
          emitBook(sym, { error: '호가를 불러오지 못했습니다' });
        }
      }
      if (this.gens.get(code) !== gen) return;
      const gap = relaySaving() || getQuote(sym)?.status === 'CLOSE' ? SLOW_MS : BOOK_MS; // 닫힌 장의 호가는 바뀌지 않는다
      if (bookWatchers.has(sym)) this.timers.set(code, setTimeout(tick, gap)); else this.timers.delete(code);
    };
    this.timers.set(code, setTimeout(tick, 0));
  },
  stop(code: string) { clearTimeout(this.timers.get(code)); this.timers.delete(code); this.gens.set(code, (this.gens.get(code) || 0) + 1); },
  /** 조작이 없다가 다시 움직이면 바로 한 번 받는다 */
  wake() { for (const code of Array.from(this.timers.keys())) { this.stop(code); this.start(code); } }, // 도는 중에 Map 을 바꾸므로 복사본으로
};

/** 호가 구독 → 해제 함수. cb 는 최대 초당 ~8번 */
export function watchBook(sym: Sym, cb: (b: BookState) => void): () => void {
  const [market, code] = split(sym);
  if (!bookWatchers.has(sym)) bookWatchers.set(sym, new Set());
  bookWatchers.get(sym)!.add(cb);
  const last = bookLast.get(sym);
  if (last) cb(last);
  if (market === 'upbit') UpbitLive.sync();
  else if (market === 'binance') BinanceBook.open(code);
  else if (market === 'krx') KrxBook.start(code);
  else cb({ unsupported: '미국 주식은 무료로 받을 수 있는 실시간 호가가 없어요' });
  return () => {
    const set = bookWatchers.get(sym);
    if (!set) return;
    set.delete(cb);
    if (set.size) return;
    bookWatchers.delete(sym);
    bookLast.delete(sym);
    clearTimeout(bookTimers.get(sym));
    bookTimers.delete(sym);
    if (market === 'upbit') UpbitLive.sync();
    else if (market === 'binance') BinanceBook.close(code);
    else if (market === 'krx') KrxBook.stop(code);
  };
}

onWantsChange(() => { UpbitLive.sync(); BinanceLive.sync(); StockLive.kick(); });
Relay.subscribe(() => { if (StockLive.running) void StockLive.loop(true); });
onWake(() => { if (StockLive.running) void StockLive.loop(true); KrxBook.wake(); });
