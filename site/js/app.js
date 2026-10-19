// 마켓렌즈 화면 — 시장 / 차트 / 스크리너 / 뉴스 / 내 자산 / 알림 / 설정
(function () {
  'use strict';
  const { MARKETS, Store, Relay, Quotes, FX } = D;
  const LC = window.LightweightCharts;

  // ── 작은 도구 ─────────────────────────────────────────
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const enc = encodeURIComponent;
  const pad = (n) => String(n).padStart(2, '0');

  const nfs = {};
  const nf = (d) => (nfs[d] ||= new Intl.NumberFormat('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : nf(d).format(x));
  function digits(p, market) {
    const a = Math.abs(p || 0);
    if (!a || market === 'krx') return 0;
    const mag = Math.floor(Math.log10(a));
    if (market === 'upbit') return Math.min(8, Math.max(0, 3 - mag)); // 110,874,000 / 512.3 / 0.01234
    if (market === 'binance') return Math.min(8, Math.max(2, 4 - mag)); // 82,386.01 / 2.3456
    return Math.min(6, Math.max(2, 2 - mag)); // 343.46
  }
  const fmtPrice = (p, market) => fmt(p, digits(p, market));
  const fmtPct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
  const dir = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const arrow = (x) => (x > 0 ? '▲' : x < 0 ? '▼' : '');
  const chgHtml = (x) => {
    if (x == null || !Number.isFinite(x)) return '–';
    const r = Math.round(x * 100) / 100; // 0.00% 로 보이는 값엔 화살표를 붙이지 않는다
    return `<span class="${dir(r)}">${arrow(r)}${r ? ' ' : ''}${fmtPct(r)}</span>`;
  };
  const ccyOf = (m) => MARKETS[m].ccy;
  function fmtAmount(x, ccy) {
    if (x == null || !Number.isFinite(x)) return '–';
    if (ccy === 'KRW') {
      if (x >= 1e12) return (x / 1e12).toFixed(x >= 1e14 ? 0 : 1) + '조';
      if (x >= 1e8) return fmt(x / 1e8) + '억';
      if (x >= 1e4) return fmt(x / 1e4) + '만';
      return fmt(x);
    }
    if (x >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
    if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
    if (x >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
    return '$' + fmt(x);
  }
  function timeAgo(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const IV_LABEL = { '1m': '1분', '3m': '3분', '5m': '5분', '15m': '15분', '30m': '30분', '1h': '1시간', '4h': '4시간', '1d': '일', '1w': '주', '1M': '월' };
  const UNIT = { '1d': '일', '1w': '주', '1M': '개월' };
  const mkBadge = (m) => `<span class="mk">${MARKETS[m].name}</span>`;
  const sigPill = (k) => { const s = Ind.SIGNALS[k]; return s ? `<span class="pill ${s[1]}">${s[1] === 'up' ? '▲ ' : s[1] === 'down' ? '▼ ' : ''}${s[0]}</span>` : ''; };
  const opClass = (label) => (label.includes('매수') ? 'up' : label.includes('매도') ? 'down' : 'flat');
  const ivsOf = (sym) => D.INTERVALS[MARKETS[D.marketOf(sym)].coin ? 'coin' : 'stock'];

  function toast(title, body, onClick) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<b>${esc(title)}</b>${body ? esc(body) : ''}`;
    el.onclick = () => { el.remove(); if (onClick) onClick(); };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }
  function flash(el, up) {
    if (!el.animate) return;
    el.animate([{ backgroundColor: hexA(css(up ? '--up' : '--down'), 0.22) }, { backgroundColor: 'transparent' }], { duration: 700 });
  }

  // ── 관심종목 / 보유자산 (이 기기의 브라우저에 저장) ─────
  const DEFAULT_WATCH = [
    { sym: 'upbit:KRW-BTC', name: '비트코인', sub: 'BTC' }, { sym: 'upbit:KRW-ETH', name: '이더리움', sub: 'ETH' },
    { sym: 'krx:005930', name: '삼성전자', sub: '005930' }, { sym: 'krx:000660', name: 'SK하이닉스', sub: '000660' },
    { sym: 'us:NVDA.O', name: '엔비디아', sub: 'NVDA' }, { sym: 'us:AAPL.O', name: '애플', sub: 'AAPL' },
  ];
  function listStore(key, def) {
    return {
      _l: null,
      list() { return (this._l ||= Store.get(key, def)); },
      save(l) { this._l = l; Store.set(key, l); },
    };
  }
  const Watch = Object.assign(listStore('ml.watch', DEFAULT_WATCH), {
    has(sym) { return this.list().some((w) => w.sym === sym); },
    toggle(sym) {
      const l = this.list().slice();
      const i = l.findIndex((w) => w.sym === sym);
      if (i >= 0) l.splice(i, 1);
      else { const n = D.nameOf(sym); l.push({ sym, name: n.name, sub: n.sub }); }
      this.save(l);
      return i < 0;
    },
  });
  const Portfolio = listStore('ml.portfolio', []);
  const rateOf = (m) => (m === 'upbit' || m === 'krx' ? 1 : m === 'us' ? FX.usd : D.usdtKrw());

  // ── 검색 상자 ─────────────────────────────────────────
  const SEARCH_SVG = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  const searchBoxHtml = (id, ph) => `<div class="search-box" id="${id}">${SEARCH_SVG}<input class="field" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false" enterkeyhint="search"><div class="dropdown" hidden></div></div>`;
  function bindSearch(box, onPick) {
    const input = $('input', box), dd = $('.dropdown', box);
    let items = [], active = -1, seq = 0, timer = null;
    const close = () => { dd.hidden = true; };
    const render = () => {
      dd.innerHTML = items.length
        ? items.map((it, i) => `<div class="dd-item${i === active ? ' active' : ''}" data-i="${i}">${mkBadge(it.market)}<b>${esc(it.name)}</b><span class="sub">${esc(it.sub)}</span></div>`).join('')
        : '<div class="dd-empty">결과 없음</div>';
      dd.hidden = false;
    };
    const pick = (i) => { const it = items[i]; if (!it) return; input.value = ''; items = []; close(); input.blur(); onPick(it); };
    async function run() {
      const q = input.value.trim();
      if (!q) { items = []; return close(); }
      const my = ++seq;
      try {
        const res = await D.search(q);
        if (my !== seq) return;
        items = res; active = 0; render();
      } catch { /* 검색 실패는 조용히 */ }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (items.length) pick(Math.max(0, active)); else run(); }
      else if (e.key === 'Escape') { close(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('focus', () => { if (items.length && input.value.trim()) render(); });
    dd.addEventListener('pointerdown', (e) => e.preventDefault()); // 입력창 포커스를 유지해야 클릭이 먹는다
    dd.addEventListener('click', (e) => { const it = e.target.closest('.dd-item'); if (it) pick(+it.dataset.i); });
  }
  // 종목 하나를 고르는 칸 (내 자산·알림 입력용)
  function makePicker(host, onChange) {
    const p = {
      value: null,
      set(it) {
        p.value = it;
        if (it) {
          host.innerHTML = `<span class="picked">${mkBadge(it.market)} <b>${esc(it.name)}</b> <span class="muted small">${esc(it.sub)}</span><button type="button" aria-label="다시 고르기">×</button></span>`;
          $('button', host).onclick = () => p.set(null);
        } else {
          host.innerHTML = searchBoxHtml('', '종목 검색');
          bindSearch($('.search-box', host), (x) => p.set(x));
        }
        onChange && onChange(it);
      },
    };
    p.set(null);
    return p;
  }
  const pickItem = (sym) => { const n = D.nameOf(sym); return { sym, market: D.marketOf(sym), name: n.name, sub: n.sub }; };

  // ── 화면 전환 ─────────────────────────────────────────
  const NAV = [['market', '시장'], ['chart', '차트'], ['screener', '스크리너'], ['news', '뉴스'], ['assets', '내 자산'], ['alerts', '알림']];
  const views = {};
  let current = null;
  function route() {
    const [name, ...args] = location.hash.replace(/^#/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const v = views[name] ? name : 'market';
    if (current && current !== v) {
      views[current].leave && views[current].leave();
      $('#view-' + current).hidden = true;
    }
    $('#view-' + v).hidden = false;
    current = v;
    for (const a of document.querySelectorAll('#topTabs a')) a.classList.toggle('on', a.dataset.v === v);
    views[v].enter(args.filter((x) => x !== ''));
    updateBanner();
  }
  function updateBanner() {
    const b = $('#relayBanner');
    if (current === 'settings' || current === 'news') { b.hidden = true; return; }
    if (!Relay.ok()) {
      b.innerHTML = '주식 시세가 <b>10~20분 지연</b>된 값입니다. <a href="#settings">실시간 중계 연결하기 →</a>';
      b.hidden = false;
    } else if (D.stockError()) {
      b.innerHTML = `실시간 중계 연결에 문제가 있습니다 (${esc(D.stockError().message)}). <a href="#settings">설정 확인 →</a>`;
      b.hidden = false;
    } else b.hidden = true;
  }

  // ── 상단 지수 띠 ──────────────────────────────────────
  async function pollOverview() {
    try {
      const { items, live } = await D.overview();
      $('#tickers').innerHTML = items.map((x) => `<span class="tick"><b>${esc(x.label)}</b><span class="num">${fmt(x.price, 2)}</span> <span class="num ${dir(x.chg)}">${fmtPct(x.chg)}</span></span>`).join('')
        + (live ? '<span class="tick muted" title="실시간">실시간<span class="dot"></span></span>' : '<span class="tick muted">10분 단위</span>');
    } catch { /* 다음 주기에 다시 */ }
    updateBanner();
    setTimeout(pollOverview, Relay.ok() ? 15e3 : 60e3);
  }

  // ════════════════════════════════════════════════════
  // 시장
  // ════════════════════════════════════════════════════
  const COLS = {
    name: { label: '종목', get: (r) => r.name, cls: 'name-cell' },
    price: { label: '현재가', get: (r) => r.price },
    chg: { label: '등락률', get: (r) => r.chg, cls: 'chg-cell' },
    vol: { label: '거래대금', get: (r) => r.vol, cls: 'hide-xs' },
    kimp: { label: '김프', get: (r) => r.kimp, cls: 'hide-sm' },
    cap: { label: '시가총액', get: (r) => r.cap, cls: 'hide-sm' },
  };
  const MARKET_COLS = { upbit: ['name', 'price', 'chg', 'vol', 'kimp'], binance: ['name', 'price', 'chg', 'vol'], krx: ['name', 'price', 'chg', 'vol', 'cap'], us: ['name', 'price', 'chg', 'vol', 'cap'], watch: ['name', 'price', 'chg', 'vol'] };
  const DEFAULT_SORT = { upbit: { k: 'vol', d: -1 }, binance: { k: 'vol', d: -1 }, krx: { k: 'cap', d: -1 }, us: { k: 'cap', d: -1 }, watch: null };
  function cellHtml(k, r, watchMode) {
    switch (k) {
      case 'name': return `<div class="nm"><b>${esc(r.name)}${r.warn ? '<span class="warn-badge">유의</span>' : ''}</b><span>${watchMode ? MARKETS[r.m].name + ' · ' : ''}${esc(r.sub)}${r.ex && !watchMode ? ' · ' + esc(r.ex) : ''}${r.live === false ? ' · 지연' : ''}</span></div>`;
      case 'price': return r.price == null ? '–' : fmtPrice(r.price, r.m);
      case 'chg': return chgHtml(r.chg);
      case 'vol': return fmtAmount(r.vol, ccyOf(r.m));
      case 'kimp': return r.kimp == null ? '–' : `<span class="${dir(r.kimp)}">${fmtPct(r.kimp)}</span>`;
      case 'cap': return fmtAmount(r.cap, ccyOf(r.m));
    }
    return '';
  }
  function sortRows(rows, s) {
    if (!s) return rows;
    const get = COLS[s.k].get;
    return rows.sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * s.d;
    });
  }
  function headHtml(cols, s, star = true) {
    return `<tr>${star ? '<th class="star nosort"></th>' : ''}${cols.map((k) => {
      const on = s && s.k === k;
      return `<th data-k="${k}" class="${COLS[k].cls || ''}${on ? ' sorted' : ''}">${COLS[k].label}${on ? (s.d > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    }).join('')}</tr>`;
  }

  views.market = {
    el: $('#view-market'),
    market: Store.get('ml.mkt', 'upbit'),
    sorts: Store.get('ml.mktSort', {}),
    filter: '',
    trs: new Map(),
    built: false,
    renderTimer: null,
    build() {
      this.el.innerHTML = `
        <div class="toolbar">
          <div class="seg" id="mSeg">${['upbit', 'binance', 'krx', 'us', 'watch'].map((m) => `<button data-m="${m}">${m === 'watch' ? '★ 관심' : MARKETS[m].name}</button>`).join('')}</div>
          <div class="grow"></div>
          ${searchBoxHtml('mSearch', '종목 검색 — 비트코인, 삼성전자, AAPL')}
        </div>
        <div class="toolbar"><input class="field" id="mFilter" placeholder="목록에서 찾기" style="width:170px"><span class="muted small" id="mMeta"></span></div>
        <div class="table-wrap"><table class="grid" id="mTable"><thead></thead><tbody></tbody></table><div class="empty" id="mEmpty" hidden></div></div>`;
      $('#mSeg', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) location.hash = '#market/' + b.dataset.m; };
      bindSearch($('#mSearch', this.el), (it) => { location.hash = `#chart/${enc(it.sym)}`; });
      $('#mFilter', this.el).oninput = (e) => { this.filter = e.target.value.trim().toLowerCase(); this.render(); };
      $('#mTable thead', this.el).onclick = (e) => {
        const th = e.target.closest('th[data-k]');
        if (!th) return;
        const k = th.dataset.k, cur = this.sort();
        this.sorts[this.market] = { k, d: cur && cur.k === k ? -cur.d : k === 'name' ? 1 : -1 };
        Store.set('ml.mktSort', this.sorts);
        this.renderHead();
        this.render();
      };
      $('#mTable tbody', this.el).onclick = (e) => {
        const star = e.target.closest('[data-star]');
        if (star) {
          e.stopPropagation();
          const on = Watch.toggle(star.dataset.star);
          star.classList.toggle('on', on);
          if (this.market === 'watch') this.enter([]);
          return;
        }
        const tr = e.target.closest('tr[data-sym]');
        if (tr) location.hash = `#chart/${enc(tr.dataset.sym)}`;
      };
      this.built = true;
    },
    sort() { return this.market in this.sorts ? this.sorts[this.market] : DEFAULT_SORT[this.market]; },
    syms() {
      switch (this.market) {
        case 'upbit': return D.upbitCodes().map((c) => 'upbit:' + c);
        case 'binance': return D.binanceTop().map((s) => 'binance:' + s);
        case 'watch': return Watch.list().map((w) => w.sym);
        default: return D.listOrder[this.market];
      }
    },
    enter([m]) {
      if (!this.built) this.build();
      if (m && (MARKETS[m] || m === 'watch')) this.market = m;
      Store.set('ml.mkt', this.market);
      for (const b of this.el.querySelectorAll('#mSeg button')) b.classList.toggle('on', b.dataset.m === this.market);
      D.want('market', this.market === 'watch' ? this.syms() : [this.market + ':*']);
      $('#mTable tbody', this.el).innerHTML = '';
      this.trs.clear();
      this.renderHead();
      this.render();
    },
    leave() { D.unwant('market'); },
    onQuotes() { if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 600); },
    renderHead() { $('#mTable thead', this.el).innerHTML = headHtml(MARKET_COLS[this.market], this.sort()); },
    render() {
      const watchMode = this.market === 'watch';
      if (this.market === 'upbit') D.refreshKimpRef();
      let rows = this.syms().map((sym) => {
        const q = Quotes.get(sym) || {}, n = D.nameOf(sym), m = D.marketOf(sym);
        return { sym, m, name: n.name, sub: n.sub, ex: n.ex, warn: n.warn, price: q.price, chg: q.chg, vol: q.vol, cap: q.cap, live: q.live, kimp: m === 'upbit' ? D.kimp(n.sub, q.price) : null };
      });
      if (!watchMode) rows = rows.filter((r) => r.price != null);
      if (this.filter) rows = rows.filter((r) => r.name.toLowerCase().includes(this.filter) || r.sub.toLowerCase().includes(this.filter));
      rows = sortRows(rows, this.sort());
      const cols = MARKET_COLS[this.market];
      const tb = $('#mTable tbody', this.el);
      const keep = new Set();
      let prev = null;
      for (const r of rows) {
        let tr = this.trs.get(r.sym);
        if (!tr) {
          tr = document.createElement('tr');
          tr.dataset.sym = r.sym;
          tr.innerHTML = `<td class="star"><button class="star-btn" data-star="${esc(r.sym)}" aria-label="관심종목">★</button></td>` + cols.map((k) => `<td class="${COLS[k].cls || ''}"></td>`).join('');
          this.trs.set(r.sym, tr);
        }
        tr.firstChild.firstChild.classList.toggle('on', Watch.has(r.sym));
        cols.forEach((k, i) => {
          const td = tr.children[i + 1], h = cellHtml(k, r, watchMode);
          if (td._h !== h) { td.innerHTML = h; td._h = h; }
        });
        if (tr._p != null && r.price != null && r.price !== tr._p) flash(tr.children[cols.indexOf('price') + 1], r.price > tr._p);
        tr._p = r.price;
        const want = prev ? prev.nextSibling : tb.firstChild;
        if (want !== tr) tb.insertBefore(tr, want);
        prev = tr;
        keep.add(r.sym);
      }
      for (const [sym, tr] of this.trs) if (!keep.has(sym)) { tr.remove(); this.trs.delete(sym); }
      const empty = $('#mEmpty', this.el);
      empty.hidden = rows.length > 0;
      if (!rows.length) {
        empty.innerHTML = this.filter ? '찾는 종목이 없습니다' : watchMode ? '관심종목이 없습니다. 목록의 ★을 눌러 추가하세요.' : '<span class="spinner"></span> 시세 불러오는 중…';
      }
      const live = rows.some((r) => r.live);
      $('#mMeta', this.el).textContent = rows.length ? `${rows.length}종목 · ${live ? '실시간' : '지연 시세'}` : '';
    },
  };

  // ════════════════════════════════════════════════════
  // 차트
  // ════════════════════════════════════════════════════
  const TOGGLES = [['ma', '이동평균'], ['bb', '볼린저'], ['vol', '거래량'], ['rsi', 'RSI'], ['macd', 'MACD'], ['cross', '골든/데드']];
  function chartTheme() {
    return {
      surface: css('--surface'), muted: css('--muted'), ink: css('--ink'), grid: css('--grid'), axis: css('--axis'),
      up: css('--up'), down: css('--down'), s2: css('--s2'), s3: css('--s3'), s4: css('--s4'), s5: css('--s5'), s7: css('--s7'),
      font: getComputedStyle(document.body).fontFamily,
    };
  }
  const tickFmt = (t, type) => {
    const d = new Date(t * 1000);
    if (type === 0) return String(d.getUTCFullYear());
    if (type === 1) return `${d.getUTCMonth() + 1}월`;
    if (type === 2) return String(d.getUTCDate());
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const timeLabel = (t, daily) => {
    const d = new Date(t * 1000);
    const ymd = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
    return daily ? ymd : `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const SERIES_KEY = { ma5: 'ma5', ma20: 'ma20', ma60: 'ma60', ma120: 'ma120', bbUp: 'bbUp', bbLo: 'bbLo', rsi: 'rsi', macd: 'macd', signal: 'macdSignal' };

  views.chart = {
    el: $('#view-chart'),
    sym: null, iv: null, candles: null, ind: null, an: null,
    chart: null, s: {}, markers: null, renderedLen: 0,
    tog: Store.get('ml.ind', { ma: true, bb: false, vol: true, rsi: true, macd: true, cross: false }),
    loadSeq: 0, refreshTimer: null, liveTimer: null, news: {},
    built: false,
    build() {
      this.el.innerHTML = `
        <div class="chart-head">
          <div class="sym-title"><span id="cMk"></span><h1 id="cName"></h1><span class="sub" id="cSub"></span></div>
          <div class="sym-price"><span class="big num" id="cPrice"></span><span class="num" id="cChg"></span><span class="small muted" id="cExtra"></span></div>
          <div class="sym-actions">
            <button class="btn" id="cStar">☆ 관심</button>
            <a class="btn" id="cAddPf">+ 내 자산</a>
            <a class="btn" id="cAddAl">알림 추가</a>
          </div>
        </div>
        <div class="chart-tools">
          <div class="seg small" id="cIv"></div>
          <div class="chips" id="cTog" style="margin:0">${TOGGLES.map(([k, l]) => `<button class="chip" data-t="${k}">${l}</button>`).join('')}</div>
          ${searchBoxHtml('cSearch', '다른 종목')}
        </div>
        <div class="chart-layout">
          <div class="chart-card"><div class="legend" id="cLegend"></div><div class="chart-el" id="cChart"></div><div class="chart-msg" id="cMsg" hidden></div></div>
          <aside class="side" id="cSide"></aside>
        </div>`;
      $('#cIv', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) location.hash = `#chart/${enc(this.sym)}/${b.dataset.iv}`; };
      $('#cTog', this.el).onclick = (e) => {
        const b = e.target.closest('[data-t]');
        if (!b) return;
        this.tog[b.dataset.t] = !this.tog[b.dataset.t];
        Store.set('ml.ind', this.tog);
        this.renderToggles();
        if (this.candles) this.buildChart();
      };
      $('#cStar', this.el).onclick = () => { Watch.toggle(this.sym); this.renderHead(); };
      bindSearch($('#cSearch', this.el), (it) => { location.hash = `#chart/${enc(it.sym)}/${this.iv}`; });
      this.built = true;
      this.renderToggles();
    },
    enter([sym, iv]) {
      if (!this.built) this.build();
      sym = sym || this.sym || Store.get('ml.lastSym', 'upbit:KRW-BTC');
      try { D.split(sym); if (!MARKETS[D.marketOf(sym)]) throw 0; } catch { sym = 'upbit:KRW-BTC'; }
      const ivs = ivsOf(sym);
      iv = ivs.includes(iv) ? iv : ivs.includes(this.iv) ? this.iv : '1d';
      const changed = sym !== this.sym || iv !== this.iv;
      if (sym !== this.sym) this.news = {};
      this.sym = sym; this.iv = iv;
      Store.set('ml.lastSym', sym);
      D.want('chart', [sym]);
      $('#cIv', this.el).innerHTML = ivs.map((x) => `<button data-iv="${x}" class="${x === iv ? 'on' : ''}">${IV_LABEL[x]}</button>`).join('');
      $('#cAddPf', this.el).href = `#assets/add/${enc(sym)}`;
      $('#cAddAl', this.el).href = `#alerts/new/${enc(sym)}`;
      this.renderHead();
      if (changed || !this.candles) {
        this.candles = null;
        if (this.chart) { this.chart.remove(); this.chart = null; }
        $('#cLegend', this.el).innerHTML = '';
        $('#cSide', this.el).innerHTML = '';
        this.load(true);
      }
      clearInterval(this.refreshTimer);
      // 분봉 새로고침: 바이낸스·중계는 20~30초, 업비트 직접 호출은 요청 제한 때문에 60초
      const m = D.marketOf(sym), canFast = !D.DAILY.has(iv) && (m === 'binance' || Relay.ok());
      const every = !canFast ? 60e3 : D.IV_SEC[iv] <= 300 ? 20e3 : 30e3;
      this.refreshTimer = setInterval(() => { if (!document.hidden) this.load(false); }, every);
    },
    leave() { D.unwant('chart'); clearInterval(this.refreshTimer); },
    msg(html) { const m = $('#cMsg', this.el); m.hidden = !html; if (html) m.innerHTML = `<div>${html}</div>`; },
    renderToggles() { for (const b of this.el.querySelectorAll('#cTog [data-t]')) b.classList.toggle('on', !!this.tog[b.dataset.t]); },
    renderHead() {
      if (!this.sym) return;
      const m = D.marketOf(this.sym), n = D.nameOf(this.sym), q = Quotes.get(this.sym) || {};
      $('#cMk', this.el).innerHTML = mkBadge(m);
      $('#cName', this.el).textContent = n.name;
      $('#cSub', this.el).textContent = n.sub + (n.ex ? ' · ' + n.ex : '');
      document.title = `${n.name} — 마켓렌즈`;
      const price = q.price ?? (this.candles ? this.candles[this.candles.length - 1].c : null);
      $('#cPrice', this.el).textContent = price == null ? '–' : m === 'us' ? '$' + fmtPrice(price, m) : fmtPrice(price, m) + (m === 'binance' ? ' USDT' : '원');
      $('#cChg', this.el).innerHTML = q.chg != null ? chgHtml(q.chg) : '';
      const extra = [];
      if (m === 'upbit') { D.refreshKimpRef(); const k = D.kimp(n.sub, price); if (k != null) extra.push(`김프 ${fmtPct(k)}`); }
      if (q.live) extra.push(q.status === 'CLOSE' ? '장 마감' : '실시간');
      else if (q.price != null) extra.push('지연 시세');
      $('#cExtra', this.el).textContent = extra.join(' · ');
      const on = Watch.has(this.sym);
      $('#cStar', this.el).textContent = on ? '★ 관심' : '☆ 관심';
    },
    async load(fresh) {
      const { sym, iv } = this, token = ++this.loadSeq;
      if (fresh) this.msg('<span class="spinner"></span> 차트 불러오는 중…');
      try {
        const cs = await D.candles(sym, iv, (sec) => {
          if (fresh && token === this.loadSeq) this.msg(`<span class="spinner"></span> 업비트 요청 제한 때문에 ${sec}초 뒤 불러옵니다`);
        });
        if (token !== this.loadSeq) return;
        if (!cs.length) throw new Error('데이터가 없습니다');
        this.candles = cs;
        this.applyLive();
        this.compute();
        if (fresh || !this.chart) this.buildChart();
        else this.setAll(true);
        this.msg(null);
        this.renderHead();
        if (fresh) this.loadNews();
      } catch (e) {
        if (token !== this.loadSeq || !fresh) return;
        this.msg(e.needRelay
          ? `주식 분봉은 실시간 중계(Worker)를 연결해야 볼 수 있습니다.<br>일·주·월봉은 지금도 볼 수 있어요.<br><br><a class="btn" href="#chart/${enc(sym)}/1d">일봉 보기</a> <a class="btn primary" href="#settings">중계 연결하기</a>`
          : `차트를 불러오지 못했습니다<br><span class="muted small">${esc(e.message)}</span>`);
        if (e.needRelay) this.loadNews();
      }
    },
    // 실시간 시세로 마지막 봉을 갱신하고, 새 봉이 시작됐으면 하나 붙인다
    applyLive() {
      const q = Quotes.get(this.sym), C = this.candles;
      if (!q || !q.live || q.price == null || !C || !C.length) return false;
      const m = D.marketOf(this.sym), iv = this.iv, price = q.price, p = D.IV_SEC[iv];
      let last = C[C.length - 1];
      let barStart = null;
      const nowSec = Date.now() / 1000;
      if (MARKETS[m].coin && p) {
        // 거래소 봉 경계는 UTC 기준 — 분봉은 한국 시간 벽시계로 옮기고(+9시간), 일봉은 UTC 날짜 그대로
        const utcStart = Math.floor(nowSec / p) * p;
        barStart = iv === '1d' ? utcStart : utcStart + 9 * 3600;
      } else if (!MARKETS[m].coin && p && p <= 1800 && q.status === 'OPEN') {
        // 장중 주식 분봉 (30분봉까지는 정시 기준). 국내는 장 마감 뒤 NXT 시간에도 OPEN 이지만
        // 실시간 가격이 정규장 종가에 멈춰 있으니 정규장(09:00~15:30)에만 새 봉을 붙인다
        const kstMin = ((nowSec + 9 * 3600) % 86400) / 60;
        if (m !== 'krx' || (kstMin >= 540 && kstMin < 930)) barStart = Math.floor((nowSec + 9 * 3600) / p) * p;
      }
      if (barStart != null) {
        if (barStart > last.t) {
          last = { t: barStart, o: last.c, h: price, l: price, c: price, v: 0 };
          C.push(last);
        }
      }
      last.c = price;
      if (m === 'upbit' && iv === '1d' && q.high) { last.h = q.high; last.l = q.low; last.o = q.open; last.v = q.accVol ?? last.v; } else {
        last.h = Math.max(last.h, price);
        last.l = Math.min(last.l, price);
      }
      return true;
    },
    compute() {
      this.ind = Ind.series(this.candles);
      this.an = Ind.analyze(this.candles, this.ind, UNIT[this.iv] || '봉');
      this.renderSide();
    },
    onQuotes(changed) {
      if (!changed.has(this.sym)) return;
      this.renderHead();
      if (this.liveTimer || !this.candles) return;
      this.liveTimer = setTimeout(() => {
        this.liveTimer = null;
        if (!this.candles || !this.applyLive()) return;
        this.compute();
        if (this.chart) this.updateLast();
      }, 1000);
    },
    buildChart() {
      if (this.chart) { this.chart.remove(); this.chart = null; }
      const T = chartTheme(), m = D.marketOf(this.sym), daily = D.DAILY.has(this.iv), C = this.candles;
      const dg = digits(C[C.length - 1].c, m);
      const pf = { type: 'custom', minMove: 1 / 10 ** dg, formatter: (p) => fmt(p, dg) };
      const chart = LC.createChart($('#cChart', this.el), {
        autoSize: true,
        layout: { background: { type: LC.ColorType.Solid, color: T.surface }, textColor: T.muted, fontSize: 11, fontFamily: T.font, panes: { separatorColor: T.grid, separatorHoverColor: T.axis, enableResize: true } },
        grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
        rightPriceScale: { borderColor: T.axis },
        timeScale: { borderColor: T.axis, timeVisible: !daily, secondsVisible: false, rightOffset: 4, tickMarkFormatter: tickFmt },
        crosshair: { mode: LC.CrosshairMode.Normal },
        localization: { locale: 'ko-KR', timeFormatter: (t) => timeLabel(t, daily) },
      });
      const s = {};
      s.candle = chart.addSeries(LC.CandlestickSeries, { upColor: T.up, downColor: T.down, wickUpColor: T.up, wickDownColor: T.down, borderVisible: false, priceFormat: pf });
      s.candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: this.tog.vol ? 0.22 : 0.05 } });
      const line = (color, width, pane = 0, extra = {}) => chart.addSeries(LC.LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf, ...extra }, pane);
      if (this.tog.vol) {
        s.vol = chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      }
      if (this.tog.ma) [[5, T.s2], [20, T.s3], [60, T.s4], [120, T.s5]].forEach(([n, c]) => { s['ma' + n] = line(c, 1); });
      if (this.tog.bb) { s.bbUp = line(T.muted, 1); s.bbLo = line(T.muted, 1); }
      let pane = 1;
      if (this.tog.rsi) {
        s.rsi = line(T.s7, 2, pane, { lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
        for (const lv of [70, 30]) s.rsi.createPriceLine({ price: lv, color: T.axis, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
        pane++;
      }
      if (this.tog.macd) {
        const mx = Math.max(...this.ind.macd.filter((x) => x != null).map(Math.abs), 1e-9);
        const md = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(mx))));
        const mf = { type: 'custom', minMove: 1 / 10 ** md, formatter: (p) => fmt(p, md) };
        s.hist = chart.addSeries(LC.HistogramSeries, { priceFormat: mf, priceLineVisible: false, lastValueVisible: false }, pane);
        s.macd = line(T.s2, 2, pane, { priceFormat: mf });
        s.signal = line(T.s3, 2, pane, { priceFormat: mf });
        pane++;
      }
      const panes = chart.panes();
      if (panes.length > 1) { panes[0].setStretchFactor(3); for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1); }
      this.chart = chart; this.s = s; this.T = T;
      this.markers = this.tog.cross ? LC.createSeriesMarkers(s.candle, []) : null;
      this.setAll(false);
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, C.length - (window.innerWidth < 760 ? 80 : 160)), to: C.length + 3 });
      chart.subscribeCrosshairMove((p) => this.renderLegend(p && p.logical != null ? Math.round(p.logical) : null));
      this.renderLegend(null);
    },
    points(key, i) {
      const c = this.candles[i], T = this.T;
      if (key === 'candle') return { time: c.t, open: c.o, high: c.h, low: c.l, close: c.c };
      if (key === 'vol') return { time: c.t, value: c.v, color: hexA(c.c >= c.o ? T.up : T.down, 0.35) };
      if (key === 'hist') { const v = this.ind.macdHist[i]; return v == null ? { time: c.t } : { time: c.t, value: v, color: hexA(v >= 0 ? T.up : T.down, 0.45) }; }
      const v = this.ind[SERIES_KEY[key]][i];
      return v == null ? { time: c.t } : { time: c.t, value: v };
    },
    setAll(keepView) {
      const ts = this.chart.timeScale();
      const range = keepView ? ts.getVisibleLogicalRange() : null;
      const n = this.candles.length;
      for (const key in this.s) this.s[key].setData(this.candles.map((_, i) => this.points(key, i)));
      if (this.markers) {
        const T = this.T;
        this.markers.setMarkers(Ind.crossPoints(this.candles, this.ind.ma5, this.ind.ma20).map((x) => (x.type === 'golden'
          ? { time: x.t, position: 'belowBar', color: T.up, shape: 'arrowUp', text: 'GC' }
          : { time: x.t, position: 'aboveBar', color: T.down, shape: 'arrowDown', text: 'DC' })));
      }
      if (range && this.renderedLen) {
        const shift = n - this.renderedLen;
        ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      }
      this.renderedLen = n;
      this.renderLegend(null);
    },
    updateLast() {
      const n = this.candles.length;
      if (n !== this.renderedLen && n !== this.renderedLen + 1) return this.setAll(true);
      for (const key in this.s) for (let i = Math.max(0, this.renderedLen - 1); i < n; i++) this.s[key].update(this.points(key, i));
      this.renderedLen = n;
      this.renderLegend(null);
    },
    renderLegend(idx) {
      const C = this.candles;
      if (!C || !C.length) return;
      const i = idx == null || idx < 0 || idx >= C.length ? C.length - 1 : idx;
      const c = C[i], prev = C[i - 1], m = D.marketOf(this.sym), T = this.T || chartTheme();
      const ch = prev ? (c.c / prev.c - 1) * 100 : null;
      const f = (x) => fmtPrice(x, m);
      let h = `<span>${timeLabel(c.t, D.DAILY.has(this.iv))}</span><span>시 <b>${f(c.o)}</b></span><span>고 <b>${f(c.h)}</b></span><span>저 <b>${f(c.l)}</b></span><span>종 <b>${f(c.c)}</b> ${ch == null ? '' : `<span class="${dir(ch)}">${fmtPct(ch)}</span>`}</span>`;
      if (this.tog.ma) {
        h += '<span class="lg-ma" style="flex-basis:100%;height:0"></span>';
        for (const [n, col] of [[5, T.s2], [20, T.s3], [60, T.s4], [120, T.s5]]) {
          h += `<span class="lg-ma"><i class="sw" style="background:${col}"></i>MA${n} <b>${f(this.ind['ma' + n][i])}</b></span>`;
        }
      }
      if (this.tog.rsi && this.ind.rsi[i] != null) h += `<span class="lg-ma"><i class="sw" style="background:${T.s7}"></i>RSI <b>${this.ind.rsi[i].toFixed(1)}</b></span>`;
      $('#cLegend', this.el).innerHTML = h;
    },
    renderSide() {
      const a = this.an, side = $('#cSide', this.el);
      if (!a) { side.innerHTML = '<div class="card note">분석하기에 데이터가 부족합니다 (30봉 이상 필요).</div>' + this.newsCard(); return; }
      const m = D.marketOf(this.sym), f = (x) => fmtPrice(x, m), op = a.opinion;
      const pos = ((op.score + 1) / 2) * 100;
      const macdDg = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(Math.max(Math.abs(a.macd || 0), Math.abs(a.macdSignal || 0), 1e-9)))));
      const maRow = (n) => { const v = a.ma[n]; return v == null ? '' : `<dt>MA${n}</dt><dd>${f(v)} <span class="${dir(a.price - v)} small">${fmtPct((a.price / v - 1) * 100, 1)}</span></dd>`; };
      side.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>기술적 의견 · ${IV_LABEL[this.iv]}봉</h2></div>
          <div class="op-label ${opClass(op.label)}">${op.label}</div>
          <div class="gauge" role="img" aria-label="점수 ${op.score}"><i style="left:${pos}%"></i></div>
          <div class="gauge-labels"><span>적극 매도</span><span>중립</span><span>적극 매수</span></div>
          <div class="small ink2" style="margin-top:8px">매수 ${op.buy} · 중립 ${op.neutral} · 매도 ${op.sell} <span class="muted">(이동평균 5개·RSI·MACD·볼린저)</span></div>
          ${a.signals.length ? `<div class="nm" style="margin-top:8px"><div class="sigs">${a.signals.map(sigPill).join('')}</div></div>` : ''}
        </div>
        <div class="card">
          <h2>분석 요약</h2>
          <ul class="notes">${a.notes.map(([t, x]) => `<li><span class="ic ${t}">${t === 'up' ? '▲' : t === 'down' ? '▼' : '●'}</span><span>${esc(x)}</span></li>`).join('')}</ul>
        </div>
        <div class="card">
          <h2>주요 지표</h2>
          <dl class="kv">
            <dt>RSI(14)</dt><dd>${a.rsi == null ? '–' : a.rsi.toFixed(1)}</dd>
            <dt>MACD / 시그널</dt><dd>${a.macd == null ? '–' : `${fmt(a.macd, macdDg)} / ${fmt(a.macdSignal, macdDg)}`}</dd>
            ${maRow(5)}${maRow(20)}${maRow(60)}${maRow(120)}
            <dt>볼린저 상단</dt><dd>${f(a.bb.up)}</dd>
            <dt>볼린저 하단</dt><dd>${f(a.bb.lo)}</dd>
            <dt>거래량 배수</dt><dd>${a.volRatio == null ? '–' : a.volRatio.toFixed(2) + '배'}</dd>
            <dt>${a.lookback}${UNIT[this.iv] || '봉'} 최고</dt><dd>${f(a.high)}</dd>
            <dt>${a.lookback}${UNIT[this.iv] || '봉'} 최저</dt><dd>${f(a.low)}</dd>
          </dl>
        </div>
        ${this.newsCard()}`;
    },
    newsCard() {
      const n = D.nameOf(this.sym), coin = MARKETS[D.marketOf(this.sym)].coin;
      const items = this.news.items;
      let body;
      if (!coin && !Relay.ok()) body = '<p class="note">종목 뉴스는 실시간 중계 연결 후 여기에 표시됩니다.</p>';
      else if (!items) body = '<p class="note"><span class="spinner"></span> 불러오는 중…</p>';
      else if (!items.length) body = '<p class="note">최근 뉴스가 없습니다.</p>';
      else body = `<ul class="news-list">${items.slice(0, 8).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><div class="meta">${esc(x.src)} · ${timeAgo(x.ts * 1000)}</div></li>`).join('')}</ul>`;
      const title = items && items.general ? '코인 주요 뉴스' : `${esc(n.name)} 뉴스`;
      return `<div class="card"><div class="card-head"><h2>${title}</h2><a class="small muted" href="${esc(D.newsMoreUrl(this.sym))}" target="_blank" rel="noopener">더보기 ↗</a></div>${body}</div>`;
    },
    async loadNews() {
      const coin = MARKETS[D.marketOf(this.sym)].coin;
      if ((!coin && !Relay.ok()) || this.news.sym === this.sym) return;
      const sym = this.sym;
      this.news = { sym };
      try {
        const items = await D.symbolNews(sym);
        if (this.sym === sym) { this.news.items = items; this.renderSide(); }
      } catch {
        if (this.sym === sym) { this.news.items = []; this.renderSide(); }
      }
    },
    retheme() { if (this.chart && this.candles) this.buildChart(); },
  };

  // ════════════════════════════════════════════════════
  // 스크리너
  // ════════════════════════════════════════════════════
  const SCR_COLS = {
    name: { label: '종목', get: (r) => r.name, cls: 'name-cell' },
    price: { label: '현재가', get: (r) => r.price, cls: 'hide-sm' },
    chg: { label: '등락률', get: (r) => r.chg, cls: 'chg-cell' },
    vol: { label: '거래대금', get: (r) => r.vol, cls: 'hide-sm' },
    rsi: { label: 'RSI', get: (r) => r.rsi },
    volRatio: { label: '거래량', get: (r) => r.volRatio, cls: 'hide-sm' },
    op: { label: '의견', get: (r) => r.score },
  };
  views.screener = {
    el: $('#view-screener'),
    market: Store.get('ml.scrM', 'upbit'),
    chips: new Set(),
    sort: Store.get('ml.scrSort', { k: 'vol', d: -1 }),
    data: null, built: false, timer: null, renderTimer: null,
    build() {
      this.el.innerHTML = `
        <div class="toolbar">
          <div class="seg" id="sSeg">${Object.keys(MARKETS).map((m) => `<button data-m="${m}">${MARKETS[m].name}</button>`).join('')}</div>
          <span class="muted small grow" id="sStatus"></span>
        </div>
        <div class="chips" id="sChips"></div>
        <div class="toolbar"><span class="note grow" id="sMeta"></span><button class="btn" id="sAlert" disabled>이 신호 새 종목 알림 받기</button></div>
        <div class="table-wrap"><table class="grid" id="sTable"><thead></thead><tbody></tbody></table><div class="empty" id="sEmpty" hidden></div></div>
        <p class="note" style="margin-top:10px">일봉 기준으로 10분마다 다시 계산합니다. 가격·등락률·급등/급락은 실시간 시세를 반영합니다. 거래량은 오늘 거래량 ÷ 최근 20일 평균입니다.</p>`;
      $('#sSeg', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) location.hash = '#screener/' + b.dataset.m; };
      $('#sChips', this.el).onclick = (e) => {
        const b = e.target.closest('[data-s]');
        if (!b) return;
        const k = b.dataset.s;
        if (this.chips.has(k)) this.chips.delete(k); else this.chips.add(k);
        this.render();
      };
      $('#sTable thead', this.el).onclick = (e) => {
        const th = e.target.closest('th[data-k]');
        if (!th) return;
        const k = th.dataset.k;
        this.sort = { k, d: this.sort.k === k ? -this.sort.d : k === 'name' ? 1 : -1 };
        Store.set('ml.scrSort', this.sort);
        this.render();
      };
      $('#sTable tbody', this.el).onclick = (e) => { const tr = e.target.closest('tr[data-sym]'); if (tr) location.hash = `#chart/${enc(tr.dataset.sym)}/1d`; };
      $('#sAlert', this.el).onclick = () => {
        const [sig] = [...this.chips];
        Alerts.add({ kind: 'signal', market: this.market, signal: sig });
        toast('알림을 추가했습니다', `${MARKETS[this.market].name} · ${Ind.SIGNALS[sig][0]} — 새 종목이 생기면 알려 드립니다`);
      };
      this.built = true;
    },
    enter([m]) {
      if (!this.built) this.build();
      if (m && MARKETS[m]) { if (m !== this.market) this.chips.clear(); this.market = m; }
      Store.set('ml.scrM', this.market);
      for (const b of this.el.querySelectorAll('#sSeg button')) b.classList.toggle('on', b.dataset.m === this.market);
      D.want('screener', [this.market + ':*']);
      this.data = null;
      this.render();
      this.load();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.load(), 120e3);
    },
    leave() { D.unwant('screener'); clearInterval(this.timer); },
    async load() {
      const m = this.market;
      try {
        const d = await D.screener(m);
        if (m !== this.market) return;
        for (const r of d.rows) D.remember(r.sym, { name: r.name, sub: r.sub, ex: r.ex });
        this.data = d;
      } catch (e) {
        if (m === this.market) this.data = { error: e.status === 404 ? '아직 계산된 데이터가 없습니다 (첫 수집 대기 중)' : e.message };
      }
      this.render();
    },
    onQuotes() { if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 1000); },
    rows() {
      return (this.data && this.data.rows ? this.data.rows : []).map((r) => {
        const q = Quotes.get(r.sym);
        if (!q || !q.live || q.price == null) return { ...r, m: this.market };
        const sig = r.sig.filter((s) => s !== 'surge' && s !== 'plunge');
        if (q.chg >= Ind.SURGE) sig.unshift('surge'); else if (q.chg <= -Ind.SURGE) sig.unshift('plunge');
        return { ...r, m: this.market, price: q.price, chg: q.chg, vol: q.vol ?? r.vol, sig };
      });
    },
    render() {
      const d = this.data;
      $('#sStatus', this.el).textContent = d && d.updatedAt ? `${timeAgo(Date.parse(d.updatedAt))} 계산 · ${d.count}종목` : '';
      const all = this.rows();
      const counts = {};
      for (const r of all) for (const s of r.sig) counts[s] = (counts[s] || 0) + 1;
      $('#sChips', this.el).innerHTML = Object.entries(Ind.SIGNALS).map(([k, [label, tone]]) =>
        `<button class="chip${this.chips.has(k) ? ' on' : ''}" data-s="${k}">${tone === 'up' ? '▲ ' : tone === 'down' ? '▼ ' : ''}${label}<span class="n">${counts[k] || 0}</span></button>`).join('');
      let rows = all.filter((r) => [...this.chips].every((c) => r.sig.includes(c)));
      const s = this.sort, get = SCR_COLS[s.k] ? SCR_COLS[s.k].get : SCR_COLS.vol.get;
      rows.sort((a, b) => { const x = get(a), y = get(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * s.d; });
      const cols = Object.keys(SCR_COLS);
      $('#sTable thead', this.el).innerHTML = `<tr>${cols.map((k) => `<th data-k="${k}" class="${SCR_COLS[k].cls || ''}${s.k === k ? ' sorted' : ''}">${SCR_COLS[k].label}${s.k === k ? (s.d > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr>`;
      const shown = rows.slice(0, 300);
      $('#sTable tbody', this.el).innerHTML = shown.map((r) => `<tr data-sym="${esc(r.sym)}">
        <td class="name-cell"><div class="nm"><b>${esc(r.name)}</b><span>${esc(r.sub)}${r.ex ? ' · ' + esc(r.ex) : ''}</span>${r.sig.length ? `<div class="sigs">${r.sig.map(sigPill).join('')}</div>` : ''}</div></td>
        <td class="hide-sm">${fmtPrice(r.price, r.m)}</td>
        <td class="chg-cell">${chgHtml(r.chg)}</td>
        <td class="hide-sm">${fmtAmount(r.vol, ccyOf(r.m))}</td>
        <td>${r.rsi == null ? '–' : r.rsi.toFixed(0)}</td>
        <td class="hide-sm">${r.volRatio == null ? '–' : r.volRatio.toFixed(1) + '×'}</td>
        <td><span class="${opClass(r.op)}">${r.op}</span></td></tr>`).join('');
      const empty = $('#sEmpty', this.el);
      empty.hidden = shown.length > 0;
      empty.innerHTML = d && d.error ? esc(d.error) : !d ? '<span class="spinner"></span> 불러오는 중…' : '조건에 맞는 종목이 없습니다';
      $('#sMeta', this.el).textContent = d && d.rows ? `${rows.length}종목${this.chips.size ? ' (선택한 신호 모두 해당)' : ''}` : '';
      $('#sAlert', this.el).disabled = this.chips.size !== 1;
    },
  };

  // ════════════════════════════════════════════════════
  // 뉴스
  // ════════════════════════════════════════════════════
  views.news = {
    el: $('#view-news'),
    topic: Store.get('ml.newsT', 'us'), data: null, built: false,
    build() {
      this.el.innerHTML = `
        <div class="toolbar"><div class="seg" id="nSeg"></div><span class="muted small grow" id="nStatus"></span></div>
        <div class="toolbar">
          <a class="btn" href="https://www.saveticker.com/" target="_blank" rel="noopener">세이브티커 속보 ↗</a>
          <a class="btn" href="https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtdHZHZ0pMVWlnQVAB?hl=ko&gl=KR&ceid=KR:ko" target="_blank" rel="noopener">구글 뉴스 경제 ↗</a>
        </div>
        <div class="card"><ul class="news-list" id="nList"></ul></div>`;
      $('#nSeg', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) location.hash = '#news/' + b.dataset.t; };
      this.built = true;
    },
    async enter([t]) {
      if (!this.built) this.build();
      if (t) this.topic = t;
      Store.set('ml.newsT', this.topic);
      try { this.data = await D.topicNews(); } catch { this.data = null; }
      this.render();
    },
    render() {
      const topics = (this.data && this.data.topics) || [];
      if (!topics.some((x) => x.key === this.topic) && topics.length) this.topic = topics[0].key;
      $('#nSeg', this.el).innerHTML = topics.map((x) => `<button data-t="${x.key}" class="${x.key === this.topic ? 'on' : ''}">${esc(x.label)}</button>`).join('');
      $('#nStatus', this.el).textContent = this.data ? `${timeAgo(Date.parse(this.data.updatedAt))} 수집 · Google 뉴스` : '';
      const tp = topics.find((x) => x.key === this.topic);
      $('#nList', this.el).innerHTML = tp && tp.items.length
        ? tp.items.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><div class="meta">${esc(x.src)} · ${timeAgo(x.ts * 1000)}</div></li>`).join('')
        : `<li class="empty">${this.data ? '뉴스가 없습니다' : '뉴스를 불러오지 못했습니다'}</li>`;
    },
  };

  // ════════════════════════════════════════════════════
  // 내 자산 (포트폴리오)
  // ════════════════════════════════════════════════════
  const MKT_COLOR = { upbit: '--s2', binance: '--s3', krx: '--s4', us: '--s5' }; // 범주형 슬롯 순서대로
  views.assets = {
    el: $('#view-assets'),
    built: false, editing: null, picker: null, renderTimer: null,
    build() {
      this.el.innerHTML = `
        <div class="tiles" id="aTiles"></div>
        <div class="card" id="aAlloc"></div>
        <div class="card">
          <div class="card-head"><h2>보유 종목</h2><span class="muted small" id="aFx"></span></div>
          <form id="aForm" class="form-grid" autocomplete="off">
            <label class="lbl" style="grid-column: span 2">종목<div id="aPick"></div></label>
            <label class="lbl">수량<input class="field" id="aQty" type="number" step="any" min="0" inputmode="decimal" required></label>
            <label class="lbl"><span id="aAvgL">평균 매수가</span><input class="field" id="aAvg" type="number" step="any" min="0" inputmode="decimal" required></label>
            <div style="display:flex;gap:6px"><button class="btn primary" id="aSubmit">추가</button><button type="button" class="btn" id="aCancel" hidden>취소</button><button type="button" class="btn danger" id="aDel" hidden>삭제</button></div>
          </form>
          <div class="table-wrap" style="margin-top:12px;border:0">
            <table class="grid" id="aTable"><thead><tr>
              <th class="nosort">종목</th><th class="nosort hide-sm">수량</th><th class="nosort hide-sm">평균 매수가</th><th class="nosort hide-sm">현재가</th>
              <th class="nosort">평가금액(원)</th><th class="nosort">손익</th><th class="nosort hide-sm">비중</th>
            </tr></thead><tbody></tbody></table>
            <div class="empty" id="aEmpty" hidden>보유 종목을 추가하면 평가금액과 손익을 실시간으로 계산합니다.</div>
          </div>
          <p class="note" style="margin-top:8px">이 기기의 브라우저에만 저장됩니다. 다른 기기로 옮기려면 설정 → 백업 코드를 쓰세요. 달러 자산은 현재 환율로 원화 환산합니다.</p>
        </div>`;
      this.picker = makePicker($('#aPick', this.el), (it) => {
        $('#aAvgL', this.el).textContent = it ? `평균 매수가 (${{ KRW: '원', USD: '달러', USDT: 'USDT' }[ccyOf(it.market)]})` : '평균 매수가';
      });
      $('#aForm', this.el).onsubmit = (e) => { e.preventDefault(); this.submit(); };
      $('#aCancel', this.el).onclick = () => this.edit(null);
      $('#aDel', this.el).onclick = () => {
        if (!this.editing || !confirm('이 종목을 삭제할까요?')) return;
        Portfolio.save(Portfolio.list().filter((x) => x.id !== this.editing));
        this.edit(null);
        this.subscribe();
        this.render();
      };
      $('#aTable tbody', this.el).onclick = (e) => {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-id]');
        if (tr) this.edit(tr.dataset.id);
      };
      this.built = true;
    },
    enter([act, sym]) {
      if (!this.built) this.build();
      this.subscribe();
      if (act === 'add' && sym) { this.edit(null); this.picker.set(pickItem(sym)); $('#aQty', this.el).focus(); }
      this.render();
    },
    leave() { D.unwant('assets'); },
    subscribe() { D.want('assets', [...Portfolio.list().map((x) => x.sym), 'upbit:KRW-USDT']); },
    onQuotes() { if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 800); },
    edit(id) {
      this.editing = id;
      const it = id && Portfolio.list().find((x) => x.id === id);
      this.picker.set(it ? pickItem(it.sym) : null);
      $('#aQty', this.el).value = it ? it.qty : '';
      $('#aAvg', this.el).value = it ? it.avg : '';
      $('#aSubmit', this.el).textContent = it ? '저장' : '추가';
      $('#aCancel', this.el).hidden = $('#aDel', this.el).hidden = !it;
      if (it) $('#aForm', this.el).scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    submit() {
      const it = this.picker.value, qty = parseFloat($('#aQty', this.el).value), avg = parseFloat($('#aAvg', this.el).value);
      if (!it) return toast('종목을 먼저 고르세요');
      if (!(qty > 0) || !(avg >= 0)) return toast('수량과 평균 매수가를 확인하세요');
      const l = Portfolio.list().slice();
      const rec = { id: this.editing || uid(), sym: it.sym, name: it.name, sub: it.sub, qty, avg };
      const i = l.findIndex((x) => x.id === rec.id);
      if (i >= 0) l[i] = rec; else l.push(rec);
      Portfolio.save(l);
      this.edit(null);
      this.subscribe();
      this.render();
    },
    render() {
      const items = Portfolio.list();
      const rows = items.map((it) => {
        const m = D.marketOf(it.sym), q = Quotes.get(it.sym), price = q && q.price, rate = rateOf(m);
        const value = price != null && rate ? it.qty * price * rate : null;
        const cost = rate ? it.qty * it.avg * rate : null;
        const pnl = value != null && cost != null ? value - cost : null;
        return { ...it, m, price, value, cost, pnl, pct: pnl != null && cost ? (pnl / cost) * 100 : null, live: q && q.live };
      });
      const valued = rows.filter((r) => r.value != null);
      const total = valued.reduce((s, r) => s + r.value, 0), cost = valued.reduce((s, r) => s + r.cost, 0);
      const pnl = total - cost, pct = cost ? (pnl / cost) * 100 : null;
      $('#aTiles', this.el).innerHTML = `
        <div class="tile"><div class="k">총 평가금액</div><div class="v">${fmt(total)}원</div><div class="s muted">${valued.length}/${rows.length}종목 시세 반영</div></div>
        <div class="tile"><div class="k">평가손익</div><div class="v ${dir(pnl)}">${pnl > 0 ? '+' : ''}${fmt(pnl)}원</div><div class="s">${chgHtml(pct)}</div></div>
        <div class="tile"><div class="k">총 매입금액</div><div class="v">${fmt(cost)}원</div></div>`;
      $('#aFx', this.el).textContent = FX.usd ? `환율 ${fmt(FX.usd, 2)}원 · USDT ${fmt(D.usdtKrw(), 0)}원` : '환율 불러오는 중';
      // 시장별 비중
      const by = {};
      for (const r of valued) by[r.m] = (by[r.m] || 0) + r.value;
      const parts = Object.keys(MARKETS).filter((m) => by[m] > 0);
      $('#aAlloc', this.el).innerHTML = total > 0
        ? `<h2>시장별 비중</h2><div class="alloc-bar">${parts.map((m) => `<i style="width:${(by[m] / total) * 100}%;background:var(${MKT_COLOR[m]})" title="${MARKETS[m].name}"></i>`).join('')}</div>
           <div class="legend-row">${parts.map((m) => `<span><i class="sq" style="background:var(${MKT_COLOR[m]})"></i>${MARKETS[m].name} <b class="num">${((by[m] / total) * 100).toFixed(1)}%</b> <span class="muted num">${fmtAmount(by[m], 'KRW')}원</span></span>`).join('')}</div>`
        : '<h2>시장별 비중</h2><p class="note">보유 종목을 추가하면 표시됩니다.</p>';
      $('#aTable tbody', this.el).innerHTML = rows.map((r) => {
        const w = total && r.value != null ? (r.value / total) * 100 : null;
        return `<tr data-id="${r.id}">
          <td class="name-cell"><div class="nm"><b>${esc(r.name)}</b><span>${MARKETS[r.m].name} · ${esc(r.sub)}<span class="hide-sm"> · <a href="#chart/${enc(r.sym)}">차트 ›</a></span>${r.live === false ? ' · 지연' : ''}</span></div></td>
          <td class="hide-sm">${fmt(r.qty, r.qty % 1 ? Math.min(8, String(r.qty).split('.')[1].length) : 0)}</td>
          <td class="hide-sm">${fmtPrice(r.avg, r.m)}</td>
          <td class="hide-sm">${r.price == null ? '–' : fmtPrice(r.price, r.m)}</td>
          <td>${r.value == null ? '–' : fmt(r.value)}</td>
          <td><div class="${dir(r.pnl)}">${r.pnl == null ? '–' : (r.pnl > 0 ? '+' : '') + fmt(r.pnl)}</div><div class="small">${chgHtml(r.pct)}</div></td>
          <td class="hide-sm">${w == null ? '–' : `<i class="wbar" style="width:${Math.max(2, w * 0.6)}px"></i>${w.toFixed(1)}%`}</td></tr>`;
      }).join('');
      $('#aEmpty', this.el).hidden = rows.length > 0;
    },
  };

  // ════════════════════════════════════════════════════
  // 알림 — 이 페이지가 열려 있는 동안 10초마다 검사
  // ════════════════════════════════════════════════════
  const CONDS = {
    price_ge: ['가격 이상', '≥'], price_le: ['가격 이하', '≤'],
    chg_ge: ['등락률 이상 (%)', '≥'], chg_le: ['등락률 이하 (%)', '≤'],
    rsi_ge: ['일봉 RSI 이상', '≥'], rsi_le: ['일봉 RSI 이하', '≤'],
  };
  const Alerts = {
    rsiCache: new Map(),
    rules() { return Store.get('ml.alerts', []); },
    save(rules) { Store.set('ml.alerts', rules); this.syncWant(); },
    add(rule) {
      const r = { id: uid(), on: true, created: Date.now(), ...rule };
      if (r.kind === 'sym') { const n = D.nameOf(r.sym); r.name = n.name; r.sub = n.sub; }
      this.save([...this.rules(), r]);
      if (current === 'alerts') views.alerts.render();
    },
    syncWant() { D.want('alerts', this.rules().filter((r) => r.on && r.kind === 'sym').map((r) => r.sym)); },
    log() { return Store.get('ml.alertLog', []); },
    describe(r) {
      if (r.kind === 'signal') return `${MARKETS[r.market].name} · <b>${esc(Ind.SIGNALS[r.signal][0])}</b> 새 종목`;
      const m = D.marketOf(r.sym);
      const v = r.cond.startsWith('price') ? fmtPrice(r.value, m) : r.cond.startsWith('chg') ? fmtPct(r.value, 1) : r.value;
      return `<b>${esc(r.name || D.nameOf(r.sym).name)}</b> ${CONDS[r.cond][0].replace(/ \(%\)| 이상| 이하/g, '')} ${CONDS[r.cond][1]} ${v}`;
    },
    async value(r) {
      const q = Quotes.get(r.sym);
      if (r.cond.startsWith('price')) return q ? q.price : null;
      if (r.cond.startsWith('chg')) return q ? q.chg : null;
      const c = this.rsiCache.get(r.sym);
      if (c && Date.now() - c.at < 10 * 60e3) return c.v;
      try {
        const a = Ind.analyze(await D.candles(r.sym, '1d'));
        this.rsiCache.set(r.sym, { at: Date.now(), v: a ? a.rsi : null });
        return a ? a.rsi : null;
      } catch { return null; }
    },
    async check() {
      const patches = new Map(), now = Date.now();
      for (const r of this.rules()) {
        if (!r.on) continue;
        try {
          if (r.kind === 'sym') {
            if (r.repeat && r.last && now - r.last < (r.cooldown || 60) * 60e3) continue;
            const v = await this.value(r);
            if (v == null) continue;
            if (r.cond.endsWith('_ge') ? v >= r.value : v <= r.value) {
              const m = D.marketOf(r.sym), name = r.name || D.nameOf(r.sym).name;
              const shown = r.cond.startsWith('price') ? fmtPrice(v, m) : r.cond.startsWith('chg') ? fmtPct(v) : v.toFixed(1);
              this.fire(`${name} ${CONDS[r.cond][0].split(' ')[0].replace('일봉', 'RSI')} ${shown}`, `조건: ${this.describe(r).replace(/<[^>]+>/g, '')}`, r.sym);
              patches.set(r.id, { last: now, on: !!r.repeat });
            }
          } else {
            const d = await D.screener(r.market);
            if (r.stamp === d.updatedAt) continue; // 새로 계산된 결과가 나왔을 때만
            const cur = d.rows.filter((x) => x.sig.includes(r.signal));
            if (r.seen) {
              const fresh = cur.filter((x) => !r.seen.includes(x.sym));
              if (fresh.length) {
                this.fire(`${MARKETS[r.market].name} · ${Ind.SIGNALS[r.signal][0]} 새 종목 ${fresh.length}개`, fresh.slice(0, 6).map((x) => x.name).join(', ') + (fresh.length > 6 ? ' 외' : ''), fresh[0].sym);
              }
            }
            patches.set(r.id, { seen: cur.map((x) => x.sym), stamp: d.updatedAt });
          }
        } catch { /* 다음 검사 때 다시 */ }
      }
      if (!patches.size) return;
      // 검사하는 동안 화면에서 규칙을 고쳤을 수 있으니 최신 목록에 덮어쓴다
      this.save(this.rules().map((r) => (patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r)));
      if (current === 'alerts') views.alerts.render();
    },
    fire(title, body, sym) {
      const log = [{ ts: Date.now(), title, body, sym }, ...this.log()].slice(0, 100);
      Store.set('ml.alertLog', log);
      Store.set('ml.unread', Store.get('ml.unread', 0) + 1);
      renderBadge();
      toast(title, body, () => { location.hash = `#chart/${enc(sym)}`; });
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(title, { body, tag: 'ml-' + sym }); } catch { /* 일부 모바일 브라우저는 미지원 */ }
      }
    },
    start() { this.syncWant(); setInterval(() => { if (!document.hidden) this.check(); }, 10e3); setTimeout(() => this.check(), 3000); },
  };
  function renderBadge() {
    const n = Store.get('ml.unread', 0), b = $('#bellBadge');
    b.hidden = !n;
    b.textContent = n > 9 ? '9+' : n;
  }

  views.alerts = {
    el: $('#view-alerts'),
    built: false, kind: 'sym', picker: null,
    build() {
      const sigOpts = Object.entries(Ind.SIGNALS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('');
      this.el.innerHTML = `
        <div class="two-col">
          <div>
            <div class="card">
              <div class="card-head"><h2>새 알림</h2><div class="seg small" id="lKind"><button data-k="sym">종목 조건</button><button data-k="signal">스크리너 신호</button></div></div>
              <form id="lForm" class="form-grid" autocomplete="off">
                <label class="lbl k-sym" style="grid-column:1/-1">종목<div id="lPick"></div></label>
                <label class="lbl k-sym">조건<select class="field" id="lCond">${Object.entries(CONDS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
                <label class="lbl k-sym">값<input class="field" id="lVal" type="number" step="any" inputmode="decimal"></label>
                <label class="lbl k-signal">시장<select class="field" id="lMkt">${Object.keys(MARKETS).map((m) => `<option value="${m}">${MARKETS[m].name}</option>`).join('')}</select></label>
                <label class="lbl k-signal">신호<select class="field" id="lSig">${sigOpts}</select></label>
                <div class="k-sym note" style="grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="lRep"> 조건이 계속되면 반복해서 알림</label><span>— 간격 <input class="field" id="lCool" type="number" min="1" value="60" style="width:64px;padding:4px 6px"> 분</span></div>
                <div><button class="btn primary">추가</button></div>
              </form>
              <p class="note" id="lHint" style="margin-top:8px"></p>
            </div>
            <div class="card"><h2>알림 규칙</h2><div id="lRules"></div></div>
          </div>
          <div>
            <div class="card"><div class="card-head"><h2>최근 발생</h2><button class="btn" id="lClear">지우기</button></div><div id="lLog"></div></div>
            <div class="card">
              <h2>알림 받는 방법</h2>
              <p class="note">이 페이지가 열려 있는 동안 10초마다 조건을 검사하고 화면 오른쪽 아래에 알려 줍니다. 탭을 닫거나 휴대폰 화면이 꺼지면 검사도 멈춥니다.</p>
              <div id="lNotif" style="margin-top:8px"></div>
            </div>
          </div>
        </div>`;
      $('#lKind', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) { this.kind = b.dataset.k; this.renderForm(); } };
      this.picker = makePicker($('#lPick', this.el), () => this.renderHint());
      $('#lCond', this.el).onchange = () => this.renderHint();
      $('#lForm', this.el).onsubmit = (e) => { e.preventDefault(); this.submit(); };
      $('#lClear', this.el).onclick = () => { Store.set('ml.alertLog', []); this.render(); };
      this.el.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { Alerts.save(Alerts.rules().filter((r) => r.id !== del.dataset.del)); this.render(); }
      });
      this.el.addEventListener('change', (e) => {
        const t = e.target.closest('[data-tog]');
        if (t) { Alerts.save(Alerts.rules().map((r) => (r.id === t.dataset.tog ? { ...r, on: t.checked, last: null } : r))); this.render(); }
      });
      this.built = true;
    },
    enter([act, sym]) {
      if (!this.built) this.build();
      Store.set('ml.unread', 0);
      renderBadge();
      if (act === 'new' && sym) { this.kind = 'sym'; this.picker.set(pickItem(sym)); }
      this.renderForm();
      this.render();
    },
    renderForm() {
      for (const b of this.el.querySelectorAll('#lKind button')) b.classList.toggle('on', b.dataset.k === this.kind);
      for (const el of this.el.querySelectorAll('.k-sym')) el.hidden = this.kind !== 'sym';
      for (const el of this.el.querySelectorAll('.k-signal')) el.hidden = this.kind !== 'signal';
      this.renderHint();
    },
    renderHint() {
      const h = $('#lHint', this.el);
      if (this.kind === 'signal') { h.textContent = '스크리너가 10분마다 다시 계산될 때, 이 신호에 새로 들어온 종목이 있으면 알려 줍니다.'; return; }
      const it = this.picker && this.picker.value;
      if (!it) { h.textContent = ''; return; }
      D.want('alerts-form', [it.sym]);
      const q = Quotes.get(it.sym), cond = $('#lCond', this.el).value;
      h.textContent = !q ? '현재 시세 불러오는 중…' : cond.startsWith('price') ? `현재가 ${fmtPrice(q.price, it.market)}` : cond.startsWith('chg') ? `현재 등락률 ${fmtPct(q.chg)}` : 'RSI는 일봉 기준 14일입니다 (30 이하 과매도, 70 이상 과매수).';
    },
    onQuotes() { if (this.kind === 'sym' && this.picker && this.picker.value) this.renderHint(); },
    leave() { D.unwant('alerts-form'); },
    submit() {
      if (this.kind === 'signal') {
        Alerts.add({ kind: 'signal', market: $('#lMkt', this.el).value, signal: $('#lSig', this.el).value });
      } else {
        const it = this.picker.value, v = parseFloat($('#lVal', this.el).value);
        if (!it) return toast('종목을 먼저 고르세요');
        if (!Number.isFinite(v)) return toast('값을 입력하세요');
        Alerts.add({ kind: 'sym', sym: it.sym, cond: $('#lCond', this.el).value, value: v, repeat: $('#lRep', this.el).checked, cooldown: Math.max(1, parseInt($('#lCool', this.el).value, 10) || 60) });
        $('#lVal', this.el).value = '';
      }
      toast('알림을 추가했습니다');
      this.render();
    },
    render() {
      const rules = Alerts.rules();
      $('#lRules', this.el).innerHTML = rules.length ? rules.map((r) => `
        <div class="rule${r.on ? '' : ' off'}">
          <label class="switch"><input type="checkbox" data-tog="${r.id}" ${r.on ? 'checked' : ''}><span></span></label>
          <div class="desc">${Alerts.describe(r)}<div class="small muted">${r.kind === 'sym' ? (r.repeat ? `반복 · ${r.cooldown}분 간격` : '한 번 울리면 꺼짐') : '스크리너 갱신 때마다'}${r.last ? ` · 마지막 ${timeAgo(r.last)}` : ''}</div></div>
          <button class="btn" data-del="${r.id}" aria-label="삭제">삭제</button>
        </div>`).join('') : '<p class="note">아직 알림이 없습니다.</p>';
      const log = Alerts.log();
      $('#lLog', this.el).innerHTML = log.length ? log.slice(0, 30).map((x) => `<div class="log-item"><b>${esc(x.title)}</b><div class="ink2">${esc(x.body)}</div><div class="small muted">${new Date(x.ts).toLocaleString('ko-KR')}${x.sym ? ` · <a href="#chart/${enc(x.sym)}">차트 ›</a>` : ''}</div></div>`).join('') : '<p class="note">아직 울린 알림이 없습니다.</p>';
      const nb = $('#lNotif', this.el);
      if (!('Notification' in window)) nb.innerHTML = '<p class="note">이 브라우저는 시스템 알림을 지원하지 않아 화면 안 알림만 표시합니다.</p>';
      else if (Notification.permission === 'granted') nb.innerHTML = '<p class="note">✓ 브라우저 알림이 허용되어 있어 다른 탭을 보고 있어도 알림이 뜹니다.</p>';
      else {
        nb.innerHTML = '<button class="btn" id="lPerm">브라우저 알림 허용</button>';
        $('#lPerm', nb).onclick = () => Notification.requestPermission().then(() => this.render());
      }
    },
  };

  // ════════════════════════════════════════════════════
  // 설정
  // ════════════════════════════════════════════════════
  views.settings = {
    el: $('#view-settings'),
    built: false,
    build() {
      const c = Relay.mode() === 'custom' ? Relay.cfg() : {};
      this.el.innerHTML = `
        <div class="two-col">
          <div>
            <div class="card">
              <div class="card-head"><h2>실시간 중계</h2><span class="small" id="gState"></span></div>
              <p class="note">주식 실시간 시세·차트·종목 뉴스는 네이버 증권에서 받는데, 다른 사이트에서 바로 부르면 막혀서 이 사이트 전용 중계 서버(Cloudflare Worker)를 거칩니다. 기본으로 연결돼 있어 어느 기기에서든 따로 설정할 필요가 없습니다.</p>
              <div style="display:flex;gap:6px;margin-top:10px"><button class="btn primary" id="gCheck">지금 연결 확인</button></div>
              <div class="status-line" id="gMsg"></div>
              <details style="margin-top:12px"><summary class="note" style="cursor:pointer">고급 — 다른 중계 쓰기 · 끄기</summary>
                <div class="form-grid" style="margin-top:10px">
                  <label class="lbl" style="grid-column:1/-1">Worker 주소<input class="field" id="gUrl" placeholder="비워 두면 기본 중계" value="${esc(c.url || '')}" autocapitalize="off" spellcheck="false"></label>
                  <label class="lbl">접근 키 (ACCESS_KEY, 이 사이트에서 쓰면 필요 없음)<input class="field" id="gKey" type="password" value="${esc(c.key || '')}" autocapitalize="off" spellcheck="false"></label>
                  <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn" id="gTest">저장하고 확인</button><button class="btn" id="gReset">기본값으로</button><button class="btn" id="gOff">중계 끄기</button></div>
                </div>
                <ol class="steps">
                  <li>새 Worker 만들기: Cloudflare <b>Workers &amp; Pages → Create → Worker</b> → Hello World → Deploy</li>
                  <li><b>Edit code</b> → 기존 코드를 지우고 [Worker 코드 복사]로 복사한 내용을 붙여넣기 → <b>Deploy</b></li>
                  <li>이 사이트 주소에서 온 요청만 받으므로 키 없이도 됩니다. 다른 곳에서도 쓰려면 Settings → Variables and Secrets 에 Secret <code>ACCESS_KEY</code> 추가</li>
                </ol>
                <button class="btn" id="gCopyCode" style="margin-top:6px">Worker 코드 복사</button>
              </details>
            </div>
            <div class="card">
              <h2>다른 기기로 옮기기</h2>
              <p class="note">관심종목·보유자산·알림은 이 브라우저에만 저장됩니다. 백업 코드를 만들어 다른 기기의 설정 화면에 붙여넣으면 똑같이 옮겨집니다. (사파리는 사이트를 7일 넘게 안 열면 저장값을 지울 수 있으니 백업 코드를 메모해 두면 좋습니다.)</p>
              <div style="display:flex;gap:6px;margin:10px 0"><button class="btn" id="gExport">백업 코드 만들기</button><button class="btn" id="gImport">붙여넣은 코드 적용</button></div>
              <textarea class="field code-box" id="gCode" placeholder="여기에 백업 코드를 붙여넣고 [붙여넣은 코드 적용]"></textarea>
            </div>
          </div>
          <div>
            <div class="card">
              <h2>화면</h2>
              <div class="seg" id="gTheme"><button data-t="auto">기기 설정 따라감</button><button data-t="light">밝게</button><button data-t="dark">어둡게</button></div>
            </div>
            <div class="card">
              <h2>데이터 상태</h2>
              <dl class="kv" id="gData"></dl>
              <p class="note" style="margin-top:10px">코인 시세는 업비트·바이낸스에서 직접 실시간으로, 스크리너·주요 뉴스는 GitHub Actions가 약 10분마다 새로 만듭니다.</p>
            </div>
          </div>
        </div>`;
      const check = async (cfg) => {
        const msg = $('#gMsg', this.el);
        msg.className = 'status-line';
        msg.innerHTML = '<span class="spinner"></span> 확인 중…';
        const r = await Relay.test(cfg);
        msg.className = 'status-line ' + (r.ok ? 'ok' : 'bad');
        msg.textContent = (r.ok ? '✓ ' : '✕ ') + r.msg;
        this.renderState();
      };
      $('#gCheck', this.el).onclick = () => check(null);
      $('#gTest', this.el).onclick = () => {
        const url = $('#gUrl', this.el).value.trim();
        if (!url) { Relay.save(null); return check(null); }
        return check({ url, key: $('#gKey', this.el).value });
      };
      $('#gReset', this.el).onclick = () => { Relay.save(null); $('#gUrl', this.el).value = ''; $('#gKey', this.el).value = ''; check(null); };
      $('#gOff', this.el).onclick = () => {
        Relay.save({ off: true });
        const msg = $('#gMsg', this.el);
        msg.className = 'status-line';
        msg.textContent = '중계를 껐습니다 — 주식은 10~20분 지연 데이터로 보입니다';
        this.renderState();
      };
      $('#gCopyCode', this.el).onclick = async () => {
        try {
          const code = await (await fetch('worker.js', { cache: 'no-store' })).text();
          await navigator.clipboard.writeText(code);
          toast('Worker 코드를 복사했습니다', 'Cloudflare 편집기에 붙여넣으세요');
        } catch { window.open('worker.js', '_blank'); }
      };
      $('#gExport', this.el).onclick = () => {
        const data = { v: 1, watch: Watch.list(), portfolio: Portfolio.list(), alerts: Alerts.rules(), relay: Relay.saved() };
        const code = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
        const ta = $('#gCode', this.el);
        ta.value = code;
        ta.select();
        if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('백업 코드를 복사했습니다', '휴대폰의 설정 화면에 붙여넣으세요'), () => {});
      };
      $('#gImport', this.el).onclick = () => {
        try {
          const d = JSON.parse(decodeURIComponent(escape(atob($('#gCode', this.el).value.trim()))));
          if (d.v !== 1) throw new Error('형식이 다릅니다');
          if (!confirm('지금 기기의 관심종목·보유자산·알림을 백업 내용으로 바꿀까요?')) return;
          if (Array.isArray(d.watch)) Watch.save(d.watch);
          if (Array.isArray(d.portfolio)) Portfolio.save(d.portfolio);
          if (Array.isArray(d.alerts)) Alerts.save(d.alerts);
          if (d.relay) Relay.save(d.relay);
          for (const x of [...Watch.list(), ...Portfolio.list()]) D.remember(x.sym, { name: x.name, sub: x.sub });
          toast('백업을 적용했습니다');
          this.built = false;
          this.enter();
        } catch (e) { toast('백업 코드를 읽지 못했습니다', e.message); }
      };
      $('#gTheme', this.el).onclick = (e) => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.t); };
      this.built = true;
    },
    enter() {
      if (!this.built) this.build();
      this.renderState();
      this.renderData();
    },
    renderState() {
      for (const b of this.el.querySelectorAll('#gTheme button')) b.classList.toggle('on', b.dataset.t === Store.get('ml.theme', 'auto'));
      const mode = Relay.mode();
      $('#gState', this.el).innerHTML = mode === 'off' ? '<span class="muted">꺼짐</span>'
        : `<span class="ok status-line" style="margin:0">● ${mode === 'default' ? '기본 중계 사용 중' : '직접 입력한 중계'}</span>`;
      updateBanner();
    },
    async renderData() {
      const kv = $('#gData', this.el);
      try {
        const m = await D.meta();
        const errs = Object.entries(m.errors || {});
        kv.innerHTML = `<dt>마지막 수집</dt><dd>${new Date(m.updatedAt).toLocaleString('ko-KR')} (${timeAgo(Date.parse(m.updatedAt))})</dd>
          <dt>수집 소요</dt><dd>${m.secs}초</dd>
          <dt>수집 오류</dt><dd>${errs.length ? errs.map(([k, v]) => `${MARKETS[k] ? MARKETS[k].name : k}: ${esc(v)}`).join('<br>') : '없음'}</dd>`;
      } catch { kv.innerHTML = '<dt>마지막 수집</dt><dd>아직 없음</dd>'; }
    },
  };

  // ── 테마 ──────────────────────────────────────────────
  function setTheme(t) {
    Store.set('ml.theme', t);
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    if (current === 'settings') views.settings.renderState();
    views.chart.retheme();
  }
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => views.chart.retheme());

  // ── 시작 ──────────────────────────────────────────────
  async function boot() {
    // ?relay=주소&key=키 로 열면 중계 설정을 저장하고 주소창에서 지운다
    const qs = new URLSearchParams(location.search);
    if (qs.get('relay')) {
      Relay.save({ url: qs.get('relay'), key: qs.get('key') || '' });
      history.replaceState(null, '', location.pathname + location.hash);
    }
    $('#topTabs').innerHTML = NAV.map(([v, l]) => `<a href="#${v}" data-v="${v}">${l}</a>`).join('');
    for (const x of [...Watch.list(), ...Portfolio.list()]) D.remember(x.sym, { name: x.name, sub: x.sub });
    renderBadge();
    await D.loadCoins();
    D.onQuotes((changed) => { const v = views[current]; if (v && v.onQuotes) v.onQuotes(changed); });
    window.addEventListener('hashchange', route);
    route();
    pollOverview();
    Alerts.start();
  }
  boot();
})();
