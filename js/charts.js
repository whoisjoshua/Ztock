// Chart.js rendering for the price chart, the indicator sub-chart and the backtest equity curve.
/* global Chart */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (k) => css({ accent: '--accent', c1: '--c1', c2: '--c2', c3: '--c3', muted: '--muted', warn: '--warn', up: '--up', down: '--down', hist: '--c2' }[k] || '--accent');
const alpha = (hex, a) => { const m = hex.replace('#', ''); const n = parseInt(m.length === 3 ? m.replace(/./g, '$&$&') : m, 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

// ---------- motion ----------
// The app re-renders its HTML on every state change, so charts are kept alive between renders: the old chart's
// container is moved into the new markup and its data is patched in place. That lets Chart.js animate between states.
//   - same x-axis (technique / horizon / theme change, data refresh): lines and bars morph into their new values
//   - new x-axis (range or symbol change): the chart re-enters with a left-to-right wave
//   - nothing changed (a background render): the chart is left alone, so a running animation isn't interrupted
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const MAX_ANIMATED_POINTS = 15000; // beyond this ("All" range with many overlays) skip animation to stay smooth

function morphAnim() {
  return { duration: 650, easing: 'easeInOutCubic' };
}
function enterAnim(config) {
  const n = config.data.labels.length || 1, step = 380 / n;
  return {
    duration: 700, easing: 'easeOutQuart',
    // Stagger points by index so the chart sweeps in from the left. Only for real data updates, not hover/resize.
    delay: (ctx) => (ctx.type === 'data' && ctx.mode === 'default' ? ctx.dataIndex * step : 0),
  };
}
const pointCount = (config) => config.data.labels.length * config.data.datasets.length;
const animFor = (config, kind) => (reducedMotion.matches || pointCount(config) > MAX_ANIMATED_POINTS ? false : kind === 'morph' ? morphAnim() : enterAnim(config));

// Cheap fingerprint of what's drawn, so identical re-renders can be skipped.
const sigOf = (config) => JSON.stringify([
  config.data.labels,
  config.data.datasets.map((d) => [d.type, d.label, d.data, d.borderColor, d.backgroundColor]),
  config.options.scales?.y?.min, config.options.scales?.y?.max,
]);

// Chart.js tracks datasets by object identity, so copy new values into the existing dataset objects.
// Otherwise every dataset counts as brand new and animates up from the axis instead of morphing.
function patchData(chart, data) {
  const prev = chart.data.datasets;
  chart.data.labels = data.labels;
  chart.data.datasets = data.datasets.map((d, i) => {
    const o = prev[i];
    if (!o) return d;
    for (const k of Object.keys(o)) if (!(k in d)) delete o[k];
    return Object.assign(o, d);
  });
}

const charts = {};
function make(id, canvas, config) {
  const old = charts[id], sig = sigOf(config);
  if (old && !old.canvas.isConnected && old.config.type === config.type) {
    // Swap the freshly rendered (empty) container for the live one, keeping the chart and its resize observer.
    const fresh = canvas.parentNode, live = old.canvas.parentNode;
    live.className = fresh.className;
    fresh.replaceWith(live);
    if (old.$sig === sig) return old;
    const a = old.data.labels, b = config.data.labels;
    const sameAxis = a.length === b.length || (a.length && a[0] === b[0]);
    config.options.animation = animFor(config, sameAxis ? 'morph' : 'enter');
    patchData(old, config.data);
    old.options = config.options;
    old.$sig = sig;
    if (!sameAxis && config.options.animation) old.update('reset'); // drop everything to the axis, then sweep in
    old.update();
    return old;
  }
  old?.destroy();
  config.options.animation = animFor(config, 'enter');
  charts[id] = new Chart(canvas, config);
  charts[id].$sig = sig;
  return charts[id];
}

function baseOptions({ showX = true, yTitle, min, max, legend = true } = {}) {
  const grid = css('--grid'), text = css('--muted');
  return {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    transitions: { active: { animation: { duration: 120 } } },
    plugins: {
      legend: { display: legend, labels: { color: text, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 }, filter: (i) => !i.text.startsWith('_') } },
      tooltip: { animation: { duration: 150 }, cornerRadius: 8, padding: 8, caretPadding: 6, backgroundColor: css('--surface-2'), titleColor: css('--text'), bodyColor: css('--text'), borderColor: css('--border'), borderWidth: 1,
        filter: (i) => i.raw != null && !i.dataset.label.startsWith('_'),
        callbacks: { label: (c) => `${c.dataset.label}: ${typeof c.raw === 'number' ? (Math.abs(c.raw) >= 1e5 ? c.raw.toLocaleString() : c.raw.toFixed(2)) : c.raw}` } },
    },
    scales: {
      x: { display: showX, ticks: { color: text, maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { display: false } },
      y: { position: 'right', min, max, title: { display: !!yTitle, text: yTitle, color: text }, ticks: { color: text, font: { size: 10 }, maxTicksLimit: 6 },
        grid: { color: grid }, afterFit: (s) => { s.width = 62; } },
    },
  };
}

export function renderPrice(canvas, { P, tech, range, simulated }) {
  const n = P.n, start = Math.max(0, n - range);
  const hasFuture = (tech?.overlays || []).some((o) => o.data.length > n);
  const labels = P.dates.slice(start);
  if (hasFuture) for (let h = 1; h <= P.H; h++) labels.push(`+${h}d`);
  const L = labels.length, fit = (arr) => { const a = arr.slice(start, start + L); while (a.length < L) a.push(null); return a; };
  const ds = [{ label: simulated ? 'Price (SIMULATED)' : 'Close', data: fit(P.c), borderColor: css('--text'), borderWidth: 1.5, pointRadius: 0, tension: 0.1,
    fill: { target: 'origin' }, backgroundColor: alpha(css('--accent'), 0.06) }];
  for (const o of tech?.overlays || []) {
    const c = color(o.color);
    ds.push({ label: o.label, data: fit(o.data), borderColor: c, backgroundColor: c, borderWidth: o.width || 1.3, borderDash: o.dash ? [5, 4] : [],
      pointRadius: o.points ? 2 : 0, showLine: !o.points, spanGaps: false, tension: 0.15 });
  }
  const mk = tech?.markers || {};
  const markerSet = (idxs, label, style, c, rotation = 0) => {
    if (!idxs?.length) return;
    const data = new Array(L).fill(null);
    idxs.forEach((i) => { if (i >= start) data[i - start] = P.c[i]; });
    ds.push({ label, data, showLine: false, pointStyle: style, pointRadius: 6, pointRotation: rotation, borderColor: c, backgroundColor: c });
  };
  markerSet(mk.buy, '▲ Bullish signal', 'triangle', color('up'));
  markerSet(mk.sell, '▼ Bearish signal', 'triangle', color('down'), 180);
  markerSet(mk.neutral, '◆ Similar past day', 'rectRot', color('c3'));
  make('price', canvas, { type: 'line', data: { labels, datasets: ds }, options: baseOptions() });
}

export function renderSub(canvas, { P, tech, range, extraLabels = 0 }) {
  const n = P.n, start = Math.max(0, n - range);
  const labels = P.dates.slice(start);
  for (let h = 1; h <= extraLabels; h++) labels.push(`+${h}d`);
  const L = labels.length, fit = (arr) => { const a = arr.slice(start, start + L); while (a.length < L) a.push(null); return a; };
  const sub = tech?.sub;
  let ds, opts;
  if (!sub || sub.volume) {
    const hl = sub?.highlight;
    const colors = P.c.map((c, i) => {
      const base = i > 0 && c < P.c[i - 1] ? color('down') : color('up');
      return alpha(base, hl ? (hl.has(i) ? 0.95 : 0.25) : 0.55);
    });
    ds = [{ type: 'bar', label: 'Volume', data: fit(P.v), backgroundColor: fit(colors), borderWidth: 0 }];
    opts = baseOptions({ legend: false });
    opts.scales.y.ticks.callback = (v) => (v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v);
  } else {
    ds = sub.datasets.map((d) => {
      const c = color(d.color);
      if (d.type === 'bar') {
        const data = fit(d.data);
        return { type: 'bar', label: d.label, data, backgroundColor: data.map((v) => alpha(v >= 0 ? color('up') : color('down'), 0.6)), borderWidth: 0 };
      }
      return { type: 'line', label: d.label, data: fit(d.data), borderColor: c, backgroundColor: c, borderWidth: 1.4, pointRadius: 0 };
    });
    (sub.hlines || []).forEach((y) => ds.push({ type: 'line', label: '_ref' + y, data: new Array(L).fill(y), borderColor: css('--muted'), borderDash: [3, 3], borderWidth: 1, pointRadius: 0 }));
    opts = baseOptions({ min: sub.min, max: sub.max });
  }
  make('sub', canvas, { type: 'bar', data: { labels, datasets: ds }, options: opts });
}

export function renderEquity(canvas, ev) {
  if (!ev?.eqS?.length) { charts.eq?.destroy(); delete charts.eq; return; }
  const opts = baseOptions({});
  opts.scales.y.ticks.callback = (v) => '$' + v.toFixed(2);
  opts.scales.x.ticks.maxTicksLimit = 5;
  opts.scales.x.ticks.callback = function (v) { return this.getLabelForValue(v).slice(0, 7); }; // YYYY-MM
  make('eq', canvas, { type: 'line', data: { labels: ev.eqDates, datasets: [
    { label: 'Technique (long/flat)', data: ev.eqS, borderColor: color('accent'), borderWidth: 1.6, pointRadius: 0 },
    { label: 'Buy & hold', data: ev.eqB, borderColor: color('muted'), borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0 }] }, options: opts });
}

// 1D / 1W intraday view: price line plus volume bars (no technique overlays, since those use daily bars).
export function renderIntraday(mainCanvas, subCanvas, data, range) {
  const labels = data.times.map((t) => (range === '1D' ? t.slice(11, 16) : t.slice(5, 16)));
  const first = data.close[0], last = data.close[data.close.length - 1], lineColor = color(last >= first ? 'up' : 'down');
  const o = baseOptions({ legend: false });
  make('price', mainCanvas, { type: 'line', data: { labels, datasets: [
    { label: 'Price', data: data.close, borderColor: lineColor, borderWidth: 1.6, pointRadius: 0, tension: 0.1, fill: { target: 'origin' }, backgroundColor: alpha(lineColor, 0.08) },
    { label: '_open', data: data.close.map(() => first), borderColor: css('--muted'), borderDash: [3, 3], borderWidth: 1, pointRadius: 0 }] }, options: o });
  const vo = baseOptions({ legend: false });
  vo.scales.y.ticks.callback = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v);
  make('sub', subCanvas, { type: 'bar', data: { labels, datasets: [{ label: 'Volume', data: data.volume,
    backgroundColor: data.close.map((c, i) => alpha(i > 0 && c < data.close[i - 1] ? color('down') : color('up'), 0.55)), borderWidth: 0 }] }, options: vo });
}
