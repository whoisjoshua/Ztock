// Small, dependency-free machine-learning toolkit that runs in the browser.

// Deterministic RNG so results are reproducible (same ticker -> same model).
export function rng(seed = 42) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export function hashStr(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

// Ordinary least squares on y = a + b x. Returns slope, intercept, r2, residual sd.
export function linreg(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxx ? sxy / sxx : 0, intercept = my - slope * mx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  let ss = 0; for (let i = 0; i < n; i++) ss += (ys[i] - (intercept + slope * xs[i])) ** 2;
  return { slope, intercept, r2, sd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

// Solve A x = b with Gaussian elimination + partial pivoting.
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

// Polynomial least squares. x should be roughly in [0, 1.5] for numerical stability.
export function polyfit(xs, ys, deg) {
  const m = deg + 1, A = Array.from({ length: m }, () => new Array(m).fill(0)), b = new Array(m).fill(0);
  for (let i = 0; i < xs.length; i++) {
    const pw = [1]; for (let k = 1; k < 2 * m; k++) pw.push(pw[k - 1] * xs[i]);
    for (let r = 0; r < m; r++) { b[r] += pw[r] * ys[i]; for (let c = 0; c < m; c++) A[r][c] += pw[r + c]; }
  }
  const coef = solve(A, b);
  return coef ? (x) => coef.reduce((s, c, k) => s + c * x ** k, 0) : null;
}

// Holt's linear (double) exponential smoothing.
export function holt(series, alpha = 0.3, beta = 0.1) {
  const level = new Array(series.length).fill(null), trend = new Array(series.length).fill(null);
  if (series.length < 3) return { level, trend };
  let L = series[0], T = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prevL = L;
    L = alpha * series[i] + (1 - alpha) * (L + T);
    T = beta * (L - prevL) + (1 - beta) * T;
    level[i] = L; trend[i] = T;
  }
  return { level, trend };
}

// Fit mean/std on training rows, return a function that standardizes any row.
export function standardizer(rows) {
  const d = rows[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) r.forEach((v, j) => (mu[j] += v / rows.length));
  for (const r of rows) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / rows.length));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return (r) => r.map((v, j) => (v - mu[j]) / sd[j]);
}

// Logistic regression trained with batch gradient descent + L2 regularization.
export function trainLogistic(X, y, { iters = 400, lr = 0.15, l2 = 0.01 } = {}) {
  const d = X[0].length, w = new Array(d).fill(0); let b = 0;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(b + X[i].reduce((s, v, j) => s + v * w[j], 0));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b, predict: (x) => sigmoid(b + x.reduce((s, v, j) => s + v * w[j], 0)) };
}

// Tiny multilayer perceptron: d -> h (tanh) -> 1 (sigmoid), trained with SGD.
export function trainMLP(X, y, { hidden = 8, epochs = 120, lr = 0.03, l2 = 1e-3, seed = 7 } = {}) {
  const r = rng(seed), d = X[0].length;
  const W1 = Array.from({ length: hidden }, () => Array.from({ length: d }, () => (r() - 0.5) * 2 / Math.sqrt(d)));
  const b1 = new Array(hidden).fill(0), W2 = Array.from({ length: hidden }, () => (r() - 0.5) * 2 / Math.sqrt(hidden));
  let b2 = 0;
  const fwd = (x) => {
    const h = W1.map((row, k) => Math.tanh(b1[k] + row.reduce((s, w, j) => s + w * x[j], 0)));
    return { h, p: sigmoid(b2 + h.reduce((s, v, k) => s + v * W2[k], 0)) };
  };
  const idx = X.map((_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (const i of idx) {
      const x = X[i], { h, p } = fwd(x), e = p - y[i];
      for (let k = 0; k < hidden; k++) {
        const gh = e * W2[k] * (1 - h[k] * h[k]);
        W2[k] -= lr * (e * h[k] + l2 * W2[k]);
        for (let j = 0; j < d; j++) W1[k][j] -= lr * (gh * x[j] + l2 * W1[k][j]);
        b1[k] -= lr * gh;
      }
      b2 -= lr * e;
    }
  }
  return { predict: (x) => fwd(x).p };
}

// k-means with deterministic initialization (spread across sorted first feature).
export function kmeans(X, k = 3, iters = 60) {
  const sorted = [...X].sort((a, b) => a[0] - b[0]);
  let C = Array.from({ length: k }, (_, c) => [...sorted[Math.floor(((c + 0.5) / k) * (sorted.length - 1))]]);
  const assign = (x) => { let best = 0, bd = Infinity; C.forEach((c, j) => { const dd = c.reduce((s, v, t) => s + (v - x[t]) ** 2, 0); if (dd < bd) { bd = dd; best = j; } }); return best; };
  for (let it = 0; it < iters; it++) {
    const sums = C.map((c) => c.map(() => 0)), cnt = new Array(k).fill(0);
    X.forEach((x) => { const a = assign(x); cnt[a]++; x.forEach((v, t) => (sums[a][t] += v)); });
    C = C.map((c, j) => (cnt[j] ? sums[j].map((s) => s / cnt[j]) : c));
  }
  return { centroids: C, assign };
}
