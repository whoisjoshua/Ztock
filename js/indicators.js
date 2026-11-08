// Classic technical indicators. Every function returns an array the same length
// as its input, with `null` where there isn't enough history yet. Value at index t
// only uses data up to and including t (no look-ahead).

export function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

// EMA that tolerates leading nulls (needed for MACD's signal line).
export function ema(a, n) {
  const out = new Array(a.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, seed = [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === n) { prev = seed.reduce((x, y) => x + y, 0) / n; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function rollingStd(a, n) {
  const out = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let s = 0, s2 = 0, ok = true;
    for (let j = i - n + 1; j <= i; j++) { const v = a[j]; if (v == null) { ok = false; break; } s += v; s2 += v * v; }
    if (!ok) continue;
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, s2 / n - m * m));
  }
  return out;
}

export function logReturns(close) {
  const out = new Array(close.length).fill(null);
  for (let i = 1; i < close.length; i++) out[i] = Math.log(close[i] / close[i - 1]);
  return out;
}

// Wilder's RSI
export function rsi(close, n = 14) {
  const out = new Array(close.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, sig = 9) {
  const ef = ema(close, fast), es = ema(close, slow);
  const line = close.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = ema(line, sig);
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

export function bollinger(close, n = 20, k = 2) {
  const mid = sma(close, n), sd = rollingStd(close, n);
  const up = mid.map((m, i) => (m == null ? null : m + k * sd[i]));
  const lo = mid.map((m, i) => (m == null ? null : m - k * sd[i]));
  const pctB = close.map((c, i) => (up[i] == null || up[i] === lo[i] ? null : (c - lo[i]) / (up[i] - lo[i])));
  return { mid, up, lo, pctB };
}

export function obv(close, volume) {
  const out = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const dir = Math.sign(close[i] - close[i - 1]);
    out[i] = out[i - 1] + dir * volume[i];
  }
  return out;
}

// z-score of today's volume vs. the previous n days
export function volumeZ(volume, n = 20) {
  const out = new Array(volume.length).fill(null);
  for (let i = n; i < volume.length; i++) {
    let s = 0, s2 = 0;
    for (let j = i - n; j < i; j++) { s += volume[j]; s2 += volume[j] * volume[j]; }
    const m = s / n, sd = Math.sqrt(Math.max(1e-9, s2 / n - m * m));
    out[i] = (volume[i] - m) / sd;
  }
  return out;
}
