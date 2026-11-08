// Fundamental + "traction" heuristics that blend P/E with growth, quality, momentum,
// volume, analysts, earnings, news and the ML models into one bull/bear confidence.
import { clamp } from './ml.js';

// Piecewise-linear scoring curve: points [[x, score], ...] sorted by x.
function curve(x, pts) {
  if (x == null || !Number.isFinite(x)) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x0, y0] = pts[i - 1];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return pts[pts.length - 1][1];
}
function blend(parts) {
  const ok = parts.filter((p) => p.s != null);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + p.s * p.w, 0) / ok.reduce((s, p) => s + p.w, 0);
}
const num = (v) => (v == null || !Number.isFinite(+v) ? null : +v);
const f = (v, d = 1, suf = '') => (v == null ? 'n/a' : v.toFixed(d) + suf);

export function derived(m, quote, hist) {
  const pe = num(m.peTTM ?? m.peBasicExclExtraTTM);
  const g = num(m.epsGrowth5Y) ?? num(m.epsGrowthTTMYoy);
  const peg = num(m.pegTTM) ?? (pe > 0 && g > 0 ? pe / g : null);
  const price = quote?.c || null, hi = num(m['52WeekHigh']), lo = num(m['52WeekLow']);
  const rangePos = price && hi && lo && hi > lo ? clamp((price - lo) / (hi - lo), 0, 1) : null;
  const volRatio = num(m['10DayAverageTradingVolume']) && num(m['3MonthAverageTradingVolume'])
    ? m['10DayAverageTradingVolume'] / m['3MonthAverageTradingVolume'] : null;
  let ret20 = null, rsiNow = null, aboveUpperBand = null, above200 = null, slope200 = null, mom121 = null;
  if (hist?.P) {
    const P = hist.P, n = P.n;
    ret20 = P.c[n - 1] / P.c[n - 21] - 1; rsiNow = P.rsi[n - 1]; aboveUpperBand = P.c[n - 1] > P.bb.up[n - 1];
    if (P.s200[n - 1] != null && P.s200[n - 21] != null) { above200 = P.c[n - 1] / P.s200[n - 1] - 1; slope200 = P.s200[n - 1] / P.s200[n - 21] - 1; }
    if (n > 253) mom121 = P.c[n - 22] / P.c[n - 253] - 1; // 12-month return, skipping the most recent month
  }
  const pfcf = num(m.pfcfShareTTM);
  const fcfYield = pfcf == null ? null : pfcf > 0 ? 100 / pfcf : -2;
  const gp = num(m.grossMarginTTM) != null && num(m.assetTurnoverTTM) != null ? (m.grossMarginTTM / 100) * m.assetTurnoverTTM : null;
  return { above200, slope200, mom121, fcfYield, gp, pe, fpe: num(m.forwardPE), peg, g, rangePos, volRatio, ret20, rsiNow, aboveUpperBand,
    ps: num(m.psTTM), pb: num(m.pbAnnual ?? m.pb), roe: num(m.roeTTM), margin: num(m.netProfitMarginTTM),
    de: num(m['totalDebt/totalEquityQuarterly'] ?? m['totalDebt/totalEquityAnnual']), cr: num(m.currentRatioQuarterly ?? m.currentRatioAnnual),
    revG: num(m.revenueGrowthTTMYoy), revG5: num(m.revenueGrowth5Y), epsG: num(m.epsGrowthTTMYoy), epsG5: num(m.epsGrowth5Y),
    r13: num(m['13WeekPriceReturnDaily']), r26: num(m['26WeekPriceReturnDaily']), r52: num(m['52WeekPriceReturnDaily']),
    relSP: num(m['priceRelativeToS&P50052Week']) };
}

// Piotroski-style F-score (Piotroski 2000) from Finnhub's annual ratio series. Each test is a simple pass/fail
// "is the business getting healthier?" check. Finnhub's free data supports 8 of the original 9 tests (or close proxies).
export function piotroski(series) {
  const a = series?.annual; if (!a) return null;
  const v = (k, i) => num(a[k]?.[i]?.v);
  const both = (k) => v(k, 0) != null && v(k, 1) != null;
  const tests = [];
  const add = (name, pass) => { if (pass != null) tests.push({ name, pass }); };
  add('Profitable (ROA > 0)', v('roa', 0) == null ? null : v('roa', 0) > 0);
  add('ROA improving vs last year', both('roa') ? v('roa', 0) > v('roa', 1) : null);
  add('Positive free cash flow', v('fcfMargin', 0) == null ? null : v('fcfMargin', 0) > 0);
  add('Cash flow ≥ reported profit (low accruals)', v('fcfMargin', 0) != null && v('netMargin', 0) != null ? v('fcfMargin', 0) >= v('netMargin', 0) : null);
  add('Long-term debt / assets falling', both('longtermDebtTotalAsset') ? v('longtermDebtTotalAsset', 0) <= v('longtermDebtTotalAsset', 1) : null);
  add('Current ratio improving', both('currentRatio') ? v('currentRatio', 0) > v('currentRatio', 1) : null);
  add('Gross margin improving', both('grossMargin') ? v('grossMargin', 0) > v('grossMargin', 1) : null);
  add('Sales per share growing (turnover / no dilution proxy)', both('salesPerShare') ? v('salesPerShare', 0) > v('salesPerShare', 1) : null);
  if (tests.length < 4) return null;
  return { score: tests.filter((t) => t.pass).length, max: tests.length, tests };
}

// How much published research supports each factor → its weight in the blend.
const EVIDENCE = { trend: 'Strong', mom121: 'Strong', valuation: 'Moderate', garp: 'Moderate', quality: 'Moderate', fscore: 'Moderate',
  momentum: 'Moderate', earnings: 'Moderate', insiders: 'Moderate', growth: 'Weak', analysts: 'Weak', news: 'Weak',
  traction: 'Educational', flags: 'Educational', technical: 'Varies' };
const EVIDENCE_WEIGHT = { Strong: 1.4, Moderate: 1.0, Varies: 0.8, Educational: 0.6, Weak: 0.5 };

export function computeFactors({ metric = {}, series, insider, quote, recs, earnings, news, techResults }) {
  const d = derived(metric, quote, techResults);
  const F = [];

  // 1. Valuation
  let peScore = d.pe == null ? null : d.pe <= 0 ? -0.6 : curve(d.pe, [[5, 0.5], [12, 0.7], [18, 0.4], [25, 0], [35, -0.35], [60, -0.7], [100, -0.9]]);
  if (d.pe == null && metric.epsTTM < 0) peScore = -0.6; // losing money → P/E not reported
  F.push({ id: 'valuation', name: 'Valuation (P/E, P/S, P/B)', help: 'f_valuation', weight: 1.1,
    score: blend([{ s: peScore, w: 2 }, { s: curve(d.fpe, [[8, 0.6], [15, 0.4], [22, 0], [35, -0.4], [60, -0.8]]), w: 1 },
      { s: curve(d.ps, [[1, 0.5], [3, 0.2], [6, -0.1], [10, -0.4], [20, -0.8]]), w: 1 }, { s: curve(d.pb, [[1, 0.5], [3, 0.1], [8, -0.3], [20, -0.5]]), w: 0.5 },
      { s: curve(d.fcfYield, [[-2, -0.5], [0, -0.3], [2, 0], [4, 0.3], [7, 0.6]]), w: 1.2 }]),
    detail: `P/E ${f(d.pe)} · fwd P/E ${f(d.fpe)} · P/S ${f(d.ps)} · P/B ${f(d.pb)} · FCF yield ${f(d.fcfYield, 1, '%')}` });

  // 2. GARP: P/E judged against growth
  F.push({ id: 'garp', name: 'P/E vs growth (PEG / GARP)', help: 'f_garp', weight: 1.0,
    score: d.peg == null ? (d.pe > 0 && d.g != null && d.g <= 0 ? -0.6 : null) : d.peg <= 0 ? -0.5 : curve(d.peg, [[0.5, 0.8], [1, 0.5], [1.5, 0.1], [2, -0.3], [3, -0.7]]),
    detail: `PEG ${f(d.peg, 2)} (P/E ${f(d.pe)} ÷ EPS growth ${f(d.g, 1, '%')})` });

  // 3. Quality
  F.push({ id: 'quality', name: 'Business quality', help: 'f_quality', weight: 0.9,
    score: blend([{ s: curve(d.roe, [[-10, -0.8], [0, -0.4], [10, 0.1], [20, 0.5], [35, 0.8]]), w: 1 },
      { s: curve(d.margin, [[-10, -0.8], [0, -0.3], [10, 0.2], [20, 0.6]]), w: 1 },
      { s: d.de != null && d.de < 0 ? -0.3 : curve(d.de, [[0, 0.5], [0.5, 0.3], [1, 0], [2, -0.4], [4, -0.8]]), w: 0.8 },
      { s: curve(d.cr, [[0.5, -0.6], [1, -0.1], [1.5, 0.3], [3, 0.4]]), w: 0.5 },
      { s: curve(d.gp, [[0, -0.4], [0.2, 0], [0.33, 0.4], [0.5, 0.7]]), w: 1 }]),
    detail: `Gross profit/assets ${f(d.gp, 2)} · ROE ${f(d.roe, 1, '%')} · net margin ${f(d.margin, 1, '%')} · debt/equity ${f(d.de, 2)} · current ratio ${f(d.cr, 2)}` });

  // 4. Growth
  F.push({ id: 'growth', name: 'Growth', help: 'f_growth', weight: 1.0,
    score: blend([{ s: curve(d.revG, [[-20, -0.9], [0, -0.3], [5, 0.1], [15, 0.5], [30, 0.85]]), w: 1.2 },
      { s: curve(d.epsG, [[-40, -0.9], [0, -0.3], [10, 0.2], [25, 0.6], [50, 0.85]]), w: 1 },
      { s: curve(d.revG5, [[-5, -0.6], [0, -0.2], [8, 0.3], [20, 0.7]]), w: 0.6 }]),
    detail: `Revenue ${f(d.revG, 1, '%')} YoY · EPS ${f(d.epsG, 1, '%')} YoY · revenue 5y CAGR ${f(d.revG5, 1, '%')}` });

  // 5. Price momentum
  const mcurve = (x, k) => curve(x, [[-2.5 * k, -0.9], [-k, -0.5], [0, 0], [k, 0.5], [2.5 * k, 0.85]]);
  F.push({ id: 'momentum', name: 'Price momentum', help: 'f_momentum', weight: 1.0,
    score: blend([{ s: mcurve(d.r13, 10), w: 1 }, { s: mcurve(d.r26, 15), w: 1 }, { s: mcurve(d.r52, 20), w: 0.7 }, { s: mcurve(d.relSP, 15), w: 1 }]),
    detail: `13w ${f(d.r13, 1, '%')} · 26w ${f(d.r26, 1, '%')} · 52w ${f(d.r52, 1, '%')} · vs S&P 500 ${f(d.relSP, 1, '%')}` });

  // Trend filter: price vs. its 200-day moving average and that average's direction.
  F.push({ id: 'trend', name: 'Long-term trend (200-day)', help: 'f_trend',
    score: d.above200 == null ? null : clamp(Math.tanh(d.above200 * 8) * 0.6 + Math.tanh(d.slope200 * 40) * 0.4, -1, 1),
    detail: d.above200 == null ? 'Needs 200+ days of price history' : `Price ${(d.above200 * 100).toFixed(1)}% ${d.above200 >= 0 ? 'above' : 'below'} its 200-day average, which is ${d.slope200 >= 0 ? 'rising' : 'falling'} (${(d.slope200 * 100).toFixed(1)}% in 20 days)` });

  // 12-1 momentum: the classic academic momentum signal.
  F.push({ id: 'mom121', name: '12-1 month momentum', help: 'f_mom121',
    score: d.mom121 == null ? null : curve(d.mom121 * 100, [[-40, -0.9], [-15, -0.5], [0, -0.1], [15, 0.4], [40, 0.85]]),
    detail: d.mom121 == null ? 'Needs 1 year of price history' : `Return from 12 months ago to 1 month ago: ${(d.mom121 * 100).toFixed(1)}%` });

  // Piotroski-style F-score
  const fs = piotroski(series);
  F.push({ id: 'fscore', name: 'Financial health (F-score)', help: 'f_fscore', fscore: fs,
    score: fs ? clamp((fs.score / fs.max - 0.5) * 1.8, -1, 1) : null,
    detail: fs ? `${fs.score} of ${fs.max} health checks passed${fs.tests.some((t) => !t.pass) ? ' · failed: ' + fs.tests.filter((t) => !t.pass).map((t) => t.name.toLowerCase()).join(', ') : ''}` : 'Annual financial data not available' });

  // Insider buying vs. selling (Finnhub MSPR: −100 = all selling, +100 = all buying)
  const ins = (insider || []).slice(-6);
  const mspr = ins.length ? ins.reduce((a, x) => a + x.mspr, 0) / ins.length : null;
  F.push({ id: 'insiders', name: 'Insider buying / selling', help: 'f_insiders',
    score: mspr == null ? null : clamp(Math.tanh(mspr / 40) * (mspr > 0 ? 1 : 0.4), -1, 1), // selling counts less: it's often taxes/diversification
    detail: mspr == null ? 'No insider trades reported recently' : `Average insider sentiment (MSPR) ${mspr.toFixed(1)} over the last ${ins.length} months with filings. Routine executive selling is common, so buying is the stronger signal` });

  // 6. Traction: is volume confirming the move, and where in its 52-week range is it?
  const dir = d.ret20 != null ? Math.tanh(d.ret20 * 15) : d.r13 != null ? Math.tanh(d.r13 / 10) : null;
  const volConfirm = d.volRatio != null && dir != null ? clamp((d.volRatio - 1) / 0.5, -1, 1) * dir : null;
  F.push({ id: 'traction', name: 'Traction (volume × trend × range)', help: 'f_traction', weight: 0.9,
    score: blend([{ s: volConfirm, w: 0.6 }, { s: d.rangePos == null ? null : (d.rangePos - 0.5) * 1.2, w: 0.4 }]),
    detail: `10d/3m volume ${f(d.volRatio, 2, '×')} · 20d move ${d.ret20 == null ? 'n/a' : (d.ret20 * 100).toFixed(1) + '%'} · ${d.rangePos == null ? '' : Math.round(d.rangePos * 100) + '% of the way from 52w low to high'}` });

  // 7. Earnings surprises
  const last4 = (earnings || []).slice(0, 4).filter((e) => e.surprisePercent != null);
  F.push({ id: 'earnings', name: 'Earnings surprises', help: 'f_earnings', weight: 0.7,
    score: last4.length ? clamp((last4.filter((e) => e.surprisePercent > 0).length / last4.length - 0.5) * 1.2 + Math.tanh(last4.reduce((s, e) => s + e.surprisePercent, 0) / last4.length / 10) * 0.4, -1, 1) : null,
    detail: last4.length ? last4.map((e) => `Q${e.quarter} ${e.year}: ${e.surprisePercent > 0 ? 'beat' : 'miss'} ${e.surprisePercent.toFixed(1)}%`).join(' · ') : 'No earnings data' });

  // 8. Analysts
  const rec = recs?.[0], rec3 = recs?.[3];
  const recScore = (r) => { const t = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell; return t ? (2 * r.strongBuy + r.buy - r.sell - 2 * r.strongSell) / (2 * t) : null; };
  const rs = rec ? recScore(rec) : null, rsOld = rec3 ? recScore(rec3) : null;
  F.push({ id: 'analysts', name: 'Analyst consensus', help: 'f_analysts', weight: 0.6,
    score: rs == null ? null : clamp(rs * 1.3 - 0.15 + (rsOld != null ? (rs - rsOld) * 2 : 0), -1, 1),
    detail: rec ? `Strong buy ${rec.strongBuy} · Buy ${rec.buy} · Hold ${rec.hold} · Sell ${rec.sell} · Strong sell ${rec.strongSell}${rsOld != null ? ` · trend ${rs > rsOld ? 'improving' : rs < rsOld ? 'worsening' : 'flat'} vs 3 months ago` : ''}` : 'No analyst data' });

  // 9. News
  F.push({ id: 'news', name: 'News sentiment', help: 'f_news', weight: 0.4,
    score: news?.score == null ? null : clamp(news.score * 1.5, -1, 1),
    detail: news?.items?.length ? `${news.items.length} recent headlines, weighted toward the newest` : 'No recent news' });

  // 10. Technical / ML: only techniques that proved themselves (rating > 50) get a say
  let tml = null, tmlDetail = 'Needs price history';
  if (techResults?.results) {
    let s = 0, w = 0, used = 0;
    for (const [id, r] of Object.entries(techResults.results)) {
      if (['buyhold', 'coin', 'ensemble'].includes(id) || r.error || r.current == null) continue;
      const wt = Math.max(0, r.eval.rating - 50);
      if (wt > 0) { s += wt * r.current; w += wt; used++; }
    }
    tml = w ? clamp(s / w, -1, 1) : 0;
    tmlDetail = used ? `${used} techniques beat their baseline and voted (weighted by rating)` : 'No technique beat its baseline on this stock, so this factor stays neutral';
  }
  F.push({ id: 'technical', name: 'Technical & ML models', help: 'f_technical', weight: 1.0, score: tml, detail: tmlDetail });

  const flags = patternFlags(d, metric, last4, rs);
  F.push({ id: 'flags', name: 'Pattern flags (combined rules)', help: 'f_flags', weight: 0.8,
    score: flags.length ? clamp(flags.reduce((s, x) => s + x.bias, 0) / Math.max(1.5, flags.length), -1, 1) : null,
    detail: flags.length ? flags.map((x) => x.name).join(' · ') : 'No combo patterns triggered' });

  for (const x of F) { x.evidence = EVIDENCE[x.id] || 'Weak'; x.weight = EVIDENCE_WEIGHT[x.evidence]; }
  return { factors: F, flags, derived: d, ...combine(F) };
}

// Multi-parameter "combo" rules. Each mixes valuation with growth, momentum, volume, or quality.
export function patternFlags(d, m, last4, analyst) {
  const out = [], add = (id, name, bias, why) => out.push({ id, name, bias, why, help: 'flag_' + id });
  if (d.pe > 0 && d.pe < 12 && d.revG != null && d.revG < 0 && d.r26 != null && d.r26 < -10)
    add('valuetrap', 'Possible value trap', -0.7, `Cheap P/E (${d.pe.toFixed(1)}) but revenue shrinking (${d.revG.toFixed(1)}%) and price falling (${d.r26.toFixed(1)}% in 26w).`);
  if (d.peg != null && d.peg > 0 && d.peg < 1.2 && d.revG > 10 && d.roe > 15)
    add('garp', 'GARP sweet spot', 0.8, `PEG ${d.peg.toFixed(2)} with ${d.revG.toFixed(0)}% revenue growth and ${d.roe.toFixed(0)}% ROE: growth at a reasonable price.`);
  if (d.r13 > 10 && d.volRatio > 1.2 && d.rangePos > 0.8)
    add('breakout', 'Volume-confirmed breakout', 0.7, `Up ${d.r13.toFixed(0)}% in 13w, near 52w high, on ${d.volRatio.toFixed(2)}× normal volume.`);
  if ((d.pe > 60 || (d.pe == null && d.ps > 15)) && d.r13 > 25)
    add('froth', 'Speculative froth', -0.5, `Very rich valuation (${d.pe ? 'P/E ' + d.pe.toFixed(0) : 'P/S ' + d.ps.toFixed(0)}) after a fast ${d.r13.toFixed(0)}% run-up. Expectations are sky-high.`);
  if (d.rangePos != null && d.rangePos < 0.15 && d.volRatio > 1.4 && d.rsiNow != null && d.rsiNow < 32)
    add('capitulation', 'Capitulation / oversold', 0.4, `Near 52w low with heavy volume and RSI ${d.rsiNow.toFixed(0)}. Sellers may be exhausted (risky "catch a falling knife").`);
  if (d.roe > 20 && d.margin > 15 && d.r26 != null && d.r26 < -10 && d.pe > 0 && d.pe < 30)
    add('qualitysale', 'Quality on sale', 0.6, `High-quality business (ROE ${d.roe.toFixed(0)}%, margin ${d.margin.toFixed(0)}%) down ${Math.abs(d.r26).toFixed(0)}% at a reasonable P/E.`);
  if (d.epsG != null && d.epsG5 != null && d.epsG > d.epsG5 + 10 && last4[0]?.surprisePercent > 0)
    add('accel', 'Earnings accelerating', 0.6, `EPS growth ${d.epsG.toFixed(0)}% YoY vs ${d.epsG5.toFixed(0)}% 5y average, and the last quarter beat estimates.`);
  if (d.rsiNow > 75 && d.aboveUpperBand && d.rangePos > 0.95)
    add('overheated', 'Overheated short-term', -0.4, `RSI ${d.rsiNow.toFixed(0)}, above the upper Bollinger band, at the 52w high. Often pauses or pulls back.`);
  if (analyst != null && analyst > 0.35 && d.r13 != null && d.r13 < -10)
    add('divergence', 'Analysts vs. price divergence', 0.2, `Analysts are bullish but the price fell ${Math.abs(d.r13).toFixed(0)}% in 13w. Either an opportunity or the analysts are late.`);
  if (d.de > 2.5 && d.margin != null && d.margin < 3)
    add('leverage', 'Leverage stress', -0.6, `High debt (D/E ${d.de.toFixed(1)}) with thin margins (${d.margin.toFixed(1)}%). Little room for error.`);
  return out;
}

function combine(F) {
  const ok = F.filter((x) => x.score != null);
  if (!ok.length) return { score: null };
  const W = ok.reduce((s, x) => s + x.weight, 0);
  const score = ok.reduce((s, x) => s + x.score * x.weight, 0) / W;
  // Agreement: how much of the weight points the same way as the overall verdict.
  const agree = ok.filter((x) => Math.sign(x.score) === Math.sign(score) && Math.abs(x.score) > 0.05).reduce((s, x) => s + x.weight, 0) / W;
  const coverage = ok.length / F.length;
  const confidence = Math.round(clamp(Math.abs(score) * 120 * (0.4 + 0.6 * agree) * (0.5 + 0.5 * coverage), 0, 95));
  const verdict = Math.abs(score) < 0.08 ? 'Neutral' : score > 0 ? 'Bullish' : 'Bearish';
  const strength = confidence >= 60 ? 'Strong' : confidence >= 30 ? 'Moderate' : 'Weak';
  return { score, agree, coverage, confidence, verdict, strength };
}
