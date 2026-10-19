// 기술적 지표와 신호 — collector/indicators.py 와 같은 계산 (스크리너와 차트 값이 같아야 한다)
// 모든 시계열 함수는 입력과 길이가 같은 배열을 돌려주고, 아직 계산되지 않는 앞부분은 null 이다.
(function (root) {
  'use strict';

  const MA_PERIODS = [5, 20, 60, 120];
  const SURGE = 5; // 급등/급락 기준 등락률(%)
  const VOL_SPIKE = 3; // 거래량 급증 기준 (20봉 평균 대비 배수)
  const CROSS_LOOKBACK = 3; // 최근 몇 봉 안의 크로스를 신호로 볼지

  // [이름, 성격] 성격: up = 상승 쪽 신호, down = 하락 쪽 신호, flat = 방향 없음
  const SIGNALS = {
    surge: ['급등', 'up'], plunge: ['급락', 'down'], vol_spike: ['거래량 급증', 'flat'],
    rsi_os: ['RSI 과매도', 'up'], rsi_ob: ['RSI 과매수', 'down'],
    golden: ['골든크로스', 'up'], dead: ['데드크로스', 'down'],
    align_up: ['정배열', 'up'], align_down: ['역배열', 'down'],
    bb_up: ['볼린저 상단 돌파', 'up'], bb_down: ['볼린저 하단 이탈', 'down'],
    macd_up: ['MACD 상향 돌파', 'up'], macd_down: ['MACD 하향 돌파', 'down'],
    new_high: ['신고가', 'up'], new_low: ['신저가', 'down'],
  };

  function sum(xs) {
    let s = 0;
    for (const x of xs) s += x;
    return s;
  }

  function sma(xs, n) {
    const out = new Array(xs.length).fill(null);
    let s = 0;
    for (let i = 0; i < xs.length; i++) {
      s += xs[i];
      if (i >= n) s -= xs[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  // 앞쪽 null 은 건너뛰고, 처음 n 개 평균으로 시작
  function ema(xs, n) {
    const out = new Array(xs.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    const seed = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (x == null) continue;
      if (prev == null) {
        seed.push(x);
        if (seed.length === n) { prev = sum(seed) / n; out[i] = prev; }
        continue;
      }
      prev = x * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder 방식
  function rsi(c, n = 14) {
    const out = new Array(c.length).fill(null);
    if (c.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = c[i] - c[i - 1];
      gain += Math.max(d, 0);
      loss += Math.max(-d, 0);
    }
    let ag = gain / n, al = loss / n;
    const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
    out[n] = val();
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      ag = (ag * (n - 1) + Math.max(d, 0)) / n;
      al = (al * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = val();
    }
    return out;
  }

  function macd(c, fast = 12, slow = 26, sig = 9) {
    const ef = ema(c, fast), es = ema(c, slow);
    const line = ef.map((a, i) => (a != null && es[i] != null ? a - es[i] : null));
    const signal = ema(line, sig);
    const hist = line.map((a, i) => (a != null && signal[i] != null ? a - signal[i] : null));
    return [line, signal, hist];
  }

  function bollinger(c, n = 20, k = 2) {
    const mid = new Array(c.length).fill(null), up = mid.slice(), lo = mid.slice();
    for (let i = n - 1; i < c.length; i++) {
      const w = c.slice(i - n + 1, i + 1);
      const m = sum(w) / n;
      let v = 0;
      for (const x of w) v += (x - m) * (x - m);
      const sd = Math.sqrt(v / n);
      mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
    }
    return [mid, up, lo];
  }

  function series(candles) {
    const c = candles.map((x) => x.c);
    const out = {};
    for (const n of MA_PERIODS) out['ma' + n] = sma(c, n);
    [out.bbMid, out.bbUp, out.bbLo] = bollinger(c);
    out.rsi = rsi(c);
    [out.macd, out.macdSignal, out.macdHist] = macd(c);
    return out;
  }

  // 최근 lookback 봉 안에 a 가 b 를 위로(+1)/아래로(-1) 뚫었으면 [방향, 몇 봉 전]. 없으면 [0, null]
  function crossed(a, b, lookback = CROSS_LOOKBACK) {
    const n = a.length;
    for (let back = 0; back < lookback; back++) {
      const i = n - 1 - back;
      if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) break;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return [1, back];
      if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return [-1, back];
    }
    return [0, null];
  }

  // 차트 표시용: 전 구간의 크로스 지점
  function crossPoints(candles, a, b) {
    const out = [];
    for (let i = 1; i < candles.length; i++) {
      if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) out.push({ t: candles[i].t, type: 'golden' });
      else if (a[i - 1] >= b[i - 1] && a[i] < b[i]) out.push({ t: candles[i].t, type: 'dead' });
    }
    return out;
  }

  // 이동평균 5개 + RSI + MACD + 볼린저로 매수/매도 표를 세는 요약 의견
  function opinion(c, r, m, s, bbUp, bbLo) {
    const last = c[c.length - 1];
    const votes = [];
    for (const n of [5, 10, 20, 60, 120]) {
      if (c.length >= n) votes.push(last > sum(c.slice(-n)) / n ? 1 : -1);
    }
    if (r != null) votes.push(r < 30 ? 1 : r > 70 ? -1 : 0);
    if (m != null && s != null) votes.push(m > s ? 1 : -1);
    if (bbUp != null) votes.push(last < bbLo ? 1 : last > bbUp ? -1 : 0);
    const buy = votes.filter((v) => v === 1).length;
    const sell = votes.filter((v) => v === -1).length;
    const score = votes.length ? (buy - sell) / votes.length : 0;
    const label = score >= 0.5 ? '적극 매수' : score >= 0.15 ? '매수' : score <= -0.5 ? '적극 매도' : score <= -0.15 ? '매도' : '중립';
    return { score: Math.round(score * 1000) / 1000, label, buy, sell, neutral: votes.length - buy - sell };
  }

  const ago = (k) => (k === 0 ? '이번 봉' : `${k}봉 전`);
  const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

  // unit: '일' / '주' / '개월' / '봉' — 분석 문장에 쓰는 봉 단위
  function analyze(candles, ind, unit = '봉') {
    if (!candles || candles.length < 30) return null;
    ind = ind || series(candles);
    const c = candles.map((x) => x.c), v = candles.map((x) => x.v);
    const N = c.length, last = c[N - 1], prev = c[N - 2];
    const L = (k) => ind[k][N - 1];
    const chg = prev ? (last / prev - 1) * 100 : 0;
    const ma = {};
    for (const n of MA_PERIODS) ma[n] = L('ma' + n);
    const r = L('rsi'), m = L('macd'), s = L('macdSignal'), h = L('macdHist');
    const up = L('bbUp'), mid = L('bbMid'), lo = L('bbLo');
    const base = v.slice(-21, -1);
    const avgV = base.length ? sum(base) / base.length : 0;
    const volRatio = avgV ? v[N - 1] / avgV : null;
    const look = Math.min(N - 1, 250);
    const prior = candles.slice(-look - 1, -1);
    let priorHigh = -Infinity, priorLow = Infinity;
    for (const x of prior) { if (x.h > priorHigh) priorHigh = x.h; if (x.l < priorLow) priorLow = x.l; }
    const hi = Math.max(priorHigh, candles[N - 1].h), low = Math.min(priorLow, candles[N - 1].l);

    const sig = [];
    if (chg >= SURGE) sig.push('surge');
    if (chg <= -SURGE) sig.push('plunge');
    if (volRatio != null && volRatio >= VOL_SPIKE) sig.push('vol_spike');
    if (r != null && r <= 30) sig.push('rsi_os');
    if (r != null && r >= 70) sig.push('rsi_ob');
    const [gx, gxAgo] = crossed(ind.ma5, ind.ma20);
    if (gx) sig.push(gx > 0 ? 'golden' : 'dead');
    const allMa = MA_PERIODS.every((n) => ma[n] != null);
    const alignUp = allMa && ma[5] > ma[20] && ma[20] > ma[60] && ma[60] > ma[120];
    const alignDown = allMa && ma[5] < ma[20] && ma[20] < ma[60] && ma[60] < ma[120];
    if (alignUp) sig.push('align_up');
    else if (alignDown) sig.push('align_down');
    if (up != null && last > up) sig.push('bb_up');
    if (lo != null && last < lo) sig.push('bb_down');
    const [mx, mxAgo] = crossed(ind.macd, ind.macdSignal);
    if (mx) sig.push(mx > 0 ? 'macd_up' : 'macd_down');
    if (candles[N - 1].h > priorHigh) sig.push('new_high');
    if (candles[N - 1].l < priorLow) sig.push('new_low');

    // ── 사람이 읽는 요약 (tone: up/down/flat) ──
    const notes = [];
    if (alignUp) notes.push(['up', `이동평균 정배열 (5 > 20 > 60 > 120${unit}) — 상승 추세`]);
    else if (alignDown) notes.push(['down', `이동평균 역배열 (5 < 20 < 60 < 120${unit}) — 하락 추세`]);
    else if (ma[20] != null) {
      const d = (last / ma[20] - 1) * 100;
      notes.push([d >= 0 ? 'up' : 'down', `가격이 20${unit} 이동평균보다 ${Math.abs(d).toFixed(1)}% ${d >= 0 ? '위' : '아래'}`]);
    }
    if (gx) notes.push([gx > 0 ? 'up' : 'down', `5·20${unit}선 ${gx > 0 ? '골든' : '데드'}크로스 (${ago(gxAgo)})`]);
    if (r != null) {
      const zone = r >= 70 ? '과매수 구간 — 단기 과열' : r <= 30 ? '과매도 구간 — 반등 여지' : r >= 50 ? '중립 위쪽 (매수세 우위)' : '중립 아래쪽 (매도세 우위)';
      notes.push([r >= 70 ? 'down' : r <= 30 ? 'up' : 'flat', `RSI ${r.toFixed(1)} — ${zone}`]);
    }
    if (m != null && s != null) {
      if (mx) notes.push([mx > 0 ? 'up' : 'down', `MACD가 시그널선을 ${mx > 0 ? '상향' : '하향'} 돌파 (${ago(mxAgo)})`]);
      else {
        const hp = ind.macdHist[N - 2];
        const trend = hp != null ? (Math.abs(h) > Math.abs(hp) ? '강해지는 중' : '약해지는 중') : '';
        notes.push([m > s ? 'up' : 'down', `MACD ${m > s ? '>' : '<'} 시그널 — ${m > s ? '상승' : '하락'} 모멘텀 ${trend}`.trim()]);
      }
    }
    if (up != null) {
      if (last > up) notes.push(['up', '볼린저밴드 상단 돌파 — 강한 추세 또는 과열']);
      else if (last < lo) notes.push(['down', '볼린저밴드 하단 이탈 — 급락 또는 과매도']);
      else notes.push(['flat', `볼린저밴드 안 ${Math.round(((last - lo) / (up - lo || 1)) * 100)}% 위치 (0% 하단 · 100% 상단)`]);
      const widths = [];
      for (let i = Math.max(0, N - 120); i < N; i++) {
        if (ind.bbMid[i]) widths.push((ind.bbUp[i] - ind.bbLo[i]) / ind.bbMid[i]);
      }
      const wNow = mid ? (up - lo) / mid : null;
      if (widths.length >= 60 && wNow != null && wNow <= Math.min(...widths) * 1.1) {
        notes.push(['flat', `밴드폭이 최근 ${widths.length}${unit} 중 최저 수준 — 변동성 수축, 큰 움직임 전조일 수 있음`]);
      }
    }
    if (volRatio != null) {
      notes.push([volRatio >= 2 ? 'up' : 'flat', `거래량 20${unit} 평균 대비 ${volRatio.toFixed(1)}배${volRatio >= VOL_SPIKE ? ' — 급증' : ''}`]);
    }
    notes.push(['flat', `${look}${unit} 최고가 대비 ${pct((last / hi - 1) * 100)} · 최저가 대비 ${pct((last / low - 1) * 100)}`]);

    return {
      price: last, chg, rsi: r, macd: m, macdSignal: s, macdHist: h, volRatio,
      ma, bb: { up, mid, lo }, high: hi, low, lookback: look,
      signals: sig, opinion: opinion(c, r, m, s, up, lo), notes,
    };
  }

  root.Ind = { MA_PERIODS, SURGE, SIGNALS, sma, ema, rsi, macd, bollinger, series, crossed, crossPoints, opinion, analyze };
})(typeof window !== 'undefined' ? window : globalThis);
