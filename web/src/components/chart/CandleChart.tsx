// 캔들 차트 (lightweight-charts v5) — 차트는 종목·주기·지표·테마·모양이 바뀔 때만 새로 만들고,
// 실시간 갱신은 바뀐 봉만 update 해서 깜빡임 없이 부드럽게 움직인다.
//  - 캔들 / 라인(영역) 모양 전환 (마지막 선택 기억) — 차트 위 별도 줄(범례 줄) 왼쪽
//  - 처음 그릴 때 왼쪽에서 오른쪽으로 그려지듯 나타나고, 실시간 가격은 마지막 봉이 미끄러지듯 따라간다
//  - 실시간이면 현재가 끝점이 작은 점 + 퍼지는 고리로 숨 쉰다 (라인은 차트 기본 애니메이션)
//  - 보이는 구간의 최고·최저 가격 표시 (스크롤·확대하면 따라 바뀐다)
//  - prefers-reduced-motion 이면 움직임을 모두 끈다
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LastPriceAnimationMode, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type LineWidth, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@/lib/utils';
import { crossPoints, type IndicatorSeries } from '@/lib/indicators';
import { DAILY, IV_SEC, MARKETS, Store, type Candle, type Interval, type Market, type PredictSymbol } from '@/lib/market';
import { digits, fmt, tickLabel, timeLabel } from '@/lib/format';
import { cssVar, useResolvedTheme } from '@/lib/theme';
import { roundTick } from '@/components/chart/OrderBook';
import type { IndToggles } from '@/stores';

type AnySeries = ISeriesApi<SeriesType>;
export type ChartKind = 'candle' | 'line';
const LINE_KEYS = ['ma5', 'ma20', 'ma60', 'ma120', 'bbUp', 'bbLo', 'rsi', 'macd', 'signal'] as const;
const IND_OF: Record<(typeof LINE_KEYS)[number], keyof IndicatorSeries> = {
  ma5: 'ma5', ma20: 'ma20', ma60: 'ma60', ma120: 'ma120', bbUp: 'bbUp', bbLo: 'bbLo', rsi: 'rsi', macd: 'macd', signal: 'macdSignal',
};
const MA_NS = [5, 20, 60, 120] as const;
/** '#rrggbb' · 'rgb(…)' → 투명도를 준 rgba (그 밖의 형식은 그대로) */
const hexA = (col: string, a: number) => {
  const h = col.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(h)) {
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = col.match(/^rgba?\(([^,]+),([^,]+),([^,)]+)/);
  return m ? `rgba(${m[1].trim()},${m[2].trim()},${m[3].trim()},${a})` : col;
};
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 마지막 봉이 새 가격으로 미끄러지는 시간 (실시간 반영은 0.25초 단위로 묶여 온다) */
const GLIDE_MS = 280;

/** 어제(직전 봉) 대비 방향 — 라인 색. 분봉은 날짜가 바뀌기 전 마지막 종가와 비교 (t 는 현지 벽시계 시각) */
function dayDir(cs: Candle[], daily: boolean): number {
  const n = cs.length;
  if (n < 2) return 0;
  const last = cs[n - 1];
  if (daily) return Math.sign(last.c - cs[n - 2].c);
  const day = Math.floor(last.t / 86400);
  for (let i = n - 2; i >= 0; i--) if (Math.floor(cs[i].t / 86400) !== day) return Math.sign(last.c - cs[i].c);
  return Math.sign(last.c - cs[0].o);
}

export interface CandleChartProps {
  market: Market; iv: Interval; candles: Candle[]; ind: IndicatorSeries; toggles: IndToggles;
  forecast?: PredictSymbol | null;
  /** 바깥 틀 (범례 줄 + 차트) */
  className?: string;
  /** 차트 영역 높이 — 예: 'h-[420px] lg:h-[600px]' */
  boxClassName?: string;
  /** 지금 거래 중인가 (끝점 깜빡임) — 없으면 코인은 항상, 주식 분봉은 마지막 봉이 최근이면 */
  live?: boolean;
  /** 등락 방향 (+1 / -1 / 0) — 라인 색 · 현재가 선. 없으면 차트 데이터로 계산 */
  dir?: number;
}

export function CandleChart({ market, iv, candles, ind, toggles, forecast, className, boxClassName, live, dir }: CandleChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const hiRef = useRef<HTMLDivElement>(null);
  const loRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Record<string, AnySeries>>({});
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const renderedRef = useRef<{ len: number; first: number; last: number; close: number }>({ len: 0, first: 0, last: 0, close: 0 });
  const colorsRef = useRef<Record<string, string> | null>(null);
  const glideRef = useRef<{ raf: number; v: number | null }>({ raf: 0, v: null });
  const revealedRef = useRef('');
  const dataRef = useRef({ candles, ind });
  dataRef.current = { candles, ind };
  const [hover, setHover] = useState<number | null>(null);
  const [kind, setKindState] = useState<ChartKind>(() => (Store.get<string>('ml.chartKind', 'candle') === 'line' ? 'line' : 'candle'));
  const setKind = (k: ChartKind) => { setKindState(k); Store.set('ml.chartKind', k); };
  const theme = useResolvedTheme();
  const daily = DAILY.has(iv);
  const showForecast = !!(forecast && iv === '1d' && toggles.forecast && forecast.cone?.length);
  const togKey = `${toggles.ma}${toggles.bb}${toggles.vol}${toggles.rsi}${toggles.macd}${toggles.cross}${showForecast}`;
  // 가격 자릿수는 차트를 다시 만들 때만 정한다
  const dg = useMemo(() => digits(candles[candles.length - 1]?.c, market), [market, iv, candles.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastT = candles.length ? candles[candles.length - 1].t : 0;
  const isLive = live ?? (MARKETS[market].coin || (!daily && Date.now() / 1000 + 9 * 3600 - lastT < 2 * (IV_SEC[iv] ?? 60) + 90));
  const direction = dir ?? dayDir(candles, daily);
  const liveRef = useRef(isLive);
  liveRef.current = isLive;
  const togRef = useRef(toggles);
  togRef.current = toggles;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  // 캔들 모양일 때 현재가 끝점 (차트 좌표로 옮긴다) — v: 미끄러지는 중인 가격
  const placeDot = (v?: number) => {
    const chart = chartRef.current, s = seriesRef.current.candle, el = dotRef.current, w = box.current?.clientWidth || 0;
    if (!el) return;
    const last = dataRef.current.candles[dataRef.current.candles.length - 1];
    if (!chart || !s || !last || kindRef.current !== 'candle' || !liveRef.current) { el.style.opacity = '0'; return; }
    const x = chart.timeScale().timeToCoordinate(last.t as UTCTimestamp);
    const y = s.priceToCoordinate(v ?? glideRef.current.v ?? last.c);
    const plotW = w - chart.priceScale('right').width();
    if (x == null || y == null || x < 0 || x > plotW) { el.style.opacity = '0'; return; }
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.opacity = '1';
  };
  // 골든/데드크로스 표시 (켜져 있을 때) — 넓은 화면에서만 글자를 붙인다
  const updateMarks = () => {
    const plugin = markersRef.current, C = colorsRef.current;
    const { candles: cs, ind: I } = dataRef.current;
    if (!plugin || !C) return;
    const marks: SeriesMarker<Time>[] = [];
    const words = (box.current?.clientWidth || 0) >= 600;
    if (togRef.current.cross && cs.length) {
      for (const x of crossPoints(cs, I.ma5, I.ma20)) {
        marks.push(x.type === 'golden'
          ? { time: x.t as UTCTimestamp, position: 'belowBar', color: C.up, shape: 'arrowUp', text: words ? '골든' : '' }
          : { time: x.t as UTCTimestamp, position: 'aboveBar', color: C.down, shape: 'arrowDown', text: words ? '데드' : '' });
      }
    }
    plugin.setMarkers(marks);
  };
  // 보이는 구간의 최고·최저 — 점 옆에 글자를 붙이고, 오른쪽 끝에 가까우면 왼쪽에 붙인다 (스크롤·확대·실시간마다)
  const placeExtremes = () => {
    const chart = chartRef.current, s = seriesRef.current.candle, hiEl = hiRef.current, loEl = loRef.current, root = box.current;
    if (!hiEl || !loEl) return;
    const hide = () => { hiEl.style.opacity = '0'; loEl.style.opacity = '0'; };
    const cs = dataRef.current.candles, n = cs.length;
    if (!chart || !s || n < 2 || !root) return hide();
    const line = kindRef.current === 'line';
    const r = chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.ceil(r?.from ?? 0)), to = Math.min(n - 1, Math.floor(r?.to ?? n - 1));
    if (to - from < 8) return hide();
    let hi = from, lo = from;
    const H = (i: number) => (line ? cs[i].c : cs[i].h), L = (i: number) => (line ? cs[i].c : cs[i].l);
    for (let i = from; i <= to; i++) { if (H(i) > H(hi)) hi = i; if (L(i) < L(lo)) lo = i; }
    if (hi === lo) return hide();
    const plotW = root.clientWidth - chart.priceScale('right').width();
    // 차트 왼쪽 위에 겹쳐 놓인 것(data-overlay)과 겹치거나 위 끝에 닿으면 최고 글자를 점 아래로
    const rr = root.getBoundingClientRect();
    let oRight = 0, oBottom = 0;
    for (const o of Array.from(root.parentElement?.querySelectorAll<HTMLElement>('[data-overlay]') ?? [])) {
      const b = o.getBoundingClientRect();
      if (!b.width) continue;
      oRight = Math.max(oRight, b.right - rr.left); oBottom = Math.max(oBottom, b.bottom - rr.top);
    }
    const put = (el: HTMLDivElement, i: number, v: number, top: boolean) => {
      const x = chart.timeScale().timeToCoordinate(cs[i].t as UTCTimestamp), y = s.priceToCoordinate(v);
      if (x == null || y == null || x < 0 || x > plotW) { el.style.opacity = '0'; return; }
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.opacity = '1';
      el.dataset.side = x > plotW - 140 ? 'left' : 'right';
      const clash = top && ((y - 10 < oBottom + 2 && x < oRight + 150) || y < 14);
      el.dataset.v = clash ? 'below' : 'mid';
      const t = el.querySelector('b');
      if (t) t.textContent = fmt(v, dg);
    };
    put(hiEl, hi, H(hi), true);
    put(loEl, lo, L(lo), false);
  };
  const stopGlide = () => { if (glideRef.current.raf) cancelAnimationFrame(glideRef.current.raf); glideRef.current = { raf: 0, v: null }; };

  // ── 차트 만들기 ──
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const v = (name: string, fb = '') => cssVar(name) || fb;
    const dark = theme === 'dark';
    const C = {
      card: v('--card'), muted: v('--muted-foreground'), border: v('--border'), faint: v('--faint'), subtle: v('--subtle'),
      grid: v('--grid', dark ? '#27272f' : '#f2f4f6'),
      up: v('--up'), down: v('--down'), upText: v('--up-text'), downText: v('--down-text'), fg: v('--foreground'), fg2: v('--secondary-foreground'),
      c1: v('--chart-1'), c2: v('--chart-2'), c3: v('--chart-3'), c4: v('--chart-4'), c5: v('--chart-5'), ai: v('--ai', v('--chart-5')),
      font: getComputedStyle(document.body).fontFamily,
    };
    const narrow = el.clientWidth < 640;
    const maW = (narrow ? 1.3 : 1.8) as LineWidth; // 그리는 쪽은 소수 굵기를 그대로 쓴다
    const pf = { type: 'custom' as const, minMove: 1 / 10 ** dg, formatter: (p: number) => fmt(p, dg) };
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.card }, textColor: C.muted, fontSize: 11, fontFamily: C.font, attributionLogo: false, panes: { separatorColor: C.border, separatorHoverColor: C.subtle, enableResize: true } },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
      rightPriceScale: { borderVisible: false, minimumWidth: 84 },
      timeScale: { borderVisible: false, timeVisible: !daily, secondsVisible: false, rightOffset: showForecast ? 2 : 6, shiftVisibleRangeOnNewBar: true, tickMarkFormatter: (t: Time, type: number) => tickLabel(t as number, type) },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.subtle, labelBackgroundColor: C.fg2 }, horzLine: { color: C.subtle, labelBackgroundColor: C.fg2 } },
      localization: { locale: 'ko-KR', timeFormatter: (t: Time) => timeLabel(t as number, daily) },
    });
    const tag = direction > 0 ? C.upText : direction < 0 ? C.downText : C.fg2;
    const nowLine = { priceLineColor: tag, priceLineStyle: LineStyle.Dotted, priceLineWidth: 1 as LineWidth };
    const s: Record<string, AnySeries> = {};
    if (kind === 'line') {
      const col = direction > 0 ? C.up : direction < 0 ? C.down : C.fg;
      s.candle = chart.addSeries(AreaSeries, {
        lineColor: col, topColor: hexA(col, 0.22), bottomColor: hexA(col, 0), lineWidth: 2, priceFormat: pf, ...nowLine,
        crosshairMarkerRadius: 4, crosshairMarkerBorderColor: C.card,
        lastPriceAnimation: isLive && !reduceMotion() ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled,
      });
    } else {
      s.candle = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false, priceFormat: pf, ...nowLine });
    }
    s.candle.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: toggles.vol ? 0.21 : 0.06 } });
    const line = (color: string, width: LineWidth, pane = 0, extra: Record<string, unknown> = {}) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf, ...extra }, pane);
    if (toggles.vol) {
      s.vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.81, bottom: 0 }, visible: false });
    }
    if (toggles.ma) { s.ma5 = line(C.c1, maW); s.ma20 = line(C.c2, maW); s.ma60 = line(C.c3, maW); s.ma120 = line(C.c4, maW); }
    if (toggles.bb) { s.bbUp = line(C.faint, 1); s.bbLo = line(C.faint, 1); }
    if (showForecast) {
      // AI 예측: 지평 동안 예상 경로의 10·50·90% 분위 (점선, AI 보라)
      s.fq50 = line(C.ai, 2, 0, { lineStyle: LineStyle.Dashed, lastValueVisible: true, title: '예측 중앙값' });
      s.fq90 = line(hexA(C.ai, 0.55), 1, 0, { lineStyle: LineStyle.Dotted, lastValueVisible: false });
      s.fq10 = line(hexA(C.ai, 0.55), 1, 0, { lineStyle: LineStyle.Dotted, lastValueVisible: false });
    }
    let pane = 1;
    const stretch: number[] = [4];
    if (toggles.rsi) {
      s.rsi = line(C.c5, 2, pane, { lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      for (const lv of [70, 30]) s.rsi.createPriceLine({ price: lv, color: C.faint, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      stretch.push(1.1);
      pane++;
    }
    if (toggles.macd) {
      const mx = Math.max(...dataRef.current.ind.macd.filter((x): x is number => x != null).map(Math.abs), 1e-9);
      const md = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(mx))));
      const mf = { type: 'custom' as const, minMove: 1 / 10 ** md, formatter: (p: number) => fmt(p, md) };
      s.hist = chart.addSeries(HistogramSeries, { priceFormat: mf, priceLineVisible: false, lastValueVisible: false }, pane);
      s.macd = line(C.fg2, 2, pane, { priceFormat: mf });
      s.signal = line(C.c3, 2, pane, { priceFormat: mf });
      stretch.push(1.35);
      pane++;
    }
    // 패널 비율 — 가격(거래량 겹침) 4 · RSI 1.1 · MACD 1.35
    const panes = chart.panes();
    if (panes.length > 1) panes.forEach((p, i) => p.setStretchFactor(stretch[i] ?? 1));
    chartRef.current = chart;
    seriesRef.current = s;
    colorsRef.current = { ...C, volA: String(dark ? 0.36 : 0.28) };
    markersRef.current = createSeriesMarkers(s.candle, []);
    renderedRef.current = { len: 0, first: 0, last: 0, close: 0 };
    chart.subscribeCrosshairMove((p) => setHover(p.logical != null && p.point ? Math.round(p.logical) : null));
    // 스크롤·확대·크기 변경 때 최고·최저 표시와 끝점 위치를 다시 (한 프레임에 한 번)
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeExtremes(); placeDot(); }); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(later);
    const ro = new ResizeObserver(later);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      stopGlide();
      ro.disconnect();
      chart.remove();
      chartRef.current = null; seriesRef.current = {}; markersRef.current = null;
    };
  }, [market, iv, togKey, theme, dg, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 라인 색·현재가 선 색·끝점 애니메이션은 차트를 다시 만들지 않고 바꾼다
  useEffect(() => {
    const s = seriesRef.current.candle, C = colorsRef.current;
    if (!s || !C) return;
    const tag = direction > 0 ? C.upText : direction < 0 ? C.downText : C.fg2;
    if (kind !== 'line') { s.applyOptions({ priceLineColor: tag }); return; }
    const col = direction > 0 ? C.up : direction < 0 ? C.down : C.fg;
    s.applyOptions({ priceLineColor: tag, lineColor: col, topColor: hexA(col, 0.22), bottomColor: hexA(col, 0), lastPriceAnimation: isLive && !reduceMotion() ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled } as never);
  }, [direction, isLive, kind, theme, market, iv, togKey]);

  // ── 데이터 넣기 (전체 또는 마지막 봉만) ──
  useEffect(() => {
    const chart = chartRef.current, s = seriesRef.current, C = colorsRef.current;
    if (!chart || !s.candle || !candles.length || !C) return;
    const line = kind === 'line';
    const volA = Number(C.volA) || 0.28;
    const point = (key: string, i: number) => {
      const c = candles[i], time = c.t as UTCTimestamp;
      if (key === 'candle') return line ? { time, value: c.c } : { time, open: c.o, high: c.h, low: c.l, close: c.c };
      if (key === 'vol') return { time, value: c.v, color: hexA(c.c >= c.o ? C.up : C.down, volA) };
      if (key === 'hist') { const v = ind.macdHist[i]; return v == null ? { time } : { time, value: v, color: hexA(v >= 0 ? C.up : C.down, 0.45) }; }
      const v = ind[IND_OF[key as (typeof LINE_KEYS)[number]]][i];
      return v == null ? { time } : { time, value: v };
    };
    const keys = Object.keys(s).filter((k) => !k.startsWith('fq'));
    const r = renderedRef.current, n = candles.length;
    const sameStart = r.len && candles[0].t === r.first;
    const incremental = sameStart && (n === r.len || n === r.len + 1) && candles[r.len - 1]?.t === r.last;
    if (incremental) {
      // 같은 봉 안의 가격 변화는 마지막 봉을 짧게 미끄러뜨린다 (새 봉이 생기면 바로)
      const glide = n === r.len && !reduceMotion();
      for (const key of keys) {
        if (key === 'candle' && glide) continue;
        for (let i = Math.max(0, r.len - 1); i < n; i++) s[key].update(point(key, i) as never);
      }
      if (glide) {
        const c = candles[n - 1], time = c.t as UTCTimestamp, series = s.candle;
        const from = glideRef.current.v ?? r.close;
        const prevRaf = glideRef.current.raf;
        if (prevRaf) cancelAnimationFrame(prevRaf);
        const to = c.c;
        if (from === to) { series.update(point('candle', n - 1) as never); glideRef.current = { raf: 0, v: null }; }
        else {
          const t0 = performance.now();
          const step = (now: number) => {
            if (chartRef.current !== chart) return;
            const p = Math.min(1, (now - t0) / GLIDE_MS), e = 1 - (1 - p) ** 3;
            const v = p >= 1 ? to : from + (to - from) * e;
            series.update((line ? { time, value: v } : { time, open: c.o, high: c.h, low: c.l, close: v }) as never);
            placeDot(v);
            glideRef.current = { raf: p >= 1 ? 0 : requestAnimationFrame(step), v: p >= 1 ? null : v };
          };
          glideRef.current = { raf: requestAnimationFrame(step), v: from };
        }
      } else stopGlide();
    } else {
      stopGlide();
      const ts = chart.timeScale();
      const range = r.len ? ts.getVisibleLogicalRange() : null;
      for (const key of keys) s[key].setData(candles.map((_, i) => point(key, i)) as never);
      if (range && sameStart) ts.setVisibleLogicalRange({ from: range.from + (n - r.len), to: range.to + (n - r.len) });
      else if (!r.len) ts.setVisibleLogicalRange({ from: Math.max(0, n - (window.innerWidth < 760 ? 90 : 160)), to: n + (showForecast ? (forecast?.horizon || 20) + 2 : 4) });
      // 처음 그릴 때(종목·주기·모양이 바뀔 때) 왼쪽에서 오른쪽으로 그려지듯 나타난다
      const key = `${market}|${iv}|${kind}|${candles[0].t}`;
      if (!r.len && revealedRef.current !== key) {
        revealedRef.current = key;
        if (!reduceMotion()) {
          box.current?.animate(
            [{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }, { clipPath: 'inset(0 0% 0 0)', opacity: 1 }],
            { duration: 650, easing: 'cubic-bezier(.22,.8,.24,1)' },
          );
        }
      }
    }
    const grew = n !== r.len;
    renderedRef.current = { len: n, first: candles[0].t, last: candles[n - 1].t, close: candles[n - 1].c };
    if (grew || !incremental) updateMarks(); // 같은 봉 안의 실시간 갱신은 크로스 표시를 다시 계산하지 않는다
    placeExtremes();
    placeDot();
  }, [candles, ind, togKey, theme, market, iv, dg, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { placeDot(); placeExtremes(); }, [isLive, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 끝점 고리 — 1.6초마다 퍼졌다 사라진다 (움직임 줄이기 설정이면 없음)
  useEffect(() => {
    const el = ringRef.current;
    if (!el || reduceMotion() || typeof el.animate !== 'function') return;
    const a = el.animate([{ transform: 'scale(1)', opacity: 0.6 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 1600, iterations: Infinity, easing: 'cubic-bezier(0,0,.2,1)' });
    return () => a.cancel();
  }, []);

  // ── 예측 경로 (마지막 종가에서 이어서 미래 날짜로) ──
  useEffect(() => {
    const s = seriesRef.current;
    if (!showForecast || !s.fq50 || !candles.length || !forecast) return;
    const last = candles[candles.length - 1];
    const stock = !MARKETS[market].coin;
    const times: number[] = [];
    let t = last.t;
    for (let d = 1; d <= forecast.cone.length; d++) {
      t += 86400;
      if (stock) while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86400; // 주말 건너뛰기
      times.push(t);
    }
    const mk = (k: 'q10' | 'q50' | 'q90') => [{ time: last.t as UTCTimestamp, value: last.c }, ...forecast.cone.map((c, i) => ({ time: times[i] as UTCTimestamp, value: last.c * (1 + c[k]) }))];
    s.fq50.setData(mk('q50'));
    s.fq90.setData(mk('q90'));
    s.fq10.setData(mk('q10'));
  }, [forecast, showForecast, candles.length > 0 ? candles[candles.length - 1].t : 0, togKey, theme, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 범례 줄 — 평소엔 마지막 봉, 십자선을 올리면 그 봉의 값 ──
  const hovering = hover != null && hover >= 0 && hover < candles.length;
  const i = hovering ? hover : candles.length - 1;
  const c = candles[i], prev = candles[i - 1];
  const ch = c && prev ? Math.round((c.c / prev.c - 1) * 10000) / 100 : null;
  const f = (x: number | null | undefined) => fmt(x, dg);
  const fm = (x: number | null | undefined) => (x == null ? '–' : fmt(roundTick(x, market), dg));
  const dotColor = direction > 0 ? 'var(--up)' : direction < 0 ? 'var(--down)' : 'var(--foreground)';
  const extreme = (ref: React.RefObject<HTMLDivElement | null>, label: string) => (
    <div ref={ref} aria-hidden className="group pointer-events-none absolute top-0 left-0 z-[4] size-0 opacity-0 transition-opacity duration-200">
      <span className="absolute -top-[2.5px] -left-[2.5px] size-[5px] rounded-full bg-secondary-foreground" />
      <span className={cn('absolute -top-[9px] text-[11px] leading-[18px] font-semibold whitespace-nowrap text-secondary-foreground [text-shadow:0_0_2px_var(--card),0_0_3px_var(--card),0_0_4px_var(--card)]',
        'group-data-[side=right]:left-[7px] group-data-[side=left]:right-[7px] group-data-[v=below]:top-[4px]')}>
        {label} <b className="tabular font-semibold" />
      </span>
    </div>
  );
  const chTone = ch == null || ch === 0 ? 'text-muted-foreground' : ch > 0 ? 'text-up-text' : 'text-down-text';
  return (
    <div className={cn('flex flex-col', className)}>
      {/* 범례 줄 — 차트 위에 겹치지 않게 따로 (선이 글자를 지나지 않게) */}
      <div className="flex min-h-[44px] items-start gap-x-3 gap-y-1 px-4 pb-1.5 md:px-5">
        <div role="radiogroup" aria-label="차트 모양" className="flex h-[26px] shrink-0 rounded-[8px] bg-secondary p-[2px]">
          {(['candle', 'line'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn('press rounded-[6px] px-2.5 text-[12.5px] font-semibold transition-colors',
                kind === k ? 'bg-[var(--seg-on,var(--background))] text-foreground shadow-[0_1px_2px_rgba(0,23,51,.08),0_2px_6px_rgba(0,23,51,.05)] dark:shadow-none' : 'text-muted-foreground hover:text-foreground')}>
              {k === 'candle' ? '캔들' : '라인'}
            </button>
          ))}
        </div>
        {c ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 pt-[3px] text-[12px] leading-[18px] text-muted-foreground tabular" aria-live="off">
            <span className="font-semibold text-secondary-foreground">{timeLabel(c.t, daily)}</span>
            {kind === 'candle' ? <>
              <span>시 <b className="font-semibold text-foreground">{f(c.o)}</b></span>
              <span>고 <b className="font-semibold text-foreground">{f(c.h)}</b></span>
              <span>저 <b className="font-semibold text-foreground">{f(c.l)}</b></span>
            </> : null}
            <span>
              {kind === 'candle' ? '종 ' : '종가 '}<b className="font-semibold text-foreground">{f(c.c)}</b>
              {ch != null ? (
                <span className={cn('ml-1.5 font-semibold', chTone)}>
                  {ch !== 0 ? <span aria-hidden className="mr-px text-[0.75em]">{ch > 0 ? '▲' : '▼'}</span> : null}
                  {ch !== 0 ? <span className="sr-only">{ch > 0 ? '상승 ' : '하락 '}</span> : null}
                  {Math.abs(ch).toFixed(2)}%
                </span>
              ) : null}
            </span>
            {toggles.ma ? (
              <span className="flex basis-full flex-wrap gap-x-3 gap-y-0.5">
                {MA_NS.map((n, k) => (
                  <span key={n} className="inline-flex items-center gap-[5px]">
                    <i aria-hidden className="inline-block h-[3px] w-2.5 rounded-full" style={{ background: `var(--chart-${k + 1})` }} />MA{n}
                    <b className="font-semibold text-foreground max-sm:hidden">{fm(ind[`ma${n}`][i])}</b>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={cn('min-h-0 pl-2 md:pl-3', boxClassName ?? 'flex-1')}>
        <div className="relative h-full">
          <div ref={box} className="h-full w-full" />
          {extreme(hiRef, '최고')}
          {extreme(loRef, '최저')}
          {/* 캔들 모양의 실시간 끝점 — 작은 점(방향색, 카드색 테) + 퍼지는 고리 */}
          <div ref={dotRef} aria-hidden className="pointer-events-none absolute top-0 left-0 z-[5] size-0 opacity-0 transition-opacity duration-300" style={{ ['--dot' as string]: dotColor }}>
            <span ref={ringRef} className="absolute -top-[3px] -left-[3px] size-1.5 rounded-full bg-[var(--dot)] opacity-0" />
            <span className="absolute -top-[3px] -left-[3px] size-1.5 rounded-full bg-[var(--dot)] shadow-[0_0_0_2px_var(--card)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
