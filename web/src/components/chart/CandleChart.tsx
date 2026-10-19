// 캔들 차트 (lightweight-charts v5) — 차트는 종목·주기·지표·테마·모양이 바뀔 때만 새로 만들고,
// 실시간 갱신은 바뀐 봉만 update 해서 깜빡임 없이 부드럽게 움직인다.
//  - 캔들 / 라인(영역) 모양 전환 (마지막 선택 기억)
//  - 실시간이면 현재가 끝점이 숨 쉬듯 깜빡인다 (라인은 차트 기본 애니메이션, 캔들은 겹친 점)
//  - 보이는 구간의 최고·최저 가격 표시 (스크롤·확대하면 따라 바뀐다)
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LastPriceAnimationMode, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@/lib/utils';
import { crossPoints, type IndicatorSeries } from '@/lib/indicators';
import { DAILY, IV_SEC, MARKETS, Store, type Candle, type Interval, type Market, type PredictSymbol } from '@/lib/market';
import { digits, fmt, fmtPct, tickLabel, timeLabel } from '@/lib/format';
import { cssVar, useResolvedTheme } from '@/lib/theme';
import type { IndToggles } from '@/stores';

type AnySeries = ISeriesApi<SeriesType>;
export type ChartKind = 'candle' | 'line';
const LINE_KEYS = ['ma5', 'ma20', 'ma60', 'ma120', 'bbUp', 'bbLo', 'rsi', 'macd', 'signal'] as const;
const IND_OF: Record<(typeof LINE_KEYS)[number], keyof IndicatorSeries> = {
  ma5: 'ma5', ma20: 'ma20', ma60: 'ma60', ma120: 'ma120', bbUp: 'bbUp', bbLo: 'bbLo', rsi: 'rsi', macd: 'macd', signal: 'macdSignal',
};
const hexA = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

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
  forecast?: PredictSymbol | null; className?: string; height?: number | string;
  /** 지금 거래 중인가 (끝점 깜빡임) — 없으면 코인은 항상, 주식 분봉은 마지막 봉이 최근이면 */
  live?: boolean;
  /** 등락 방향 (+1 / -1 / 0) — 라인 색. 없으면 차트 데이터로 계산 */
  dir?: number;
}

export function CandleChart({ market, iv, candles, ind, toggles, forecast, className, live, dir }: CandleChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const hiRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const loRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Record<string, AnySeries>>({});
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const renderedRef = useRef<{ len: number; first: number; last: number }>({ len: 0, first: 0, last: 0 });
  const colorsRef = useRef<Record<string, string> | null>(null);
  const dataRef = useRef({ candles, ind });
  dataRef.current = { candles, ind };
  const [hover, setHover] = useState<number | null>(null);
  const [kind, setKindState] = useState<ChartKind>(() => (Store.get<string>('ml.chartKind', 'candle') === 'line' ? 'line' : 'candle'));
  const setKind = (k: ChartKind) => { setKindState(k); Store.set('ml.chartKind', k); };
  const [shown, setShown] = useState(false); // 처음 데이터가 들어오면 살짝 나타나게
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

  // 캔들 모양일 때 현재가 끝점 (차트 좌표로 옮긴다)
  const placeDot = () => {
    const chart = chartRef.current, s = seriesRef.current.candle, el = dotRef.current, w = box.current?.clientWidth || 0;
    if (!el) return;
    const last = dataRef.current.candles[dataRef.current.candles.length - 1];
    if (!chart || !s || !last || kindRef.current !== 'candle' || !liveRef.current) { el.style.opacity = '0'; return; }
    const x = chart.timeScale().timeToCoordinate(last.t as UTCTimestamp);
    const y = s.priceToCoordinate(last.c);
    const plotW = w - chart.priceScale('right').width();
    if (x == null || y == null || x < 0 || x > plotW) { el.style.opacity = '0'; return; }
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.opacity = '1';
  };
  // 골든/데드크로스 표시 (켜져 있을 때)
  const updateMarks = () => {
    const plugin = markersRef.current, C = colorsRef.current;
    const { candles: cs, ind: I } = dataRef.current;
    if (!plugin || !C) return;
    const marks: SeriesMarker<Time>[] = [];
    if (togRef.current.cross && cs.length) {
      for (const x of crossPoints(cs, I.ma5, I.ma20)) {
        marks.push(x.type === 'golden'
          ? { time: x.t as UTCTimestamp, position: 'belowBar', color: C.up, shape: 'arrowUp', text: 'GC' }
          : { time: x.t as UTCTimestamp, position: 'aboveBar', color: C.down, shape: 'arrowDown', text: 'DC' });
      }
    }
    plugin.setMarkers(marks);
  };
  // 보이는 구간의 최고·최저 — 점 옆에 글자를 붙이고, 오른쪽 끝에 가까우면 왼쪽에 붙인다 (스크롤·확대·실시간마다)
  const placeExtremes = () => {
    const chart = chartRef.current, s = seriesRef.current.candle, hiEl = hiRef.current, loEl = loRef.current;
    if (!hiEl || !loEl) return;
    const hide = () => { hiEl.style.opacity = '0'; loEl.style.opacity = '0'; };
    const cs = dataRef.current.candles, n = cs.length;
    if (!chart || !s || n < 2) return hide();
    const line = kindRef.current === 'line';
    const r = chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.ceil(r?.from ?? 0)), to = Math.min(n - 1, Math.floor(r?.to ?? n - 1));
    if (to - from < 8) return hide();
    let hi = from, lo = from;
    const H = (i: number) => (line ? cs[i].c : cs[i].h), L = (i: number) => (line ? cs[i].c : cs[i].l);
    for (let i = from; i <= to; i++) { if (H(i) > H(hi)) hi = i; if (L(i) < L(lo)) lo = i; }
    if (hi === lo) return hide();
    const plotW = (box.current?.clientWidth || 0) - chart.priceScale('right').width();
    const put = (el: HTMLDivElement, i: number, v: number) => {
      const x = chart.timeScale().timeToCoordinate(cs[i].t as UTCTimestamp), y = s.priceToCoordinate(v);
      if (x == null || y == null || x < 0 || x > plotW) { el.style.opacity = '0'; return; }
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.opacity = '1';
      el.dataset.side = x > plotW - 140 ? 'left' : 'right';
      // 왼쪽 위의 모양 전환·범례와 겹치면 글자를 점 아래로
      let below = false;
      const bar = barRef.current, root = rootRef.current;
      if (bar && root) {
        const rr = root.getBoundingClientRect();
        let right = 0, bottom = 0;
        for (const ch of Array.from(bar.children)) { const r = ch.getBoundingClientRect(); right = Math.max(right, r.right - rr.left); bottom = Math.max(bottom, r.bottom - rr.top); }
        below = y - 10 < bottom + 2 && x < right + 150;
      }
      el.dataset.v = below ? 'below' : 'mid';
      const t = el.querySelector('b');
      if (t) t.textContent = fmt(v, dg);
    };
    put(hiEl, hi, H(hi));
    put(loEl, lo, L(lo));
  };

  // ── 차트 만들기 ──
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const C = {
      card: cssVar('--card'), muted: cssVar('--muted-foreground'), border: cssVar('--border'), subtle: cssVar('--subtle'),
      up: cssVar('--up'), down: cssVar('--down'), upText: cssVar('--up-text'), downText: cssVar('--down-text'), fg: cssVar('--foreground'),
      c1: cssVar('--chart-1'), c2: cssVar('--chart-2'), c3: cssVar('--chart-3'), c4: cssVar('--chart-4'), c5: cssVar('--chart-5'),
      primary: cssVar('--primary'), font: getComputedStyle(document.body).fontFamily,
    };
    const pf = { type: 'custom' as const, minMove: 1 / 10 ** dg, formatter: (p: number) => fmt(p, dg) };
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.card }, textColor: C.muted, fontSize: 11, fontFamily: C.font, attributionLogo: true, panes: { separatorColor: C.border, separatorHoverColor: C.subtle, enableResize: true } },
      grid: { vertLines: { visible: false }, horzLines: { color: C.border } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: !daily, secondsVisible: false, rightOffset: showForecast ? 2 : 6, shiftVisibleRangeOnNewBar: true, tickMarkFormatter: (t: Time, type: number) => tickLabel(t as number, type) },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.subtle, labelBackgroundColor: C.muted }, horzLine: { color: C.subtle, labelBackgroundColor: C.muted } },
      localization: { locale: 'ko-KR', timeFormatter: (t: Time) => timeLabel(t as number, daily) },
    });
    const s: Record<string, AnySeries> = {};
    if (kind === 'line') {
      const col = direction > 0 ? C.up : direction < 0 ? C.down : C.fg;
      s.candle = chart.addSeries(AreaSeries, {
        lineColor: col, topColor: hexA(col, 0.22), bottomColor: hexA(col, 0), lineWidth: 2, priceFormat: pf,
        crosshairMarkerRadius: 4, crosshairMarkerBorderColor: C.card,
        lastPriceAnimation: isLive ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled,
      });
    } else {
      s.candle = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false, priceFormat: pf });
    }
    s.candle.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: toggles.vol ? 0.22 : 0.08 } });
    const line = (color: string, width: 1 | 2, pane = 0, extra: Record<string, unknown> = {}) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf, ...extra }, pane);
    if (toggles.vol) {
      s.vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    }
    if (toggles.ma) { s.ma5 = line(C.c1, 1); s.ma20 = line(C.c2, 1); s.ma60 = line(C.c3, 1); s.ma120 = line(C.c4, 1); }
    if (toggles.bb) { s.bbUp = line(C.subtle, 1); s.bbLo = line(C.subtle, 1); }
    if (showForecast) {
      // AI 예측: 지평 동안 예상 경로의 10·50·90% 분위 (점선)
      s.fq50 = line(C.primary, 2, 0, { lineStyle: LineStyle.Dashed, lastValueVisible: true, title: '예측 중앙값' });
      s.fq90 = line(hexA(C.primary, 0.55), 1, 0, { lineStyle: LineStyle.Dotted, lastValueVisible: false });
      s.fq10 = line(hexA(C.primary, 0.55), 1, 0, { lineStyle: LineStyle.Dotted, lastValueVisible: false });
    }
    let pane = 1;
    if (toggles.rsi) {
      s.rsi = line(C.c5, 2, pane, { lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      for (const lv of [70, 30]) s.rsi.createPriceLine({ price: lv, color: C.subtle, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      pane++;
    }
    if (toggles.macd) {
      const mx = Math.max(...dataRef.current.ind.macd.filter((x): x is number => x != null).map(Math.abs), 1e-9);
      const md = Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(mx))));
      const mf = { type: 'custom' as const, minMove: 1 / 10 ** md, formatter: (p: number) => fmt(p, md) };
      s.hist = chart.addSeries(HistogramSeries, { priceFormat: mf, priceLineVisible: false, lastValueVisible: false }, pane);
      s.macd = line(C.c1, 2, pane, { priceFormat: mf });
      s.signal = line(C.c2, 2, pane, { priceFormat: mf });
      pane++;
    }
    const panes = chart.panes();
    if (panes.length > 1) { panes[0].setStretchFactor(3); for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1); }
    chartRef.current = chart;
    seriesRef.current = s;
    colorsRef.current = C;
    markersRef.current = createSeriesMarkers(s.candle, []);
    renderedRef.current = { len: 0, first: 0, last: 0 };
    chart.subscribeCrosshairMove((p) => setHover(p.logical != null && p.point ? Math.round(p.logical) : null));
    // 스크롤·확대·크기 변경 때 최고·최저 표시와 끝점 위치를 다시 (한 프레임에 한 번)
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeExtremes(); placeDot(); }); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(later);
    const ro = new ResizeObserver(later);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      chart.remove();
      chartRef.current = null; seriesRef.current = {}; markersRef.current = null;
    };
  }, [market, iv, togKey, theme, dg, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 라인 색·끝점 애니메이션은 차트를 다시 만들지 않고 바꾼다
  useEffect(() => {
    const s = seriesRef.current.candle, C = colorsRef.current;
    if (!s || !C || kind !== 'line') return;
    const col = direction > 0 ? C.up : direction < 0 ? C.down : C.fg;
    s.applyOptions({ lineColor: col, topColor: hexA(col, 0.22), bottomColor: hexA(col, 0), lastPriceAnimation: isLive ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled } as never);
  }, [direction, isLive, kind, theme, market, iv, togKey]);

  // ── 데이터 넣기 (전체 또는 마지막 봉만) ──
  useEffect(() => {
    const chart = chartRef.current, s = seriesRef.current, C = colorsRef.current;
    if (!chart || !s.candle || !candles.length || !C) return;
    const line = kind === 'line';
    const point = (key: string, i: number) => {
      const c = candles[i], time = c.t as UTCTimestamp;
      if (key === 'candle') return line ? { time, value: c.c } : { time, open: c.o, high: c.h, low: c.l, close: c.c };
      if (key === 'vol') return { time, value: c.v, color: hexA(c.c >= c.o ? C.up : C.down, 0.35) };
      if (key === 'hist') { const v = ind.macdHist[i]; return v == null ? { time } : { time, value: v, color: hexA(v >= 0 ? C.up : C.down, 0.45) }; }
      const v = ind[IND_OF[key as (typeof LINE_KEYS)[number]]][i];
      return v == null ? { time } : { time, value: v };
    };
    const keys = Object.keys(s).filter((k) => !k.startsWith('fq'));
    const r = renderedRef.current, n = candles.length;
    const sameStart = r.len && candles[0].t === r.first;
    const incremental = sameStart && (n === r.len || n === r.len + 1) && candles[r.len - 1]?.t === r.last;
    if (incremental) {
      for (const key of keys) for (let i = Math.max(0, r.len - 1); i < n; i++) s[key].update(point(key, i) as never);
    } else {
      const ts = chart.timeScale();
      const range = r.len ? ts.getVisibleLogicalRange() : null;
      for (const key of keys) s[key].setData(candles.map((_, i) => point(key, i)) as never);
      if (range && sameStart) ts.setVisibleLogicalRange({ from: range.from + (n - r.len), to: range.to + (n - r.len) });
      else if (!r.len) ts.setVisibleLogicalRange({ from: Math.max(0, n - (window.innerWidth < 760 ? 90 : 160)), to: n + (showForecast ? (forecast?.horizon || 20) + 2 : 4) });
    }
    const grew = n !== r.len;
    renderedRef.current = { len: n, first: candles[0].t, last: candles[n - 1].t };
    if (grew || !incremental) updateMarks(); // 같은 봉 안의 실시간 갱신은 크로스 표시를 다시 계산하지 않는다
    placeExtremes();
    placeDot();
    if (!shown) requestAnimationFrame(() => setShown(true));
  }, [candles, ind, togKey, theme, market, iv, dg, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { placeDot(); placeExtremes(); }, [isLive, kind]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── 범례 — 평소엔 모양 전환과 이동평균 색만, 십자선을 올리면 그 봉의 값 ──
  const hovering = hover != null && hover >= 0 && hover < candles.length;
  const i = hovering ? hover : candles.length - 1;
  const c = candles[i], prev = candles[i - 1];
  const ch = c && prev ? (c.c / prev.c - 1) * 100 : null;
  const f = (x: number | null | undefined) => fmt(x, dg);
  const dotColor = direction > 0 ? 'var(--up)' : direction < 0 ? 'var(--down)' : 'var(--foreground)';
  const extreme = (ref: React.RefObject<HTMLDivElement | null>, label: string, tone: string) => (
    <div ref={ref} aria-hidden className="group pointer-events-none absolute top-0 left-0 z-[4] size-0 opacity-0 transition-opacity duration-200">
      <span className={cn('absolute -top-[2.5px] -left-[2.5px] size-[5px] rounded-full', tone === 'up' ? 'bg-up-text' : 'bg-down-text')} />
      <span className={cn('absolute -top-[9px] rounded-md bg-card/85 px-1 text-[11px] leading-[18px] font-medium whitespace-nowrap backdrop-blur-[2px]',
        'group-data-[side=right]:left-[7px] group-data-[side=left]:right-[7px] group-data-[v=below]:top-[4px]', tone === 'up' ? 'text-up-text' : 'text-down-text')}>
        {label} <b className="tabular font-semibold" />
      </span>
    </div>
  );
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div ref={barRef} className="absolute top-1.5 right-16 left-2 z-10 flex items-start gap-2.5">
        <div role="radiogroup" aria-label="차트 모양" className="pointer-events-auto flex shrink-0 rounded-lg bg-secondary/85 p-0.5 backdrop-blur-sm">
          {(['candle', 'line'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn('press rounded-md px-2 py-0.5 text-[11.5px] font-semibold transition-colors', kind === k ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.1)] dark:bg-popover' : 'text-muted-foreground hover:text-foreground')}>
              {k === 'candle' ? '캔들' : '라인'}
            </button>
          ))}
        </div>
        {c && hovering && (
          <div className="pointer-events-none flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 rounded-lg bg-card/85 px-1.5 py-0.5 text-[11.5px] text-muted-foreground backdrop-blur-[2px]">
            <span>{timeLabel(c.t, daily)}</span>
            {kind === 'candle' && <>
              <span>시 <b className="tabular font-semibold text-foreground">{f(c.o)}</b></span>
              <span>고 <b className="tabular font-semibold text-foreground">{f(c.h)}</b></span>
              <span>저 <b className="tabular font-semibold text-foreground">{f(c.l)}</b></span>
            </>}
            <span>{kind === 'candle' ? '종 ' : ''}<b className="tabular font-semibold text-foreground">{f(c.c)}</b>{ch != null && <span className={cn('ml-1 tabular', ch > 0 ? 'text-up-text' : ch < 0 ? 'text-down-text' : '')}>{fmtPct(ch)}</span>}</span>
            {toggles.ma && (
              <span className="hidden basis-full gap-x-2.5 md:flex">
                {([5, 20, 60, 120] as const).map((n, k) => (
                  <span key={n} className="inline-flex items-center gap-1">
                    <i className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: `var(--chart-${k + 1})` }} />MA{n} <b className="tabular font-semibold text-foreground">{f(ind[`ma${n}`][i])}</b>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {c && !hovering && toggles.ma && (
          <div className="pointer-events-none hidden gap-x-2.5 pt-1 text-[11px] text-muted-foreground md:flex">
            {([5, 20, 60, 120] as const).map((n, k) => (
              <span key={n} className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: `var(--chart-${k + 1})` }} />MA{n}</span>
            ))}
          </div>
        )}
      </div>
      <div ref={box} className={cn('h-full w-full transition-opacity duration-300', shown ? 'opacity-100' : 'opacity-0')} />
      {extreme(hiRef, '최고', 'up')}
      {extreme(loRef, '최저', 'down')}
      {/* 캔들 모양의 실시간 끝점 */}
      <div ref={dotRef} aria-hidden className="pointer-events-none absolute top-0 left-0 z-[5] size-0 opacity-0 transition-opacity duration-300" style={{ ['--dot' as string]: dotColor }}>
        <span className="absolute -top-[4px] -left-[4px] size-2 animate-ping rounded-full bg-[var(--dot)] opacity-60" />
        <span className="absolute -top-[3px] -left-[3px] size-1.5 rounded-full bg-[var(--dot)] shadow-[0_0_0_2px_var(--card)]" />
      </div>
    </div>
  );
}
