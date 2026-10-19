// 데이터 계층
//  - 코인: 업비트·바이낸스에서 직접 (시세는 WebSocket 실시간)
//  - 주식: Cloudflare Worker(중계)를 거쳐 네이버 증권 실시간 시세를 5초마다
//  - 중계가 없으면 주식은 GitHub Actions 가 10분마다 만드는 data/*.json 으로 대신한다
(function (root) {
  'use strict';

  const MARKETS = {
    upbit: { name: '업비트', ccy: 'KRW', coin: true },
    binance: { name: '바이낸스', ccy: 'USDT', coin: true },
    krx: { name: '국내주식', ccy: 'KRW' },
    us: { name: '미국주식', ccy: 'USD' },
  };
  const INTERVALS = {
    coin: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'],
    stock: ['1m', '3m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'],
  };
  const IV_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const DAILY = new Set(['1d', '1w', '1M']);
  const STOCK_POLL_MS = 5000;

  // localStorage — 사생활 보호 모드처럼 저장이 막혀도 앱은 돌아가야 한다
  const Store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 */ } },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const split = (sym) => { const i = sym.indexOf(':'); return [sym.slice(0, i), sym.slice(i + 1)]; };
  const marketOf = (sym) => split(sym)[0];
  const num = (s) => { if (s == null || s === '') return null; const v = typeof s === 'number' ? s : parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

  class HttpError extends Error {
    constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status; }
  }
  class NeedRelay extends Error {
    constructor() { super('주식 실시간 데이터는 중계(Worker) 연결이 필요합니다'); this.needRelay = true; }
  }
  async function fetchOk(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      let msg;
      try { msg = (await r.json()).error; } catch { /* 본문 없음 */ }
      throw new HttpError(r.status, msg);
    }
    return r;
  }
  const getJSON = async (url) => (await fetchOk(url)).json();
  const getText = async (url) => (await fetchOk(url)).text();

  // ── 중계(Cloudflare Worker) ───────────────────────────
  const Relay = {
    cfg() { return Store.get('ml.relay', null); },
    save(cfg) {
      Store.set('ml.relay', cfg && cfg.url ? { url: cfg.url.trim().replace(/\/+$/, ''), key: (cfg.key || '').trim() } : null);
    },
    ok() { const c = this.cfg(); return !!(c && c.url); },
    url(route, path = '', params = null) {
      const c = this.cfg();
      const q = new URLSearchParams(params || {});
      if (c.key) q.set('k', c.key);
      const qs = q.toString();
      return `${c.url}/${route}${path ? '/' + path : ''}${qs ? '?' + qs : ''}`;
    },
    json(route, path, params) { return getJSON(this.url(route, path, params)); },
    text(route, path, params) { return getText(this.url(route, path, params)); },
    // 설정 화면의 [연결 확인] — 성공하면 저장, 실패하면 이전 설정으로 되돌린다
    async test(cfg) {
      const prev = this.cfg();
      this.save(cfg);
      try {
        const c = this.cfg();
        const head = await getJSON(`${c.url}/${c.key ? '?k=' + encodeURIComponent(c.key) : ''}`);
        if (!head.keyOk) throw new Error('접근 키가 맞지 않습니다');
        const d = await this.json('naver-poll', 'domestic/stock/005930');
        const s = d.datas && d.datas[0];
        if (!s) throw new Error('네이버 응답이 비어 있습니다');
        return { ok: true, msg: `연결됨 — ${s.stockName} ${s.closePrice}원 (실시간)` };
      } catch (e) {
        this.save(prev);
        return { ok: false, msg: e.status === 403 ? '네이버가 중계 서버를 막았습니다 (403)' : e.message || String(e) };
      }
    },
  };

  // ── GitHub Actions 가 만든 정적 데이터 ────────────────
  const memo = {};
  function staticJSON(name, maxAgeMs = 60000) {
    const m = memo[name];
    if (m && Date.now() - m.at < maxAgeMs) return m.p;
    const p = getJSON(`data/${name}?v=${Math.floor(Date.now() / 60000)}`).catch((e) => { delete memo[name]; throw e; });
    memo[name] = { at: Date.now(), p };
    return p;
  }

  // ── 종목 이름표 ───────────────────────────────────────
  const Names = new Map(); // sym → {name, sub, ex, warn}
  function remember(sym, o) {
    const cur = Names.get(sym) || {};
    for (const k in o) if (o[k] != null && o[k] !== '') cur[k] = o[k];
    Names.set(sym, cur);
  }
  function nameOf(sym) {
    const n = Names.get(sym) || {};
    const code = split(sym)[1];
    return { name: n.name || code, sub: n.sub || code, ex: n.ex, warn: n.warn };
  }

  let coinsData = null; // {upbit: {KRW-BTC: [이름, 영문, 유의]}, binance: [BTCUSDT, ...]}
  async function loadCoins() {
    if (coinsData) return coinsData;
    try {
      coinsData = await staticJSON('coins.json', 3600e3);
    } catch {
      coinsData = { upbit: {}, binance: [] };
    }
    const kr = {};
    for (const [code, [name, en, warn]] of Object.entries(coinsData.upbit || {})) {
      const base = code.slice(4);
      kr[base] = name;
      remember('upbit:' + code, { name, sub: base, en, warn: !!warn });
    }
    for (const s of coinsData.binance || []) {
      const base = s.replace(/USDT$/, '');
      remember('binance:' + s, { name: kr[base] || base, sub: base + '/USDT' });
    }
    // 업비트 웹소켓이 막혀 있어도 빈 화면이 되지 않도록 10분 단위 시세를 먼저 깔아 둔다
    staticJSON('screener/upbit.json', 5 * 60e3).then((d) => {
      const ts = Date.parse(d.updatedAt);
      for (const r of d.rows) if (!Quotes.has(r.sym)) putQuote(r.sym, { price: r.price, chg: r.chg, vol: r.vol, ts, live: false });
    }).catch(() => {});
    return coinsData;
  }
  const upbitCodes = () => Object.keys((coinsData && coinsData.upbit) || {});
  const binanceTop = () => (coinsData && coinsData.binance) || [];

  // ── 시세 저장소 + 변경 알림 ───────────────────────────
  const Quotes = new Map(); // sym → {price, chg, vol, cap, open, high, low, accVol, ts, live}
  const listeners = new Set();
  let pending = new Set(), flushTimer = null;
  function putQuote(sym, q) {
    const old = Quotes.get(sym);
    if (old) { q.prev = old.price; Object.assign(old, q); } else Quotes.set(sym, q);
    pending.add(sym);
    if (!flushTimer) flushTimer = setTimeout(flush, 300);
  }
  function flush() {
    flushTimer = null;
    const changed = pending;
    pending = new Set();
    for (const fn of listeners) { try { fn(changed); } catch (e) { console.error(e); } }
  }
  function onQuotes(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // 화면마다 "이 종목들 시세가 필요하다"를 등록 → 거래소별 구독을 합쳐서 관리
  // 'upbit:*' 처럼 * 는 그 시장 목록 전체
  const wants = new Map();
  function want(owner, syms) { wants.set(owner, new Set(syms)); scheduleSync(); }
  function unwant(owner) { if (wants.delete(owner)) scheduleSync(); }
  function wanted(market) {
    const out = new Set();
    for (const set of wants.values()) for (const s of set) if (s.startsWith(market + ':')) out.add(s);
    return out;
  }
  let syncTimer = null;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { UpbitLive.sync(); BinanceLive.sync(); StockLive.kick(); }, 150);
  }

  // ── 업비트 실시간 (WebSocket) ─────────────────────────
  // 브라우저발 요청은 업비트가 따로 제한하므로(분당 6회) 시세는 웹소켓 하나로 받는다
  const UpbitLive = {
    ws: null, codes: '', lastOpen: 0, timer: null, dec: new TextDecoder(),
    sync() {
      const w = wanted('upbit');
      const codes = (w.has('upbit:*') ? upbitCodes() : [...w].map((s) => split(s)[1])).filter(Boolean).sort();
      const key = codes.join(',');
      if (key === this.codes && (this.ws || !key)) return;
      this.codes = key;
      if (!key) return this.close();
      if (this.ws && this.ws.readyState === 1) this.send();
      else this.open();
    },
    open() {
      if (this.ws || this.timer) return;
      const wait = Math.max(0, this.lastOpen + 11000 - Date.now()); // 재접속은 11초 간격
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.codes) return;
        this.lastOpen = Date.now();
        const ws = new WebSocket('wss://api.upbit.com/websocket/v1');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => this.send();
        ws.onmessage = (e) => this.onMsg(e.data);
        ws.onerror = () => ws.close();
        ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (this.codes) this.open(); } };
        this.ws = ws;
      }, wait);
    },
    close() { clearTimeout(this.timer); this.timer = null; const ws = this.ws; this.ws = null; if (ws) ws.close(); },
    send() {
      if (!this.codes || !this.ws || this.ws.readyState !== 1) return;
      this.ws.send(JSON.stringify([{ ticket: 'ml-' + Date.now() }, { type: 'ticker', codes: this.codes.split(',') }, { format: 'SIMPLE' }]));
    },
    onMsg(data) {
      let d;
      try { d = JSON.parse(typeof data === 'string' ? data : this.dec.decode(data)); } catch { return; }
      const code = d.cd || d.code;
      if (!code || d.error) return;
      putQuote('upbit:' + code, {
        price: d.tp ?? d.trade_price, chg: (d.scr ?? d.signed_change_rate) * 100, vol: d.atp24h ?? d.acc_trade_price_24h,
        open: d.op ?? d.opening_price, high: d.hp ?? d.high_price, low: d.lp ?? d.low_price,
        accVol: d.atv ?? d.acc_trade_volume, ts: Date.now(), live: true,
      });
    },
  };

  // ── 바이낸스 실시간 (WebSocket, 종목별 24시간 미니 티커) ─
  const BinanceLive = {
    ws: null, streams: new Set(), id: 1, timer: null,
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
      // 웹소켓 첫 체결 전까지 비어 보이지 않도록 한 번에 받아 둔다
      const missing = syms.filter((s) => !Quotes.has('binance:' + s));
      if (missing.length) binanceRest(missing).catch(() => {});
    },
    open() {
      if (this.timer) return;
      const ws = new WebSocket('wss://stream.binance.com:9443/ws');
      ws.onopen = () => ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [...this.streams], id: this.id++ }));
      ws.onmessage = (e) => {
        let d;
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
      const missing = syms.filter((s) => !Quotes.has('binance:' + s));
      if (missing.length) binanceRest(missing).catch(() => {});
    },
    close() { clearTimeout(this.timer); this.timer = null; const ws = this.ws; this.ws = null; if (ws) ws.close(); },
    put(x) {
      const c = +x.c, o = +x.o;
      putQuote('binance:' + x.s, { price: c, chg: o ? (c / o - 1) * 100 : 0, vol: +x.q, high: +x.h, low: +x.l, open: o, ts: Date.now(), live: true });
    },
  };
  async function binanceRest(syms) {
    for (let i = 0; i < syms.length; i += 100) {
      const part = syms.slice(i, i + 100);
      const d = await getJSON('https://api.binance.com/api/v3/ticker/24hr?type=MINI&symbols=' + encodeURIComponent(JSON.stringify(part)));
      for (const x of d) {
        const c = +x.lastPrice, o = +x.openPrice;
        if (!Quotes.has('binance:' + x.symbol)) {
          putQuote('binance:' + x.symbol, { price: c, chg: o ? (c / o - 1) * 100 : 0, vol: +x.quoteVolume, high: +x.highPrice, low: +x.lowPrice, open: o, ts: Date.now(), live: true });
        }
      }
    }
  }

  // ── 주식 (중계 있으면 5초마다 네이버 실시간, 없으면 10분 단위 정적 데이터) ─
  function naverChg(s) {
    let v = num(s.fluctuationsRatioRaw ?? s.fluctuationsRatio) || 0;
    const code = s.compareToPreviousPrice && s.compareToPreviousPrice.code;
    if ((code === '4' || code === '5') && v > 0) v = -v; // 하락인데 부호가 빠진 경우
    return v;
  }
  function putNaver(market, s, ex) {
    const sym = market === 'krx' ? 'krx:' + s.itemCode : 'us:' + s.reutersCode;
    const exName = ex || (s.stockExchangeType && s.stockExchangeType.name);
    remember(sym, { name: s.stockName, sub: market === 'krx' ? s.itemCode : s.symbolCode, ex: exName });
    putQuote(sym, {
      price: num(s.closePriceRaw ?? s.closePrice), chg: naverChg(s), vol: num(s.accumulatedTradingValueRaw),
      cap: num(s.marketValueRaw ?? s.marketValueFullRaw), open: num(s.openPriceRaw), high: num(s.highPriceRaw), low: num(s.lowPriceRaw),
      accVol: num(s.accumulatedTradingVolumeRaw), status: s.marketStatus, ts: Date.now(), live: true,
    });
    return sym;
  }
  const LISTS = { krx: [['KOSPI', 2], ['KOSDAQ', 2]], us: [['NASDAQ', 2], ['NYSE', 1]] };
  const listOrder = { krx: [], us: [] }; // 목록 화면 기본 순서 (시가총액 순)
  async function loadList(market) {
    const jobs = [];
    for (const [cat, pages] of LISTS[market]) {
      for (let p = 1; p <= pages; p++) {
        const req = market === 'krx'
          ? Relay.json('naver-m', `stocks/marketValue/${cat}`, { page: p, pageSize: 100 })
          : Relay.json('naver-api', `stock/exchange/${cat}/marketValue`, { page: p, pageSize: 100 });
        jobs.push(req.then((d) => (d.stocks || []).filter((s) => !s.stockEndType || s.stockEndType === 'stock').map((s) => putNaver(market, s, cat))));
      }
    }
    const res = await Promise.allSettled(jobs);
    const syms = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (syms.length) listOrder[market] = syms;
    if (res.every((r) => r.status === 'rejected')) throw res[0].reason;
  }
  async function loadStaticStocks() {
    for (const market of ['krx', 'us']) {
      try {
        const d = await staticJSON(market + '.json', 5 * 60e3);
        listOrder[market] = d.rows.map((r) => r.sym);
        for (const r of d.rows) {
          remember(r.sym, { name: r.name, sub: r.sub, ex: r.ex });
          const q = Quotes.get(r.sym);
          if (!q || !q.live) putQuote(r.sym, { price: r.price, chg: r.chg, vol: r.vol, cap: r.cap, ts: Date.parse(d.updatedAt), live: false });
        }
      } catch { /* 아직 데이터 없음 */ }
    }
  }
  const StockLive = {
    timer: null, running: false, lastError: null,
    kick() { if (!this.running) this.loop(); },
    async loop() {
      clearTimeout(this.timer);
      const wk = wanted('krx'), wu = wanted('us');
      if (!wk.size && !wu.size) { this.running = false; return; }
      this.running = true;
      if (!document.hidden) {
        try {
          if (Relay.ok()) await this.poll(wk, wu);
          else await loadStaticStocks();
          this.lastError = null;
        } catch (e) {
          this.lastError = e;
          await loadStaticStocks();
        }
      }
      this.timer = setTimeout(() => this.loop(), Relay.ok() ? STOCK_POLL_MS : 60e3);
    },
    async poll(wk, wu) {
      const jobs = [];
      const inList = new Set();
      for (const [market, w] of [['krx', wk], ['us', wu]]) {
        if (w.has(market + ':*')) { jobs.push(loadList(market)); listOrder[market].forEach((s) => inList.add(s)); }
      }
      const kr = [...wk].filter((s) => !s.endsWith('*') && !inList.has(s)).map((s) => split(s)[1]);
      const us = [...wu].filter((s) => !s.endsWith('*') && !inList.has(s)).map((s) => split(s)[1]);
      for (let i = 0; i < kr.length; i += 20) {
        jobs.push(Relay.json('naver-poll', 'domestic/stock/' + kr.slice(i, i + 20).join(',')).then((d) => (d.datas || []).forEach((s) => putNaver('krx', s))));
      }
      for (let i = 0; i < us.length; i += 20) {
        jobs.push(Relay.json('naver-poll', 'worldstock/stock/' + us.slice(i, i + 20).join(',')).then((d) => (d.datas || []).forEach((s) => putNaver('us', s))));
      }
      const res = await Promise.allSettled(jobs);
      const bad = res.filter((r) => r.status === 'rejected');
      if (bad.length && bad.length === res.length) throw bad[0].reason;
    },
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && StockLive.running) StockLive.loop(); });

  // ── 지수·환율 ─────────────────────────────────────────
  const FX = { usd: null, usdt: null };
  async function overview() {
    let items = null, live = false;
    if (Relay.ok()) {
      const [dom, world, fx] = await Promise.allSettled([
        Relay.json('naver-poll', 'domestic/index/KOSPI,KOSDAQ'),
        Relay.json('naver-poll', 'worldstock/index/.IXIC,.INX,.DJI'),
        Relay.json('naver-api', 'marketindex/exchange/FX_USDKRW'),
      ]);
      items = [];
      if (fx.status === 'fulfilled') {
        const d = fx.value.exchangeInfo;
        let chg = num(d.fluctuationsRatio) || 0;
        if (d.fluctuationsType && ['4', '5'].includes(d.fluctuationsType.code) && chg > 0) chg = -chg;
        items.push({ id: 'USDKRW', label: 'USD/KRW', price: num(d.calcPrice ?? d.closePrice), chg });
      }
      for (const r of [dom, world]) {
        if (r.status !== 'fulfilled') continue;
        for (const s of r.value.datas || []) {
          items.push({ id: s.itemCode || s.reutersCode, label: s.stockName || s.indexName, price: num(s.closePriceRaw), chg: naverChg(s), status: s.marketStatus });
        }
      }
      live = items.length > 0;
    }
    if (!live) {
      try { items = (await staticJSON('overview.json', 5 * 60e3)).items; } catch { items = items || []; }
    }
    const fx = items.find((x) => x.id === 'USDKRW');
    if (fx) FX.usd = fx.price;
    return { items, live };
  }
  function usdtKrw() {
    const q = Quotes.get('upbit:KRW-USDT');
    return (q && q.price) || FX.usd;
  }

  // 김치 프리미엄 = 업비트 원화가 ÷ (바이낸스 USDT가 × 달러 환율) − 1
  const kimpRef = new Map(); // base → 바이낸스 USDT 가격 (REST 로 20초마다)
  let kimpAt = 0;
  async function refreshKimpRef() {
    if (Date.now() - kimpAt < 20e3) return;
    kimpAt = Date.now();
    const top = binanceTop();
    if (!top.length) return;
    try {
      const d = await getJSON('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(top)));
      for (const x of d) kimpRef.set(x.symbol.replace(/USDT$/, ''), +x.price);
    } catch { /* 바이낸스 접속 불가 지역 등 */ }
  }
  function kimp(base, krwPrice) {
    const bq = Quotes.get('binance:' + base + 'USDT');
    const usd = (bq && bq.price) || kimpRef.get(base);
    if (!usd || !FX.usd || !krwPrice) return null;
    const k = (krwPrice / (usd * FX.usd) - 1) * 100;
    return Math.abs(k) < 50 ? k : null; // 티커만 같고 다른 코인이면 터무니없는 값
  }

  // ── 캔들 ──────────────────────────────────────────────
  const wallTs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0) / 1000;
  const ymdTs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10) || 0, +s.slice(10, 12) || 0) / 1000;
  function dedupe(cs) {
    const m = new Map();
    for (const c of cs) m.set(c.t, c);
    return [...m.values()].sort((a, b) => a.t - b.t);
  }

  const UPBIT_PATH = {
    '1m': 'minutes/1', '3m': 'minutes/3', '5m': 'minutes/5', '15m': 'minutes/15', '30m': 'minutes/30',
    '1h': 'minutes/60', '4h': 'minutes/240', '1d': 'days', '1w': 'weeks', '1M': 'months',
  };
  const UPBIT_BLOCKED = '업비트가 잠시 요청을 막았습니다 — 같은 인터넷에서 여러 기기·탭으로 열면 자주 생깁니다. 실시간 중계(Worker)를 연결하면 해결됩니다.';
  const upbitGate = { next: 0 };
  // 업비트는 브라우저발 요청을 같은 IP 기준 10초에 1번 정도만 받는다.
  // 넘치면 CORS 헤더 없는 429 를 돌려줘서 브라우저에선 TypeError 로 보인다 → 간격을 두고 세 번까지 시도
  async function upbitGet(path, onWait) {
    if (Relay.ok()) {
      try { return await Relay.json('upbit', path); } catch (e) { if (e.status !== 429 && e.status !== 502) throw e; }
    }
    for (let attempt = 0; ; attempt++) {
      const now = Date.now(), at = Math.max(now, upbitGate.next);
      upbitGate.next = at + 10500;
      if (at > now) {
        if (onWait) onWait(Math.ceil((at - now) / 1000));
        await sleep(at - now);
      }
      try {
        return await getJSON('https://api.upbit.com/v1/' + path);
      } catch (e) {
        if (e.status && e.status !== 429) throw e;
        if (attempt >= 2) throw new Error(UPBIT_BLOCKED);
      }
    }
  }
  async function upbitCandles(code, iv, onWait) {
    const pages = Relay.ok() ? 2 : 1;
    let raw = [], to = null;
    for (let p = 0; p < pages; p++) {
      const page = await upbitGet(`candles/${UPBIT_PATH[iv]}?market=${code}&count=200${to ? '&to=' + encodeURIComponent(to) : ''}`, onWait);
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
  async function binanceCandles(code, iv) {
    const d = await getJSON(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(code)}&interval=${iv}&limit=500`);
    const shift = DAILY.has(iv) ? 0 : 9 * 3600; // 분봉은 한국 시간으로
    return d.map((k) => ({ t: k[0] / 1000 + shift, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  // 네이버 분봉은 최근 8거래일 정도까지만 준다
  const NAVER_PERIOD = { '1m': 'minute', '3m': 'minute3', '5m': 'minute5', '15m': 'minute15', '30m': 'minute30', '1h': 'minute60', '1d': 'day', '1w': 'week', '1M': 'month' };
  const NAVER_DAYS = { '1m': 4, '3m': 10, '5m': 14, '15m': 20, '30m': 30, '1h': 40, '1d': 620, '1w': 2900, '1M': 12500 };
  async function naverCandles(market, code, iv) {
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '') + '0000';
    const now = Date.now();
    const d = await Relay.json('naver-api', `chart/${market === 'krx' ? 'domestic' : 'foreign'}/item/${code}/${NAVER_PERIOD[iv]}`, {
      startDateTime: ymd(new Date(now - NAVER_DAYS[iv] * 864e5)), endDateTime: ymd(new Date(now + 2 * 864e5)),
    });
    return dedupe(d.map((x) => {
      const c = x.closePrice ?? x.currentPrice;
      return { t: ymdTs(x.localDateTime || x.localDate), o: x.openPrice || c, h: x.highPrice || c, l: x.lowPrice || c, c, v: x.accumulatedTradingVolume || 0 };
    })).slice(-500);
  }
  // 미국 주식 분봉 — 야후엔 3분봉이 없어 1분봉을 합친다
  const YAHOO_IV = { '1m': ['2d', '1m'], '3m': ['5d', '1m'], '5m': ['5d', '5m'], '15m': ['1mo', '15m'], '30m': ['1mo', '30m'], '1h': ['6mo', '60m'] };
  async function yahooCandles(sym, iv) {
    const ticker = nameOf(sym).sub.replace(/\./g, '-');
    const [range, interval] = YAHOO_IV[iv];
    const d = await Relay.json('yahoo', encodeURIComponent(ticker), { range, interval });
    const r = d.chart.result[0], q = r.indicators.quote[0];
    const out = [];
    (r.timestamp || []).forEach((ts, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      out.push({ t: ts + 9 * 3600, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
    });
    const bars = dedupe(out);
    return iv === '3m' ? groupBars(bars, (t) => Math.floor(t / 180) * 180) : bars;
  }
  // 봉 묶기 — key(t) 가 같은 봉끼리 합친다
  function groupBars(bars, key) {
    const out = [];
    let cur = null;
    for (const c of bars) {
      const k = key(c.t);
      if (!cur || cur.t !== k) { cur = { ...c, t: k }; out.push(cur); } else {
        cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v;
      }
    }
    return out;
  }
  // GitHub Actions 가 스크리너를 계산하며 남긴 일봉 (collector/collect.py 의 candle_path 와 같은 규칙)
  async function staticCandles(sym) {
    const [market, code] = split(sym);
    const d = await staticJSON(`candles/${market}/${code.replace(/[^A-Za-z0-9._-]/g, '_')}.json`, 5 * 60e3);
    return d.c.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  }
  // 일봉 → 주봉(월요일 시작) · 월봉
  function aggregate(daily, iv) {
    if (iv === '1d') return daily;
    return groupBars(daily, (t) => {
      const d = new Date(t * 1000);
      return iv === '1w' ? t - ((d.getUTCDay() + 6) % 7) * 86400 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    });
  }
  // onWait(초): 업비트 제한으로 기다릴 때 화면에 알려 주는 콜백
  async function candles(sym, iv, onWait) {
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
        if (market !== 'upbit') throw e.status === 404 ? new Error('이 종목은 저장된 일봉이 없습니다 — 실시간 중계(Worker)를 연결하면 볼 수 있습니다') : e;
      }
    }
    if (market === 'upbit') return upbitCandles(code, iv, onWait);
    throw new NeedRelay();
  }

  // ── 검색 ──────────────────────────────────────────────
  async function search(q) {
    q = q.trim();
    if (!q) return [];
    await loadCoins();
    const ql = q.toLowerCase();
    const rank = (a, b) => { a = (a || '').toLowerCase(); b = (b || '').toLowerCase(); return a === ql || b === ql ? 0 : a.startsWith(ql) || b.startsWith(ql) ? 1 : 2; };
    const pick = (list, n = 8) => list.sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.item);
    const res = [];
    const coins = [];
    for (const [code, [name, en]] of Object.entries(coinsData.upbit || {})) {
      const base = code.slice(4);
      if (name.toLowerCase().includes(ql) || base.toLowerCase().includes(ql) || (en || '').toLowerCase().includes(ql)) {
        coins.push({ r: rank(name, base), item: { sym: 'upbit:' + code, market: 'upbit', name, sub: base } });
      }
    }
    res.push(...pick(coins));
    const bn = [];
    for (const s of binanceTop()) {
      const n = nameOf('binance:' + s), base = s.replace(/USDT$/, '');
      if (base.toLowerCase().includes(ql) || n.name.toLowerCase().includes(ql)) bn.push({ r: rank(n.name, base), item: { sym: 'binance:' + s, market: 'binance', name: n.name, sub: n.sub } });
    }
    res.push(...pick(bn, 5));
    if (Relay.ok()) {
      try {
        const d = await Relay.json('naver-ac', '', { q, target: 'stock,worldstock' });
        for (const it of d.items || []) {
          let sym, sub;
          if (it.nationCode === 'KOR') { sym = 'krx:' + it.code; sub = it.code; } else if (it.nationCode === 'USA') { sym = 'us:' + it.reutersCode; sub = it.code; } else continue;
          remember(sym, { name: it.name, sub, ex: it.typeCode });
          res.push({ sym, market: marketOf(sym), name: it.name, sub, ex: it.typeName });
        }
        return res;
      } catch { /* 아래 정적 목록으로 */ }
    }
    await loadStaticStocks();
    for (const market of ['krx', 'us']) {
      const hits = [];
      for (const sym of listOrder[market]) {
        const n = nameOf(sym);
        if (n.name.toLowerCase().includes(ql) || n.sub.toLowerCase().includes(ql)) hits.push({ r: rank(n.name, n.sub), item: { sym, market, name: n.name, sub: n.sub, ex: n.ex } });
      }
      res.push(...pick(hits));
    }
    return res;
  }

  // ── 뉴스 ──────────────────────────────────────────────
  const topicNews = () => staticJSON('news.json', 5 * 60e3);
  async function symbolNews(query) {
    const xml = await Relay.text('gnews', '', { q: query + ' when:7d', hl: 'ko', gl: 'KR', ceid: 'KR:ko' });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return [...doc.querySelectorAll('item')].slice(0, 30).map((it) => {
      const src = (it.querySelector('source') || {}).textContent || '';
      let title = (it.querySelector('title') || {}).textContent || '';
      if (src && title.endsWith(' - ' + src)) title = title.slice(0, -src.length - 3);
      return { title, src, url: (it.querySelector('link') || {}).textContent, ts: Date.parse((it.querySelector('pubDate') || {}).textContent) / 1000 };
    });
  }
  const googleNewsUrl = (query) => 'https://news.google.com/search?' + new URLSearchParams({ q: query, hl: 'ko', gl: 'KR', ceid: 'KR:ko' });

  const screener = (market) => staticJSON(`screener/${market}.json`, 3 * 60e3);
  const meta = () => staticJSON('meta.json', 3 * 60e3);

  root.D = {
    MARKETS, INTERVALS, IV_SEC, DAILY, Store, Relay, Names, Quotes, FX, NeedRelay, listOrder,
    split, marketOf, nameOf, remember, loadCoins, upbitCodes, binanceTop,
    onQuotes, want, unwant, overview, usdtKrw, kimp, refreshKimpRef,
    candles, search, topicNews, symbolNews, googleNewsUrl, screener, meta, loadStaticStocks,
    stockError: () => StockLive.lastError,
  };
})(window);
