// Every technique produces a `signal` array in [-1, 1] (positive = bullish) that only
// uses information available on that day. A shared, honest backtest (evaluate) then
// scores each one on the most recent 40% of history, which the ML models never trained on.
import * as I from './indicators.js';
import * as M from './ml.js';

const START = 60; // first index where all features exist

export const FEATURE_NAMES = [
  'Return 1d', 'Return 5d', 'Return 10d', 'Return 20d', 'RSI (centered)',
  'MACD histogram', 'Bollinger %B', 'Distance from SMA50', 'Volume z-score', 'Volatility 20d',
];

export function prepare(data, H, symbol) {
  const c = data.close, v = data.volume, n = c.length;
  const r1 = I.logReturns(c);
  const P = {
    symbol, H, n, c, v, dates: data.dates,
    r1, rsi: I.rsi(c), macd: I.macd(c), bb: I.bollinger(c),
    s20: I.sma(c, 20), s50: I.sma(c, 50), s200: I.sma(c, 200), e9: I.ema(c, 9), e21: I.ema(c, 21),
    vz: I.volumeZ(v), vol20: I.rollingStd(r1, 20), obv: I.obv(c, v),
  };
  P.feat = new Array(n).fill(null);
  for (let t = START; t < n; t++) {
    const f = [r1[t], Math.log(c[t] / c[t - 5]), Math.log(c[t] / c[t - 10]), Math.log(c[t] / c[t - 20]),
      P.rsi[t] / 100 - 0.5, (P.macd.hist[t] / c[t]) * 100, P.bb.pctB[t] - 0.5, c[t] / P.s50[t] - 1,
      P.vz[t] == null ? null : M.clamp(P.vz[t], -4, 4), P.vol20[t]];
    if (f.every((x) => x != null && Number.isFinite(x))) P.feat[t] = f;
  }
  P.label = (t) => (t + H < n ? (c[t + H] > c[t] ? 1 : 0) : null);
  P.testStart = Math.floor(START + (n - START) * 0.6);
  P.trainIdx = [];
  for (let t = START; t + H < P.testStart; t++) if (P.feat[t]) P.trainIdx.push(t);
  return P;
}

// ---------- helpers ----------
const blank = (len) => new Array(len).fill(null);
function crossMarkers(signal) {
  const buy = [], sell = [];
  for (let i = 1; i < signal.length; i++) {
    const a = signal[i - 1], b = signal[i];
    if (a == null || b == null) continue;
    if (a <= 0 && b > 0) buy.push(i);
    if (a >= 0 && b < 0) sell.push(i);
  }
  return { buy, sell };
}
const pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
const money = (x) => '$' + x.toFixed(2);

function mlSplitOk(P) {
  return P.trainIdx.length >= 80 ? null : `Needs more history: only ${P.trainIdx.length} training days (need ≥ 80).`;
}
function trainAccuracy(P, model, zs) {
  let h = 0; for (const t of P.trainIdx) h += (model.predict(zs(P.feat[t])) > 0.5) === (P.label(t) === 1) ? 1 : 0;
  return h / P.trainIdx.length;
}

// ---------- techniques ----------
export const TECHNIQUES = [
  // Baselines -------------------------------------------------------------
  {
    id: 'buyhold', group: 'Baselines', name: 'Always bullish', help: 't_buyhold',
    run: (P) => ({ signal: P.c.map(() => 1), info: ['Predicts "up" every single day. Any real technique must beat this to be worth anything.'] }),
  },
  {
    id: 'coin', group: 'Baselines', name: 'Coin flip', help: 't_coin',
    run: (P) => {
      const r = M.rng(M.hashStr(P.symbol + ':' + P.H));
      return { signal: P.c.map(() => (r() < 0.5 ? -1 : 1)), info: ['Random guesses. Shows what "luck" looks like. If a fancy model scores close to this, it has no real edge.'] };
    },
  },

  // Trend ------------------------------------------------------------------
  {
    id: 'sma', group: 'Trend', name: 'SMA 20/50 crossover', help: 't_sma',
    run: (P) => {
      const signal = P.c.map((_, i) => (P.s50[i] == null ? null : Math.tanh(((P.s20[i] - P.s50[i]) / P.s50[i]) * 25)));
      const i = P.n - 1;
      return {
        signal, markers: crossMarkers(signal),
        overlays: [{ label: 'SMA 20', data: P.s20, color: 'c1' }, { label: 'SMA 50', data: P.s50, color: 'c2' }],
        info: [`SMA20 ${money(P.s20[i])} is ${P.s20[i] > P.s50[i] ? 'above' : 'below'} SMA50 ${money(P.s50[i])} → ${P.s20[i] > P.s50[i] ? '"golden" (bullish)' : '"death" (bearish)'} alignment.`],
      };
    },
  },
  {
    id: 'trend200', group: 'Trend', name: '200-day trend filter', help: 't_trend200',
    run: (P) => {
      const { n, c, s200 } = P;
      // Bullish when price is above a rising 200-day average; bearish when below a falling one.
      const signal = c.map((p, i) => {
        if (s200[i] == null || i < 220) return null;
        const above = (p - s200[i]) / s200[i], slope = s200[i] / s200[i - 20] - 1;
        return Math.tanh(above * 8) * 0.6 + Math.tanh(slope * 40) * 0.4;
      });
      const i = n - 1, gap = s200[i] ? (c[i] / s200[i] - 1) * 100 : null;
      return {
        signal, markers: crossMarkers(signal),
        overlays: [{ label: 'SMA 200', data: s200, color: 'c2', width: 2 }],
        info: s200[i] == null ? ['Needs 200+ days of history.'] : [
          `Price is ${Math.abs(gap).toFixed(1)}% ${gap >= 0 ? 'above' : 'below'} its 200-day average, which is ${s200[i] > s200[i - 20] ? 'rising' : 'falling'}.`,
          'One of the best-documented trend rules. It usually doesn’t raise returns much, but historically it has cut deep crashes (e.g. 2008, 2022).'],
      };
    },
  },
  {
    id: 'ema', group: 'Trend', name: 'EMA 9/21 crossover', help: 't_ema',
    run: (P) => {
      const signal = P.c.map((_, i) => (P.e21[i] == null ? null : Math.tanh(((P.e9[i] - P.e21[i]) / P.e21[i]) * 40)));
      return {
        signal, markers: crossMarkers(signal),
        overlays: [{ label: 'EMA 9', data: P.e9, color: 'c1' }, { label: 'EMA 21', data: P.e21, color: 'c2' }],
        info: ['Faster than the SMA crossover: reacts sooner but gives more false signals ("whipsaws").'],
      };
    },
  },
  {
    id: 'linreg', group: 'Trend', name: 'Linear regression trend', help: 't_linreg',
    run: (P) => {
      const W = 40, { n, H, c } = P, signal = blank(n), xs = [...Array(W).keys()];
      let last;
      for (let t = W - 1; t < n; t++) {
        const ys = []; for (let j = t - W + 1; j <= t; j++) ys.push(Math.log(c[j]));
        const f = M.linreg(xs, ys);
        signal[t] = Math.tanh(f.slope * H * 40) * Math.sqrt(f.r2);
        if (t === n - 1) last = f;
      }
      const fit = blank(n + H), up = blank(n + H), lo = blank(n + H);
      for (let k = 0; k < W + H; k++) {
        const y = last.intercept + last.slope * k, idx = n - W + k;
        fit[idx] = Math.exp(y);
        if (k >= W - 1) { up[idx] = Math.exp(y + 2 * last.sd); lo[idx] = Math.exp(y - 2 * last.sd); }
      }
      return {
        signal,
        overlays: [{ label: `Fit (last ${W}d) + forecast`, data: fit, color: 'accent', width: 2 },
          { label: '+2σ', data: up, color: 'muted', dash: true }, { label: '−2σ', data: lo, color: 'muted', dash: true }],
        info: [`Slope: ${pct(last.slope)} per day · R² = ${last.r2.toFixed(2)} (how straight the trend is; 1 = perfectly straight).`,
          `${H}-day projection: ${money(fit[n - 1 + H])} (band ${money(lo[n - 1 + H])} – ${money(up[n - 1 + H])}).`],
      };
    },
  },
  {
    id: 'poly', group: 'Trend', name: 'Polynomial regression', help: 't_poly',
    run: (P) => {
      const W = 40, { n, H, c } = P, signal = blank(n), xs = [...Array(W).keys()].map((k) => k / (W - 1));
      const xf = (W - 1 + H) / (W - 1);
      for (let t = W - 1; t < n; t++) {
        const ys = []; for (let j = t - W + 1; j <= t; j++) ys.push(Math.log(c[j]));
        const f = M.polyfit(xs, ys, 2);
        if (f) signal[t] = Math.tanh((f(xf) - f(1)) * 20);
      }
      const ys = []; for (let j = n - W; j < n; j++) ys.push(Math.log(c[j]));
      const f2 = M.polyfit(xs, ys, 2), f6 = M.polyfit(xs, ys, 6);
      const d2 = blank(n + H), d6 = blank(n + H);
      for (let k = 0; k < W + H; k++) { const x = k / (W - 1); if (f2) d2[n - W + k] = Math.exp(f2(x)); if (f6) d6[n - W + k] = Math.exp(f6(x)); }
      return {
        signal,
        overlays: [{ label: 'Degree 2 (curve)', data: d2, color: 'accent', width: 2 }, { label: 'Degree 6 (overfit!)', data: d6, color: 'warn', dash: true }],
        info: [`Degree-2 ${H}-day projection: ${money(d2[n - 1 + H])}.`,
          `Degree-6 projection: ${money(d6[n - 1 + H])}. Notice how the wiggly curve hugs past prices but shoots off wildly into the future. That is overfitting.`],
      };
    },
  },
  {
    id: 'holt', group: 'Trend', name: "Holt's exponential smoothing", help: 't_holt',
    run: (P) => {
      const { n, H, c } = P, { level, trend } = M.holt(c, 0.3, 0.1);
      const signal = level.map((L, i) => (L == null || i < 20 ? null : Math.tanh((trend[i] / L) * H * 40)));
      const fc = blank(n + H); fc[n - 1] = level[n - 1];
      for (let h = 1; h <= H; h++) fc[n - 1 + h] = level[n - 1] + h * trend[n - 1];
      return {
        signal,
        overlays: [{ label: 'Smoothed level', data: level, color: 'c1' }, { label: 'Holt forecast', data: fc, color: 'accent', width: 2, dash: true }],
        info: [`Trend component: ${money(trend[n - 1])}/day → ${H}-day forecast ${money(fc[n - 1 + H])}.`],
      };
    },
  },

  // Momentum / mean reversion --------------------------------------------
  {
    id: 'rsi', group: 'Momentum & oscillators', name: 'RSI (overbought / oversold)', help: 'rsi',
    run: (P) => {
      const signal = P.rsi.map((r) => (r == null ? null : r < 30 ? 0.3 + ((30 - r) / 30) * 0.7 : r > 70 ? -(0.3 + ((r - 70) / 30) * 0.7) : 0));
      const r = P.rsi[P.n - 1];
      return {
        signal,
        sub: { title: 'RSI (14)', datasets: [{ label: 'RSI', data: P.rsi, color: 'accent' }], hlines: [30, 70], min: 0, max: 100 },
        info: [`RSI now: ${r.toFixed(1)} → ${r < 30 ? 'oversold (bounce expected)' : r > 70 ? 'overbought (pullback expected)' : 'neutral zone. No signal (signal = 0)'}.`,
          'Only fires in the extreme zones, so its "coverage" is low. It stays in cash most days.'],
      };
    },
  },
  {
    id: 'macd', group: 'Momentum & oscillators', name: 'MACD momentum', help: 'macd',
    run: (P) => {
      const signal = P.macd.hist.map((h, i) => (h == null ? null : Math.tanh((h / P.c[i]) * 300)));
      return {
        signal, markers: crossMarkers(signal),
        sub: { title: 'MACD (12, 26, 9)', datasets: [
          { label: 'Histogram', data: P.macd.hist, type: 'bar', color: 'hist' },
          { label: 'MACD', data: P.macd.line, color: 'c1' }, { label: 'Signal', data: P.macd.signal, color: 'c2' }], hlines: [0] },
        info: [`Histogram ${P.macd.hist[P.n - 1] > 0 ? 'positive: momentum is accelerating upward' : 'negative: momentum is fading / pointing down'}.`],
      };
    },
  },
  {
    id: 'boll', group: 'Momentum & oscillators', name: 'Bollinger Bands reversion', help: 'bollinger',
    run: (P) => {
      const signal = P.bb.pctB.map((b) => (b == null ? null : M.clamp(-(b - 0.5) * 2, -1, 1)));
      const b = P.bb.pctB[P.n - 1];
      return {
        signal,
        overlays: [{ label: 'Upper band', data: P.bb.up, color: 'muted', dash: true }, { label: 'Middle (SMA20)', data: P.bb.mid, color: 'c2' },
          { label: 'Lower band', data: P.bb.lo, color: 'muted', dash: true }],
        info: [`%B = ${b.toFixed(2)} (0 = at lower band, 1 = at upper band). Mean-reversion view: ${b > 0.8 ? 'stretched high' : b < 0.2 ? 'stretched low' : 'mid-range'}.`],
      };
    },
  },

  // Volume -----------------------------------------------------------------
  {
    id: 'obv', group: 'Volume', name: 'On-balance volume trend', help: 'obv',
    run: (P) => {
      const { n, v, obv } = P, signal = blank(n);
      for (let t = 20; t < n; t++) { let s = 0; for (let j = t - 19; j <= t; j++) s += v[j]; signal[t] = s ? M.clamp((obv[t] - obv[t - 20]) / s, -1, 1) : 0; }
      return {
        signal,
        sub: { title: 'On-balance volume', datasets: [{ label: 'OBV', data: obv, color: 'accent' }] },
        info: [`Over the last 20 days, ${pct(Math.abs(signal[n - 1]), 0)} of volume was net ${signal[n - 1] >= 0 ? 'buying (up days)' : 'selling (down days)'}.`],
      };
    },
  },
  {
    id: 'volspike', group: 'Volume', name: 'Volume spike detector', help: 't_volspike',
    run: (P) => {
      const { n, vz, r1 } = P, signal = blank(n), buy = [], sell = [], spikes = new Set();
      let s = 0;
      for (let t = 21; t < n; t++) {
        if (vz[t] > 2) { s = Math.sign(r1[t]) * Math.min(1, (vz[t] - 1) / 3); spikes.add(t); (r1[t] > 0 ? buy : sell).push(t); }
        else { s *= 0.75; if (Math.abs(s) < 0.05) s = 0; }
        signal[t] = s;
      }
      return {
        signal, markers: { buy, sell },
        sub: { title: 'Volume (spikes > 2σ highlighted)', volume: true, highlight: spikes },
        info: [`${spikes.size} unusual-volume days found (volume more than 2 standard deviations above its 20-day norm).`,
          'The signal is "follow the big money": a spike on an up day is bullish, a spike on a down day is bearish, and the signal fades over a few days.'],
      };
    },
  },

  // Machine learning ---------------------------------------------------------
  {
    id: 'logit', group: 'Machine learning', name: 'Logistic regression', help: 't_logit',
    run: (P) => {
      const err = mlSplitOk(P); if (err) return { error: err };
      const zs = M.standardizer(P.trainIdx.map((t) => P.feat[t]));
      const model = M.trainLogistic(P.trainIdx.map((t) => zs(P.feat[t])), P.trainIdx.map(P.label));
      const prob = blank(P.n);
      for (let t = P.testStart; t < P.n; t++) if (P.feat[t]) prob[t] = model.predict(zs(P.feat[t]));
      const weights = FEATURE_NAMES.map((name, j) => ({ name, w: model.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
      return {
        signal: prob.map((p) => (p == null ? null : 2 * p - 1)), trainAcc: trainAccuracy(P, model, zs), weights,
        sub: { title: `P(price higher in ${P.H}d)`, datasets: [{ label: 'Probability up', data: prob, color: 'accent' }], hlines: [0.5], min: 0, max: 1 },
        info: [`Model says ${pct(prob[P.n - 1], 0)} chance the price is higher in ${P.H} trading day(s).`],
      };
    },
  },
  {
    id: 'knn', group: 'Machine learning', name: 'k-Nearest neighbors (pattern match)', help: 't_knn',
    run: (P) => {
      const err = mlSplitOk(P); if (err) return { error: err };
      const K = 20, zs = M.standardizer(P.trainIdx.map((t) => P.feat[t]));
      const Z = P.feat.map((f) => (f ? zs(f) : null)), prob = blank(P.n);
      let lastNeighbors = [];
      for (let t = P.testStart; t < P.n; t++) {
        if (!Z[t]) continue;
        const cand = [];
        for (let i = START; i + P.H <= t; i++) if (Z[i]) cand.push([Z[i].reduce((s, v, j) => s + (v - Z[t][j]) ** 2, 0), i]);
        cand.sort((a, b) => a[0] - b[0]);
        const nb = cand.slice(0, K);
        prob[t] = nb.reduce((s, [, i]) => s + P.label(i), 0) / nb.length;
        if (t === P.n - 1) lastNeighbors = nb.map(([, i]) => i);
      }
      const similar = lastNeighbors.slice(0, 5).map((i) => `${P.dates[i]} (then ${P.c[i + P.H] > P.c[i] ? '▲' : '▼'} ${pct(P.c[i + P.H] / P.c[i] - 1, 1)})`);
      return {
        signal: prob.map((p) => (p == null ? null : 2 * p - 1)),
        markers: { neutral: lastNeighbors.slice(0, 5) },
        sub: { title: `Share of similar past setups that rose within ${P.H}d`, datasets: [{ label: 'Neighbor vote', data: prob, color: 'accent' }], hlines: [0.5], min: 0, max: 1 },
        info: [`Of the ${K} most similar past days, ${pct(prob[P.n - 1], 0)} were followed by a rise.`, `Most similar days (marked ◆ on chart): ${similar.join(', ')}.`],
      };
    },
  },
  {
    id: 'mlp', group: 'Machine learning', name: 'Neural network (MLP)', help: 't_mlp',
    run: (P) => {
      const err = mlSplitOk(P); if (err) return { error: err };
      const zs = M.standardizer(P.trainIdx.map((t) => P.feat[t]));
      const model = M.trainMLP(P.trainIdx.map((t) => zs(P.feat[t])), P.trainIdx.map(P.label), { seed: M.hashStr(P.symbol) });
      const prob = blank(P.n);
      for (let t = P.testStart; t < P.n; t++) if (P.feat[t]) prob[t] = model.predict(zs(P.feat[t]));
      return {
        signal: prob.map((p) => (p == null ? null : 2 * p - 1)), trainAcc: trainAccuracy(P, model, zs),
        sub: { title: `P(price higher in ${P.H}d)`, datasets: [{ label: 'Probability up', data: prob, color: 'accent' }], hlines: [0.5], min: 0, max: 1 },
        info: [`Network says ${pct(prob[P.n - 1], 0)} chance of a rise in ${P.H} day(s).`,
          'Compare training accuracy with test accuracy below. A big gap means it memorized the past instead of learning it.'],
      };
    },
  },
  {
    id: 'kmeans', group: 'Machine learning', name: 'k-Means market regimes', help: 't_kmeans',
    run: (P) => {
      const err = mlSplitOk(P); if (err) return { error: err };
      const raw = (t) => [Math.log(P.c[t] / P.c[t - 20]), P.vol20[t]];
      const zs = M.standardizer(P.trainIdx.map(raw));
      const km = M.kmeans(P.trainIdx.map((t) => zs(raw(t))), 3);
      const stats = [0, 1, 2].map(() => ({ fwd: [], ret: [], vol: [] }));
      for (const t of P.trainIdx) { const k = km.assign(zs(raw(t))); stats[k].fwd.push(Math.log(P.c[t + P.H] / P.c[t])); stats[k].ret.push(raw(t)[0]); stats[k].vol.push(raw(t)[1]); }
      const allFwd = stats.flatMap((s) => s.fwd), sdF = M.std(allFwd) || 1, medVol = stats.map((s) => M.mean(s.vol)).sort((a, b) => a - b)[1];
      const regimes = stats.map((s) => {
        const r = M.mean(s.ret), v = M.mean(s.vol);
        return { name: (r > 0.02 ? 'Uptrend' : r < -0.02 ? 'Downtrend' : 'Sideways') + (v > medVol ? ' · volatile' : ' · calm'),
          fwd: M.mean(s.fwd), up: s.fwd.filter((x) => x > 0).length / (s.fwd.length || 1), count: s.fwd.length };
      });
      const regimeOf = blank(P.n), signal = blank(P.n);
      for (let t = START; t < P.n; t++) if (P.vol20[t] != null) {
        const k = km.assign(zs(raw(t))); regimeOf[t] = k;
        if (t >= P.testStart) signal[t] = Math.tanh((regimes[k].fwd / sdF) * 3);
      }
      const colors = ['c1', 'c2', 'c3'];
      const overlays = regimes.map((rg, k) => ({ label: rg.name, data: P.c.map((c, i) => (regimeOf[i] === k ? c : null)), color: colors[k], points: true }));
      const now = regimes[regimeOf[P.n - 1]];
      return {
        signal, overlays,
        info: [`Today looks like regime "${now.name}".`,
          ...regimes.map((rg) => `${rg.name}: ${rg.count} training days, then rose within ${P.H}d ${pct(rg.up, 0)} of the time (avg ${pct(Math.exp(rg.fwd) - 1)}).`)],
      };
    },
  },
  {
    id: 'ensemble', group: 'Machine learning', name: 'Ensemble (majority vote)', help: 't_ensemble',
    run: () => ({}), // filled in by runAll once the others have run
  },
];

// ---------- honest backtest ----------
export function evaluate(P, signal) {
  const { c, n, H, testStart } = P;
  let hits = 0, cnt = 0, upsPred = 0, total = 0, s = 0, b = 0;
  const daily = [], eqS = [], eqB = [], eqDates = [];
  for (let t = testStart; t < n - 1; t++) {
    const sg = signal[t], r = Math.log(c[t + 1] / c[t]), pos = sg != null && sg > 0 ? 1 : 0;
    s += pos * r; b += r; daily.push(pos * r);
    eqS.push(Math.exp(s)); eqB.push(Math.exp(b)); eqDates.push(P.dates[t + 1]);
    if (t + H < n) {
      total++;
      if (sg != null && sg !== 0) { const up = c[t + H] > c[t]; cnt++; if (up) upsPred++; if ((sg > 0) === up) hits++; }
    }
  }
  if (cnt < 5) return { rating: 50, grade: '—', n: cnt, insufficient: true, eqS, eqB, eqDates };
  const acc = hits / cnt, upFrac = upsPred / cnt, baseAcc = Math.max(upFrac, 1 - upFrac);
  const edge = acc - baseAcc, nEff = cnt / H;
  const z = edge / Math.sqrt(Math.max(1e-6, baseAcc * (1 - baseAcc)) / nEff);
  const days = Math.max(1, daily.length), excessAnn = ((s - b) * 252) / days;
  const sd = M.std(daily), sharpe = sd ? (M.mean(daily) / sd) * Math.sqrt(252) : 0;
  let rating = 50 + 250 * edge + 20 * Math.tanh(3 * excessAnn);
  rating = 50 + (rating - 50) * Math.min(1, nEff / 40) * Math.min(1, (cnt / total) / 0.2);
  rating = M.clamp(Math.round(rating), 0, 100);
  return {
    acc, baseAcc, edge, z, n: cnt, nEff, coverage: cnt / total, stratRet: Math.exp(s) - 1, bhRet: Math.exp(b) - 1,
    excessAnn, sharpe, rating, grade: grade(rating), eqS, eqB, eqDates, testFrom: P.dates[testStart], testDays: days,
  };
}
export const grade = (r) => (r >= 75 ? 'A' : r >= 62 ? 'B' : r >= 48 ? 'C' : r >= 35 ? 'D' : 'F');

export function runAll(data, H, symbol) {
  const P = prepare(data, H, symbol), results = {};
  for (const T of TECHNIQUES) {
    if (T.id === 'ensemble') continue;
    try {
      const r = T.run(P);
      if (r.error || !r.signal) { results[T.id] = { error: r.error || 'No signal' }; continue; }
      r.eval = evaluate(P, r.signal);
      r.current = r.signal[P.n - 1];
      results[T.id] = r;
    } catch (e) { console.error(T.id, e); results[T.id] = { error: String(e.message || e) }; }
  }
  // Ensemble: equal-weight vote of every non-baseline technique (no peeking at test scores).
  const voters = TECHNIQUES.filter((T) => T.group !== 'Baselines' && T.id !== 'ensemble' && results[T.id]?.signal);
  const signal = blank(P.n);
  for (let t = 0; t < P.n; t++) {
    let s = 0, k = 0;
    for (const T of voters) { const v = results[T.id].signal[t]; if (v != null) { s += Math.sign(v); k++; } }
    if (k >= 3) signal[t] = s / k;
  }
  const bulls = voters.filter((T) => results[T.id].current > 0).length, bears = voters.filter((T) => results[T.id].current < 0).length;
  results.ensemble = {
    signal, eval: evaluate(P, signal), current: signal[P.n - 1],
    info: [`Today: ${bulls} techniques bullish, ${bears} bearish, ${voters.length - bulls - bears} neutral.`,
      'Every technique gets one equal vote, so no single model dominates. Combining many weak, independent signals is one of the most reliable ideas in ML.'],
  };
  return { P, results };
}
