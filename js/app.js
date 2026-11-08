import { api, history, intraday, keys, store, finnhubLimiter, twelveLimiter, LiveFeed } from './api.js';
import { TECHNIQUES, runAll } from './techniques.js';
import { computeFactors } from './heuristics.js';
import { scoreNews } from './sentiment.js';
import { GLOSSARY } from './glossary.js';
import * as Charts from './charts.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = (key) => `<button class="q" data-help="${key}" aria-label="Explain this">?</button>`;
const ok = (v) => v != null && Number.isFinite(+v);
const fmt = {
  money: (v) => (ok(v) ? '$' + (+v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'),
  pct: (v, d = 2) => (ok(v) ? (v > 0 ? '+' : '') + (+v).toFixed(d) + '%' : '—'),
  num: (v, d = 2) => (ok(v) ? (+v).toFixed(d) : '—'),
  big: (v) => (!ok(v) ? '—' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v).toLocaleString()),
  shares: (v) => (!ok(v) ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v)),
};
const signalWord = (s) => (s == null ? 'n/a' : s > 0.6 ? 'Strongly bullish' : s > 0.2 ? 'Bullish' : s > 0.02 ? 'Slightly bullish' : s < -0.6 ? 'Strongly bearish' : s < -0.2 ? 'Bearish' : s < -0.02 ? 'Slightly bearish' : 'Neutral');
const sigPill = (s) => `<span class="pill ${s > 0.02 ? 'bull' : s < -0.02 ? 'bear' : 'neu'}">${signalWord(s)}</span>`;
const verdictPill = (c) => (c?.verdict ? `<span class="pill ${c.verdict === 'Bullish' ? 'bull' : c.verdict === 'Bearish' ? 'bear' : 'neu'}">${c.verdict} · ${c.confidence}%</span>` : '<span class="pill neu">…</span>');
const gradeBadge = (ev) => (ev && !ev.insufficient ? `<span class="badge g-${ev.grade}">${ev.grade} ${ev.rating}</span>` : '<span class="badge">—</span>');

// ---------- motion ----------
// render() rebuilds the HTML, so a plain CSS animation would restart every time a background fetch lands.
// Instead each animated region has a key. When the key changes we note the time. Re-renders inside the animation
// window resume the same animation through a negative animation-delay (--tg for the card grid, --ts for a single
// region). Once the window has passed, the region renders static. See the "motion" section in styles.css.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const ANIM_MS = 1100;
const marks = {};
function anim(slot, key, { onFirst = false, cssVar = '--ts' } = {}) {
  const now = performance.now(), m = marks[slot];
  if (!m) marks[slot] = { key, at: onFirst ? now : -Infinity };
  else if (m.key !== key) marks[slot] = { key, at: now };
  const t = now - marks[slot].at;
  return t < ANIM_MS ? ` data-anim style="${cssVar}:${-Math.round(t)}ms"` : '';
}

// FLIP: remember where things were before a render, then animate them from there to their new spot.
// Covers watchlist cards sliding over when one is removed, and the active pill of the range buttons, horizon
// switch and technique list gliding to the newly selected item (the pill is each button's ::before).
const PILLS = ['.ranges button.on', '.seg button.on', '.tech.on'];
function snapshot() {
  return {
    cards: new Map([...document.querySelectorAll('.wcard[data-sel]')].map((el) => [el.dataset.sel, el.getBoundingClientRect()])),
    pills: PILLS.map((sel) => $(sel)?.getBoundingClientRect()),
  };
}
const EASE_OUT = 'cubic-bezier(.2,.75,.2,1)';
function playFlips(snap) {
  if (reduceMotion.matches || !Element.prototype.animate) return;
  document.querySelectorAll('.wcard[data-sel]').forEach((el) => {
    const r0 = snap.cards.get(el.dataset.sel);
    if (!r0) return;
    const dx = r0.left - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 320, easing: EASE_OUT });
  });
  PILLS.forEach((sel, i) => {
    const r0 = snap.pills[i], el = $(sel);
    if (!r0 || !el) return;
    const r1 = el.getBoundingClientRect();
    if (!r0.width || !r1.width) return; // hidden (e.g. collapsed mobile sidebar)
    const dx = r0.left - r1.left, dy = r0.top - r1.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    try {
      el.animate([
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${r0.width / r1.width}, ${r0.height / r1.height})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration: 300, easing: EASE_OUT, pseudoElement: '::before' });
    } catch { /* older browsers: pill just jumps */ }
  });
}
// Fade/shrink an element out, then run `done` (used when removing a watchlist card).
function exitThen(el, done) {
  if (!el || reduceMotion.matches || !el.animate) return done();
  el.style.pointerEvents = 'none';
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' })
    .finished.then(done, done);
}

// ---------- state ----------
const S = {
  watch: store.get('watchlist', ['AAPL', 'MSFT', 'NVDA']),
  selected: store.get('selected', null),
  tech: store.get('tech', 'linreg'),
  H: store.get('horizon', 5),
  range: store.get('range', '1Y'),
  data: {},
};
// Chart / change ranges. Days = trading days back. 1D and 1W draw intraday bars; the rest use daily bars.
const RANGES = [['1D', 1], ['1W', 5], ['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 252], ['2Y', 504], ['5Y', 1260], ['All', Infinity]];
const RANGE_DAYS = Object.fromEntries(RANGES);
const INTRADAY = { '1D': 5 * 60_000, '1W': 30 * 60_000 }; // refresh age
if (!(S.range in RANGE_DAYS)) S.range = '1Y';
if (!S.watch.includes(S.selected)) S.selected = S.watch[0] || null;
if (!TECHNIQUES.some((t) => t.id === S.tech)) S.tech = 'linreg';
const save = () => { store.set('watchlist', S.watch); store.set('selected', S.selected); store.set('tech', S.tech); store.set('horizon', S.H); store.set('range', S.range); };

// ---------- data loading ----------
function loadSymbol(sym) {
  const d = (S.data[sym] ||= { errors: {} });
  const tasks = {
    quote: () => api.quote(sym, true),
    profile: () => api.profile(sym),
    metric: () => api.metric(sym).then((r) => { d.series = r.series; return r.metric || {}; }),
    insider: () => api.insider(sym),
    recs: () => api.recs(sym),
    earnings: () => api.earnings(sym),
    news: () => api.news(sym).then(scoreNews),
  };
  const jobs = Object.entries(tasks).map(([k, fn]) => fn().then((v) => { d[k] = v; delete d.errors[k]; }).catch((e) => { d.errors[k] = e.message; }).finally(scheduleRender));
  // Price history waits for the quote so simulated fallback data can be anchored to the real price.
  // Skip history entirely when there is no real quote (unsupported symbol): simulated charts would be meaningless.
  jobs[0].then(() => (d.quote?.c ? history(sym, d.quote) : null)).then((h) => { if (!h) return; d.hist = h; d.analysis = {}; scheduleRender(); });
}
function analysis(sym) {
  const d = S.data[sym];
  if (!d?.hist) return null;
  if (d.hist.close.length < 160) return { tooShort: true };
  d.analysis ||= {};
  if (!d.analysis[S.H]) d.analysis[S.H] = runAll(d.hist, S.H, sym);
  return d.analysis[S.H];
}
function composite(sym) {
  const d = S.data[sym];
  if (!d) return null;
  const A = analysis(sym);
  return computeFactors({ metric: d.metric || {}, series: d.series, insider: d.insider, quote: d.quote, recs: d.recs, earnings: d.earnings, news: d.news, techResults: A?.P && !d.hist.simulated ? A : null });
}

// ---------- live prices ----------
const pendingTicks = {};
const live = new LiveFeed(
  (sym, price) => { pendingTicks[sym] = price; },
  () => updateStatus(),
);
setInterval(() => {
  for (const [sym, price] of Object.entries(pendingTicks)) {
    const d = S.data[sym]; delete pendingTicks[sym];
    if (!d?.quote) continue;
    const old = d.quote.c;
    d.quote = { ...d.quote, c: price, d: price - d.quote.pc, dp: ((price - d.quote.pc) / d.quote.pc) * 100 };
    paintPrice(sym, price > old ? 'up' : price < old ? 'down' : null);
  }
}, 1000);
// Price change over the selected range: live price vs. the close N trading days ago.
function changeFor(sym) {
  const d = S.data[sym], qd = d?.quote, h = d?.hist;
  if (!qd?.c) return null;
  if (S.range === '1D' || !h || h.simulated) return { d: qd.d, dp: qd.dp, label: 'today' };
  const n = h.close.length, days = RANGE_DAYS[S.range];
  // Is the newest daily bar today's (in-progress) session? Then count back from it; otherwise from the last close.
  const qDate = new Date(qd.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let i = (h.dates[n - 1] === qDate ? n - 1 : n) - days, label = 'past ' + S.range;
  if (!Number.isFinite(i) || i < 0) { i = 0; label = 'since ' + h.dates[0].slice(0, 4); }
  const base = h.close[i];
  return { d: qd.c - base, dp: ((qd.c - base) / base) * 100, label };
}
const chgHTML = (sym) => { const c = changeFor(sym); return c ? `${c.d >= 0 ? '+' : ''}${fmt.num(c.d)} (${fmt.pct(c.dp)}) <span class="muted chg-l">${c.label}</span>` : ''; };
const chgCls = (sym) => ((changeFor(sym)?.d ?? 0) >= 0 ? 'up' : 'down');
function paintPrice(sym, dir) {
  const qd = S.data[sym]?.quote; if (!qd) return;
  document.querySelectorAll(`[data-px="${sym}"]`).forEach((el) => {
    el.textContent = fmt.money(qd.c);
    if (dir) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add('flash-' + dir); }
  });
  document.querySelectorAll(`[data-chg="${sym}"]`).forEach((el) => {
    el.innerHTML = chgHTML(sym);
    el.className = el.className.replace(/\b(up|down)\b/g, '').trim() + ' ' + chgCls(sym);
  });
}

// REST polling: keep the whole watchlist under ~20 calls/min (≈5/min when the WebSocket is live).
function pollEveryMs() {
  const perMin = live.status === 'live' ? 5 : 20;
  return Math.max(15_000, (Math.max(1, S.watch.length) * 60_000) / perMin);
}
async function pollLoop() {
  if (!document.hidden && keys.finnhub) {
    await Promise.all(S.watch.map((sym) => api.quote(sym).then((qd) => {
      const d = S.data[sym]; if (!d || !qd?.c) return;
      const old = d.quote?.c; d.quote = qd; paintPrice(sym, old && qd.c !== old ? (qd.c > old ? 'up' : 'down') : null);
    }).catch(() => {})));
  }
  setTimeout(pollLoop, pollEveryMs());
}
function updateStatus() {
  const st = live.status;
  $('#liveDot').className = 'dot ' + (st === 'live' ? 'live' : st === 'off' ? '' : 'connecting');
  $('#liveText').textContent = st === 'live' ? 'Live via WebSocket' : st === 'off' ? 'No API key' : st === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  const pend = finnhubLimiter.pending() + twelveLimiter.pending();
  $('#budget').textContent = `${finnhubLimiter.used()}/60 calls/min · quotes every ${Math.round(pollEveryMs() / 1000)}s${pend ? ` · ${pend} queued` : ''}`;
}
setInterval(updateStatus, 1500);

// ---------- rendering ----------
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }
function render() { const snap = snapshot(); renderSidebar(); renderWatchlist(); renderDetail(); playFlips(snap); }

function renderSidebar() {
  const A = S.selected ? analysis(S.selected) : null;
  const groups = [...new Set(TECHNIQUES.map((t) => t.group))];
  let h = `<div class="side-h">Prediction horizon ${q('horizon')}</div>
    <div class="seg">${[[1, '1 day'], [5, '1 week'], [20, '1 month']].map(([v, l]) => `<button data-h="${v}" class="${S.H === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  for (const g of groups) {
    h += `<div class="side-h">${g}</div>`;
    for (const t of TECHNIQUES.filter((x) => x.group === g)) {
      const r = A?.results?.[t.id];
      h += `<div class="tech ${S.tech === t.id ? 'on' : ''}" data-tech="${t.id}" role="button" tabindex="0">
        <span class="nm">${t.name}</span>${r?.eval ? gradeBadge(r.eval) : '<span class="badge">—</span>'}${q(t.help)}</div>`;
    }
  }
  h += `<div class="side-note">Grades show how each technique would have done on <b>${S.selected || 'the selected stock'}</b> over recent data it never trained on.
    ${q('rating')} How grades work · ${q('walkforward')} No peeking · ${q('trainacc')} Overfitting</div>`;
  // Grade badges pop in when results for a new stock / horizon arrive.
  $('#sidebar').innerHTML = `<div class="side-in"${anim('side', `${S.selected}|${S.H}|${!!A?.results}`)}>${h}</div>`;
}

function renderWatchlist() {
  $('#watchlist').innerHTML = S.watch.map((sym) => {
    const d = S.data[sym], qd = d?.quote, c = d ? composite(sym) : null;
    return `<div class="wcard ${sym === S.selected ? 'on' : ''}" data-sel="${sym}" role="button" tabindex="0"${anim('w:' + sym, 1)}>
      <button class="x" data-remove="${sym}" aria-label="Remove ${sym}">✕</button>
      <div class="s">${sym}</div>
      <div class="p" data-px="${sym}">${qd?.c ? fmt.money(qd.c) : '…'}</div>
      <div class="mono ${chgCls(sym)}" data-chg="${sym}">${chgHTML(sym)}</div>
      ${verdictPill(c)}</div>`;
  }).join('') || '<div class="muted">Your watchlist is empty. Search for a ticker above.</div>';
}

function renderDetail() {
  const el = $('#detail'), sym = S.selected;
  if (!keys.finnhub) { el.innerHTML = introHTML(); return; }
  if (!sym) { el.innerHTML = `<div class="empty"><h2>Search a ticker to begin</h2><p>Try AAPL, MSFT, TSLA, KO or SPY in the search box above.</p></div>`; return; }
  const d = S.data[sym];
  if (!d) { el.innerHTML = `<div class="skeleton">Loading ${esc(sym)}…</div>`; return; }
  const qd = d.quote, p = d.profile || {}, m = d.metric || {}, A = analysis(sym), comp = composite(sym);
  const T = TECHNIQUES.find((t) => t.id === S.tech), r = A?.results?.[S.tech];

  // banners
  let banners = '';
  // Group identical error messages so one root cause shows as one line.
  const byMsg = {};
  for (const [k, v] of Object.entries(d.errors)) (byMsg[v] ||= []).push(k);
  const base = sym.includes('.') ? sym.split('.')[0] : null;
  const suggest = base ? ` This looks like a foreign listing. Try the US ticker <button class="btn" data-add="${esc(base)}" style="padding:2px 10px">${esc(base)}</button>` : '';
  const msgs = Object.entries(byMsg);
  if (msgs.length) banners += `<div class="banner err">${msgs.map(([m, ks]) => `<div>${esc(m)}${ks.length < 6 ? ` <span class="muted">(${ks.join(', ')})</span>` : ''}</div>`).join('')}${suggest ? `<div style="margin-top:6px">${suggest}</div>` : ''}</div>`;
  else if (qd && !qd.c) banners +=`<div class="banner err">Finnhub returned no quote for <b>${esc(sym)}</b>. The free plan covers US-listed stocks and ETFs. Check the symbol.</div>`;
  if (d.hist?.simulated) banners += `<div class="banner warn"><b>⚠ Simulated price history.</b> ${esc(d.hist.simulatedReason)} The charts and ML grades below run on <b>random synthetic prices</b> so you can explore the tools. Don’t interpret them. Add a free Twelve Data key in ⚙ Settings for real history. ${q('datasource')}</div>`;
  if (d.errors.quote && !qd) { el.innerHTML = banners; return; } // nothing loadable: don't show endless "Loading…" cards
  if (A?.tooShort) banners +=`<div class="banner warn">Not enough price history (need ~160 trading days) to run the techniques for ${esc(sym)}.</div>`;

  const hero = `<div class="card span-12"><div class="hero">
    ${p.logo ? `<img src="${esc(p.logo)}" alt="" onerror="this.remove()">` : ''}
    <div><div class="nm">${esc(p.name || sym)} <span class="muted" style="font-weight:500">${esc(sym)}</span></div>
      <div class="sub">${[p.exchange, p.finnhubIndustry, p.country].filter(Boolean).map(esc).join(' · ') || (m['52WeekHigh'] ? 'ETF / fund (company profile not available)' : '')}</div></div>
    <div><div class="px" data-px="${sym}">${qd?.c ? fmt.money(qd.c) : '…'}</div>
      <div class="chg ${chgCls(sym)}" data-chg="${sym}">${chgHTML(sym)} ${q('chgperiod')}</div></div>
    <div class="verdict">${comp?.verdict ? `<div class="big ${comp.verdict === 'Bullish' ? 'up' : comp.verdict === 'Bearish' ? 'down' : ''}">${comp.strength} ${comp.verdict}</div>
      <div class="muted">confidence ${comp.confidence}% ${q('confidence')}</div>` : ''}</div>
  </div></div>`;

  const isIntra = S.range in INTRADAY;
  const it = isIntra ? intradayFor(sym, d) : null;
  const rangeBtns = `<span class="right ranges">${RANGES.map(([l]) => `<button data-range="${l}" class="${S.range === l ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  const chartCard = isIntra ? `<div class="card span-8">
    <h3>${S.range === '1D' ? 'Today' : 'Past week'} · intraday ${q('chgperiod')}${rangeBtns}</h3>
    ${it?.data ? `<div class="chart-main"><canvas id="cMain"></canvas></div><div class="muted" style="font-size:11.5px;margin-top:6px">Volume ${q('volume')}</div><div class="chart-sub"><canvas id="cSub"></canvas></div>
      <div class="muted" style="font-size:12px;margin-top:8px">The techniques work on daily bars, so pick 1M or longer to see the <b>${T.name}</b> overlay.</div>`
      : `<div class="skeleton">${it?.error ? esc(it.error) : 'Loading intraday prices…'}</div>`}
  </div>` : `<div class="card span-8">
    <h3>${T.name} ${q(T.help)}${rangeBtns}</h3>
    ${A?.P ? `<div class="chart-main"><canvas id="cMain"></canvas></div>
      <div class="muted" style="font-size:11.5px;margin-top:6px">${r?.sub?.title && !r.sub.volume ? esc(r.sub.title) : r?.sub?.title || 'Volume'} ${r?.sub && !r.sub.volume ? '' : q('volume')}</div>
      <div class="chart-sub"><canvas id="cSub"></canvas></div>`
      : `<div class="skeleton">${d.hist ? 'Not enough history to chart.' : 'Loading price history…'}</div>`}
  </div>`;

  // These two cards swap their content in (ring, bars, gauge needle) when what they show changes.
  const techCard = `<div class="card span-4"${anim('tech', `${sym}|${S.tech}|${S.H}|${!!r?.eval}`)}>${techReport(T, r, A)}</div>`;
  const confCard = `<div class="card span-7"${anim('conf', `${sym}|${S.H}|${comp?.score != null}`)}>${confidenceCard(comp)}</div>`;
  const statsCard = `<div class="card span-5"><h3>Key stats</h3>${statsGrid(d, A, comp)}</div>`;
  const board = A?.results ? `<div class="card span-12">${leaderboard(A)}</div>` : '';
  const newsCard = `<div class="card span-12">${newsList(d.news)}</div>`;

  // Cards rise in with a stagger when a stock is first shown (or on page load).
  el.innerHTML = banners + `<div class="grid"${anim('grid', sym, { onFirst: true, cssVar: '--tg' })}>${hero}${chartCard}${techCard}${confCard}${statsCard}${board}${newsCard}</div>`;

  const tech = r && !r.error ? r : null;
  if (isIntra && it?.data) Charts.renderIntraday($('#cMain'), $('#cSub'), it.data, S.range);
  else if (!isIntra && A?.P) {
    const span = Math.min(RANGE_DAYS[S.range], 1e6);
    Charts.renderPrice($('#cMain'), { P: A.P, tech, range: span, simulated: d.hist.simulated });
    const future = (tech?.overlays || []).some((o) => o.data.length > A.P.n) ? A.P.H : 0;
    Charts.renderSub($('#cSub'), { P: A.P, tech, range: span, extraLabels: future });
  }
  if (tech?.eval && $('#cEq')) Charts.renderEquity($('#cEq'), tech.eval);
}

// Intraday bars for 1D / 1W, fetched on demand and refreshed when stale.
function intradayFor(sym, d) {
  const box = ((d.intra ||= {})[S.range] ||= {});
  const stale = !box.t || Date.now() - box.t > INTRADAY[S.range];
  if (stale && !box.loading && !(box.error && Date.now() - box.t < 60_000)) {
    box.loading = true;
    const range = S.range;
    intraday(sym, range).then((data) => { box.data = data; box.error = null; })
      .catch((e) => { box.error = e.message; })
      .finally(() => { box.loading = false; box.t = Date.now(); if (S.selected === sym && S.range === range) scheduleRender(); });
  }
  return box;
}

function techReport(T, r, A) {
  if (!A) return `<h3>Technique report</h3><div class="skeleton">Waiting for price history…</div>`;
  if (A.tooShort) return `<h3>Technique report</h3><div class="skeleton">Not enough history.</div>`;
  if (!r || r.error) return `<h3>${T.name}</h3><div class="banner warn">${esc(r?.error || 'Unavailable')}</div>`;
  const e = r.eval, colorVar = { A: '--up', B: '--up', C: '--muted', D: '--warn', F: '--down' }[e.grade] || '--muted';
  const zLabel = !ok(e.z) ? '' : Math.abs(e.z) < 1 ? 'likely luck' : e.z >= 2 ? 'unlikely to be luck' : e.z > 0 ? 'suggestive edge' : e.z > -2 ? 'worse than baseline' : 'reliably worse';
  const pos = r.current == null ? 50 : ((r.current + 1) / 2) * 100;
  let h = `<h3>Technique report ${q('rating')}</h3>`;
  if (e.insufficient) h += `<div class="banner warn">Too few predictions (${e.n}) to grade fairly.</div>`;
  else h += `<div class="score-row"><div class="ring" style="--v:${e.rating};--c:var(${colorVar})"><div><span><b>${e.grade}</b><br><small>${e.rating}/100</small></span></div></div>
    <div><div style="font-weight:600">${T.name}</div><div class="muted" style="font-size:12px">${A.P.H}-day horizon · tested on ${e.testDays} days since ${e.testFrom}</div></div></div>
    <div class="kv">
      <span class="k">Hit rate ${q('hitrate')}</span><span class="v">${(e.acc * 100).toFixed(1)}%</span>
      <span class="k">Baseline ${q('baseline')}</span><span class="v">${(e.baseAcc * 100).toFixed(1)}%</span>
      <span class="k">Edge over baseline</span><span class="v ${e.edge > 0 ? 'up' : e.edge < 0 ? 'down' : ''}">${e.edge > 0 ? '+' : ''}${(e.edge * 100).toFixed(1)} pts</span>
      <span class="k">Is it luck? (z) ${q('zscore')}</span><span class="v">${fmt.num(e.z)} · ${zLabel}</span>
      <span class="k">Coverage ${q('coverage')}</span><span class="v">${(e.coverage * 100).toFixed(0)}% of days</span>
      <span class="k">Strategy vs buy & hold ${q('strategy')}</span><span class="v"><span class="${e.stratRet >= e.bhRet ? 'up' : 'down'}">${fmt.pct(e.stratRet * 100, 1)}</span> vs ${fmt.pct(e.bhRet * 100, 1)}</span>
      <span class="k">Sharpe ratio ${q('sharpe')}</span><span class="v">${fmt.num(e.sharpe)}</span>
      ${r.trainAcc != null ? `<span class="k">Train → test accuracy ${q('trainacc')}</span><span class="v">${(r.trainAcc * 100).toFixed(1)}% → ${(e.acc * 100).toFixed(1)}%</span>` : ''}
    </div>`;
  h += `<div style="margin-top:12px;font-size:12px" class="muted">Signal today: <b style="color:var(--text)">${signalWord(r.current)}</b></div>
    <div class="sigbar"><i style="left:${pos}%"></i></div>
    <div class="muted" style="display:flex;justify-content:space-between;font-size:10.5px"><span>Bearish</span><span>Bullish</span></div>`;
  if (r.info?.length) h += `<ul class="info">${r.info.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (r.weights) {
    const max = Math.max(...r.weights.map((w) => Math.abs(w.w))) || 1;
    h += `<div class="weights"><div class="muted" style="margin-bottom:4px">What the model learned (feature weights):</div>${r.weights.map((w) => {
      const wd = (Math.abs(w.w) / max) * 50;
      return `<div class="w"><span>${w.name}</span><div class="wbar"><span class="${w.w >= 0 ? '' : 'neg'}" style="left:${w.w >= 0 ? 50 : 50 - wd}%;width:${wd}%;background:var(${w.w >= 0 ? '--up' : '--down'})"></span></div><span class="mono" style="text-align:right">${w.w.toFixed(2)}</span></div>`;
    }).join('')}</div>`;
  }
  if (!e.insufficient) h += `<div class="muted" style="font-size:11.5px;margin-top:12px">Growth of $1 during the test period ${q('strategy')}</div><div class="chart-eq"><canvas id="cEq"></canvas></div>`;
  return h;
}

function confidenceCard(c) {
  if (!c || c.score == null) return `<h3>Bull / bear confidence ${q('confidence')}</h3><div class="skeleton">Gathering data…</div>`;
  const ang = Math.max(-1, Math.min(1, c.score)) * 90;
  const gauge = `<svg class="gauge" viewBox="0 0 200 122" role="img" aria-label="${c.verdict} gauge">
    <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" style="stop-color:var(--down)"/><stop offset=".5" style="stop-color:var(--surface-2)"/><stop offset="1" style="stop-color:var(--up)"/></linearGradient></defs>
    <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#gg)" stroke-width="16" stroke-linecap="round"/>
    <line class="needle" x1="100" y1="100" x2="100" y2="34" style="stroke:var(--text);transform:rotate(${ang}deg)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="100" cy="100" r="6" style="fill:var(--text)"/>
    <text x="14" y="120" font-size="10" style="fill:var(--muted)">Bearish</text><text x="186" y="120" font-size="10" text-anchor="end" style="fill:var(--muted)">Bullish</text></svg>`;
  const rows = c.factors.map((f) => {
    const s = f.score, w = s == null ? 0 : Math.abs(s) * 50;
    return `<div class="factor"><span class="fn">${f.name} ${q(f.help)} <span class="ev ev-${f.evidence}">${f.evidence}</span></span>
      <div class="dbar">${s == null ? '' : `<span class="${s >= 0 ? '' : 'neg'}" style="left:${s >= 0 ? 50 : 50 - w}%;width:${w}%;background:var(${s >= 0 ? '--up' : '--down'})"></span>`}</div>
      <span class="mono" style="text-align:right">${s == null ? 'n/a' : (s > 0 ? '+' : '') + s.toFixed(2)}</span>
      <span class="fd">${esc(f.detail)}</span></div>`;
  }).join('');
  const flags = c.flags.length ? `<div class="flags">${c.flags.map((f) => `<div class="flag"><span>${f.bias > 0 ? '🟢' : '🔴'}</span><div><b>${f.name}</b> ${q(f.help)}<div class="muted" style="font-size:12px">${esc(f.why)}</div></div></div>`).join('')}</div>` : '';
  return `<h3>Bull / bear confidence ${q('confidence')}</h3>
    <div class="gauge-wrap">${gauge}<div>
      <div style="font-size:22px;font-weight:700" class="${c.verdict === 'Bullish' ? 'up' : c.verdict === 'Bearish' ? 'down' : ''}">${c.strength} ${c.verdict}</div>
      <div>Confidence <b>${c.confidence}%</b> · score ${c.score > 0 ? '+' : ''}${c.score.toFixed(2)}</div>
      <div class="muted" style="font-size:12px">Factor agreement ${(c.agree * 100).toFixed(0)}% · data coverage ${(c.coverage * 100).toFixed(0)}%</div>
      <div class="muted" style="font-size:11.5px;margin-top:6px">A transparent checklist, not a prediction. Not financial advice.</div></div></div>
    ${flags}<div class="muted" style="margin-top:12px;font-size:12px;display:flex;align-items:center;gap:6px">Factors are weighted by how much research supports them ${q('evidence')}</div>
    <div style="margin-top:4px">${rows}</div>`;
}

function statsGrid(d, A, comp) {
  const dv = comp?.derived || {}, fs = comp?.factors?.find((f) => f.id === 'fscore')?.fscore, ins = (d.insider || []).slice(-6);
  const qd = d.quote || {}, m = d.metric || {}, p = d.profile || {}, h = d.hist;
  const last = h && !h.simulated ? h.close.length - 1 : -1;
  const cap = p.marketCapitalization || m.marketCapitalization;
  const peg = m.pegTTM ?? (m.peTTM > 0 && m.epsGrowth5Y > 0 ? m.peTTM / m.epsGrowth5Y : null);
  const items = [
    ['Price', fmt.money(qd.c), 'price'],
    ['Day change', qd.c ? fmt.pct(qd.dp) : '—', 'change'],
    ['Open / High / Low', qd.c ? `${fmt.num(qd.o)} / ${fmt.num(qd.h)} / ${fmt.num(qd.l)}` : '—', 'ohl'],
    ['Previous close', fmt.money(qd.pc), 'prevclose'],
    [`Volume${last >= 0 ? ' (' + h.dates[last].slice(5) + ')' : ''}`, last >= 0 ? fmt.shares(h.volume[last]) : '—', 'volume'],
    ['Avg volume 10d / 3m', ok(m['10DayAverageTradingVolume']) ? `${fmt.num(m['10DayAverageTradingVolume'], 1)}M / ${fmt.num(m['3MonthAverageTradingVolume'], 1)}M` : '—', 'avgvolume'],
    ['Market cap', cap ? fmt.big(cap * 1e6) : '—', 'marketcap'],
    ['Net assets (ETFs)', p.name ? 'n/a for stocks' : 'paid data', 'netassets'],
    ['P/E (TTM)', ok(m.peTTM) ? fmt.num(m.peTTM, 1) : m.epsTTM < 0 ? 'neg. earnings' : '—', 'pe'],
    ['Forward P/E', fmt.num(m.forwardPE, 1), 'forwardpe'],
    ['PEG', fmt.num(peg), 'peg'],
    ['EPS (TTM)', ok(m.epsTTM) ? fmt.money(m.epsTTM) : '—', 'eps'],
    ['P/S', fmt.num(m.psTTM, 1), 'ps'],
    ['P/B', fmt.num(m.pbAnnual ?? m.pb, 1), 'pb'],
    ['ROE', fmt.pct(m.roeTTM, 1).replace('+', ''), 'roe'],
    ['Net margin', fmt.pct(m.netProfitMarginTTM, 1).replace('+', ''), 'margin'],
    ['Debt / equity', fmt.num(m['totalDebt/totalEquityQuarterly'] ?? m['totalDebt/totalEquityAnnual']), 'de'],
    ['Current ratio', fmt.num(m.currentRatioQuarterly ?? m.currentRatioAnnual), 'currentratio'],
    ['Beta', fmt.num(m.beta), 'beta'],
    ['Dividend yield', ok(m.dividendYieldIndicatedAnnual) ? fmt.num(m.dividendYieldIndicatedAnnual) + '%' : '—', 'divyield'],
    ['52-week range', ok(m['52WeekLow']) ? `${fmt.num(m['52WeekLow'])} – ${fmt.num(m['52WeekHigh'])}` : '—', 'range52'],
    ['vs S&P 500 (52w)', fmt.pct(m['priceRelativeToS&P50052Week'], 1), 'relsp'],
    ['RSI (14)', A?.P ? fmt.num(A.P.rsi[A.P.n - 1], 1) : '—', 'rsi'],
    ['vs 200-day average', dv.above200 != null ? fmt.pct(dv.above200 * 100, 1) : '—', 'sma200'],
    ['12-1 momentum', dv.mom121 != null ? fmt.pct(dv.mom121 * 100, 1) : '—', 'f_mom121'],
    ['FCF yield', ok(dv.fcfYield) && dv.fcfYield !== -2 ? fmt.num(dv.fcfYield, 1) + '%' : dv.fcfYield === -2 ? 'negative FCF' : '—', 'fcfyield'],
    ['Gross profit / assets', fmt.num(dv.gp), 'gp'],
    ['F-score', fs ? `${fs.score} / ${fs.max}` : '—', 'f_fscore'],
    ['Insider sentiment (MSPR)', ins.length ? fmt.num(ins.reduce((a, x) => a + x.mspr, 0) / ins.length, 1) : '—', 'f_insiders'],
  ];
  return `<div class="stats">${items.map(([l, v, k]) => `<div class="stat"><div class="l"><span>${l}</span>${q(k)}</div><div class="v">${v}</div></div>`).join('')}</div>`;
}

function leaderboard(A) {
  const rows = TECHNIQUES.map((t) => ({ t, r: A.results[t.id] })).filter((x) => x.r?.eval)
    .sort((a, b) => b.r.eval.rating - a.r.eval.rating);
  return `<h3>Technique leaderboard for this stock <span class="muted" style="font-weight:400">(${A.P.H}-day horizon, out-of-sample)</span> ${q('rating')}</h3>
  <div class="tbl-wrap"><table><thead><tr><th>Technique</th><th>Grade</th><th class="num">Hit rate ${q('hitrate')}</th><th class="num">Baseline ${q('baseline')}</th>
    <th class="num">Edge</th><th class="num">z ${q('zscore')}</th><th class="num">Strategy / B&amp;H ${q('strategy')}</th><th>Signal now</th></tr></thead><tbody>
  ${rows.map(({ t, r }) => { const e = r.eval; return `<tr data-tech="${t.id}" class="${S.tech === t.id ? 'on' : ''}"><td>${t.name} <span class="muted" style="font-size:11px">${t.group}</span></td><td>${gradeBadge(e)}</td>
    <td class="num">${e.insufficient ? '—' : (e.acc * 100).toFixed(1) + '%'}</td><td class="num">${e.insufficient ? '—' : (e.baseAcc * 100).toFixed(1) + '%'}</td>
    <td class="num ${e.edge > 0 ? 'up' : e.edge < 0 ? 'down' : ''}">${e.insufficient ? '—' : (e.edge > 0 ? '+' : '') + (e.edge * 100).toFixed(1)}</td>
    <td class="num">${e.insufficient ? '—' : fmt.num(e.z, 1)}</td><td class="num">${fmt.pct(e.stratRet * 100, 0)} / ${fmt.pct(e.bhRet * 100, 0)}</td><td>${sigPill(r.current)}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function newsList(news) {
  const head = `<h3>News sentiment ${q('f_news')} ${news?.score != null ? `<span class="right">${sigPill(news.score)}</span>` : ''}</h3>`;
  if (!news) return head + '<div class="skeleton">Loading headlines…</div>';
  if (!news.items.length) return head + '<div class="muted">No headlines in the last 10 days.</div>';
  return head + `<div class="news">${news.items.slice(0, 12).map((a) => {
    const s = a.sentiment, bg = s > 0.05 ? '--up' : s < -0.05 ? '--down' : '--muted';
    const words = a.hits.map((h) => `${h.v > 0 ? '+' : '−'}${h.w}`).join(', ');
    return `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(words ? 'Words that moved the score: ' + words : 'No sentiment words found')}">
      <span class="sent" style="background:color-mix(in srgb, var(${bg}) 16%, transparent);color:var(${bg})">${s > 0 ? '+' : ''}${s.toFixed(2)}</span>
      <span><span class="hl">${esc(a.headline)}</span><div class="meta">${esc(a.source)} · ${new Date(a.datetime * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></span></a>`;
  }).join('')}</div>`;
}

// ---------- help dialog ----------
function openHelp(key) {
  const g = GLOSSARY[key];
  if (!g) return;
  $('#helpBody').innerHTML = `<h2>${esc(g.t)}</h2><h4>What it is</h4><p>${esc(g.what)}</p>${g.read ? `<h4>How to read it</h4><p>${esc(g.read)}</p>` : ''}${g.watch ? `<h4>Watch out</h4><p>${esc(g.watch)}</p>` : ''}`;
  $('#helpDlg').showModal();
}

// ---------- watchlist actions ----------
function addSymbol(sym) {
  sym = sym.trim().toUpperCase();
  if (!sym) return;
  if (!S.watch.includes(sym)) { S.watch.push(sym); live.subscribe(sym); loadSymbol(sym); marks['w:' + sym] = { key: 1, at: performance.now() }; }
  S.selected = sym; save(); render();
}
function removeSymbol(sym) {
  S.watch = S.watch.filter((s) => s !== sym); live.unsubscribe(sym); delete S.data[sym];
  if (S.selected === sym) S.selected = S.watch[0] || null;
  save(); render();
}

// ---------- search ----------
let searchTimer, searchItems = [], foreignItems = [], activeIdx = -1;
const input = $('#search'), resultsEl = $('#results');
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const qv = input.value.trim();
  if (qv.length < 1) { resultsEl.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api.search(qv);
      if (input.value.trim() !== qv) return;
      // Symbols with an exchange suffix (VOOG.MX, SHOP.TO…) are foreign listings that the free plan can't load.
      const all = (res.result || []).filter((x) => x.symbol);
      searchItems = all.filter((x) => !x.symbol.includes('.')).slice(0, 8);
      foreignItems = all.filter((x) => x.symbol.includes('.')).slice(0, 4);
      activeIdx = -1; paintResults();
    } catch (e) { resultsEl.innerHTML = `<div style="padding:10px" class="muted">${esc(e.message)}</div>`; resultsEl.hidden = false; }
  }, 300);
});
function paintResults() {
  const foreign = foreignItems.length ? `<div class="muted" style="padding:6px 12px 2px;font-size:11px">Other exchanges: not available on the free plan</div>${foreignItems.map((x) => `<button disabled style="opacity:.45;cursor:not-allowed"><span class="sym">${esc(x.displaySymbol || x.symbol)}</span><span>${esc(x.description)}</span><span class="typ">non-US</span></button>`).join('')}` : '';
  resultsEl.innerHTML = (searchItems.length ? searchItems.map((x, i) => `<button data-add="${esc(x.symbol)}" class="${i === activeIdx ? 'active' : ''}"><span class="sym">${esc(x.displaySymbol || x.symbol)}</span><span>${esc(x.description)}</span><span class="typ">${esc(x.type)}</span></button>`).join('')
    : `<div style="padding:10px" class="muted">No US matches. Press Enter to add “${esc(input.value.trim().toUpperCase())}” anyway.</div>`) + foreign;
  resultsEl.hidden = false;
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!searchItems.length) return; activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length; paintResults(); }
  else if (e.key === 'Enter') { const pick = searchItems[activeIdx]?.symbol || (searchItems[0]?.symbol === input.value.trim().toUpperCase() ? searchItems[0].symbol : input.value); addSymbol(pick); input.value = ''; resultsEl.hidden = true; }
  else if (e.key === 'Escape') resultsEl.hidden = true;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) resultsEl.hidden = true; });

// ---------- global click delegation ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-help],[data-remove],[data-add],[data-tech],[data-h],[data-range],[data-sel]');
  if (!t) return;
  if (t.dataset.help) { e.stopPropagation(); openHelp(t.dataset.help); return; }
  if (t.dataset.remove) { e.stopPropagation(); exitThen(t.closest('.wcard'), () => removeSymbol(t.dataset.remove)); return; }
  if (t.dataset.add) { addSymbol(t.dataset.add); input.value = ''; resultsEl.hidden = true; return; }
  if (t.dataset.tech) { S.tech = t.dataset.tech; $('#sidebar').classList.remove('open'); }
  else if (t.dataset.h) S.H = +t.dataset.h;
  else if (t.dataset.range) S.range = t.dataset.range;
  else if (t.dataset.sel) S.selected = t.dataset.sel;
  save(); render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[role="button"]')) e.target.click();
});
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// ---------- welcome / onboarding ----------
function introHTML() {
  return `<div class="intro card">
    <h1>Welcome to Ztock 📈</h1>
    <p class="lead">A free learning dashboard. Search any US stock or ETF, see what P/E, volume and other metrics mean
      (tap any <span class="q" style="display:inline-grid">?</span>), and watch 16 technical and machine-learning techniques get graded on real data.</p>
    <p>Ztock has no server. It runs entirely in your browser and fetches market data with <b>your own free API keys</b>. Setup takes about 2 minutes:</p>
    <ol class="steps">
      <li><b>Get a Finnhub key</b> <span class="muted">(required: prices, fundamentals, news)</span><br>
        Sign up free at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a>, then copy the key from your dashboard.</li>
      <li><b>Get a Twelve Data key</b> <span class="muted">(recommended: price history for charts and ML)</span><br>
        Sign up free at <a href="https://twelvedata.com/register" target="_blank" rel="noopener">twelvedata.com/register</a>, then copy it from <i>API keys</i>.</li>
      <li><b>Paste them here:</b>
        <label class="field">Finnhub API key<input id="introFh" type="password" autocomplete="off" placeholder="e.g. c1a2b3…"></label>
        <label class="field">Twelve Data API key <small>(optional)</small><input id="introTd" type="password" autocomplete="off" placeholder="e.g. 9f8e7d…"></label>
        <button id="introSave" class="btn primary">Save &amp; start</button> <span id="introMsg" class="muted"></span></li>
    </ol>
    <p class="note">🔒 Your keys are stored only in this browser's local storage, so you won't need to enter them again on this device.
      They're sent only to Finnhub and Twelve Data, never to the site owner or anyone else. You can remove them anytime in ⚙ Settings.</p>
  </div>`;
}
function applyKeys(fh, td) {
  keys.set('finnhub', fh); keys.set('twelve', td);
  S.data = {}; live.restart(); S.watch.forEach((s) => { live.subscribe(s); loadSymbol(s); }); render();
}
document.addEventListener('click', (e) => {
  if (e.target.id !== 'introSave') return;
  const fh = $('#introFh').value.trim();
  if (!fh) { $('#introMsg').textContent = 'A Finnhub key is required.'; return; }
  applyKeys(fh, $('#introTd').value.trim());
});

// ---------- settings ----------
$('#settingsBtn').addEventListener('click', openSettings);
function openSettings() { $('#fhKey').value = keys.finnhub; $('#tdKey').value = keys.twelve; $('#linkMsg').textContent = ''; $('#settingsDlg').showModal(); }
$('#saveKeys').addEventListener('click', () => { $('#settingsDlg').close(); applyKeys($('#fhKey').value, $('#tdKey').value); });
$('#copyLink').addEventListener('click', async () => {
  if (!keys.finnhub) { $('#linkMsg').textContent = 'Save your keys first.'; return; }
  try { await navigator.clipboard.writeText(keys.setupLink()); $('#linkMsg').textContent = 'Copied! Keep it private, since it contains your keys.'; }
  catch { prompt('Copy your private setup link:', keys.setupLink()); }
});
$('#forgetKeys').addEventListener('click', () => {
  keys.forget(); live.restart(); live.setStatus('off'); S.data = {}; $('#settingsDlg').close(); render();
});
$('#clearCache').addEventListener('click', () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith('cache:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  $('#clearCache').textContent = 'Cache cleared ✓';
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', render);

// ---------- boot ----------
render();
if (!keys.finnhub) live.setStatus('off'); // the welcome screen handles setup
else {
  live.connect();
  const order = [S.selected, ...S.watch.filter((s) => s !== S.selected)].filter(Boolean);
  order.forEach((s) => { live.subscribe(s); loadSymbol(s); });
}
setTimeout(pollLoop, pollEveryMs());
