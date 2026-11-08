// Data layer: API keys, caching, rate limiting, Finnhub REST + WebSocket, Twelve Data history.
import { rng, hashStr } from './ml.js';

// ---------- safe storage ----------
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- keys ----------
const cfg = window.APP_CONFIG || {};
export const keys = {
  get finnhub() { return store.get('key:finnhub') || cfg.finnhubKey || ''; },
  get twelve() { return store.get('key:twelve') || cfg.twelveDataKey || ''; },
  set(name, v) { v ? store.set('key:' + name, v.trim()) : store.del('key:' + name); },
  forget() { store.del('key:finnhub'); store.del('key:twelve'); },
  // A private "setup link": #fh=KEY&td=KEY. The part after # is never sent to any server.
  setupLink() {
    const h = new URLSearchParams(); if (this.finnhub) h.set('fh', this.finnhub); if (this.twelve) h.set('td', this.twelve);
    return location.origin + location.pathname + '#' + h.toString();
  },
};

// Opening a setup link saves the keys in this browser, then immediately strips them from the address bar
// (so they don't sit in the URL, get bookmarked by accident, or show in screenshots).
(function importKeysFromLink() {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('fh') && !h.get('td')) return;
    if (h.get('fh')) keys.set('finnhub', h.get('fh'));
    if (h.get('td')) keys.set('twelve', h.get('td'));
    window.history.replaceState(null, '', location.pathname + location.search);
  } catch { /* ignore */ }
})();

// ---------- rate limiter (sliding window) ----------
class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.stamps = []; this.queue = []; this.timer = null; }
  used() { const now = Date.now(); this.stamps = this.stamps.filter((t) => now - t < this.windowMs); return this.stamps.length; }
  schedule(fn, priority = false) {
    return new Promise((resolve, reject) => { (priority ? this.queue.unshift.bind(this.queue) : this.queue.push.bind(this.queue))({ fn, resolve, reject }); this.pump(); });
  }
  pump() {
    if (this.timer) return;
    while (this.queue.length && this.used() < this.max) {
      const job = this.queue.shift(); this.stamps.push(Date.now());
      job.fn().then(job.resolve, job.reject);
    }
    if (this.queue.length) {
      const wait = this.windowMs - (Date.now() - this.stamps[0]) + 50;
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
    }
  }
  pending() { return this.queue.length; }
}
// Finnhub free tier = 60 calls/min. We cap at 50 to leave headroom.
export const finnhubLimiter = new RateLimiter(50, 60_000);
// Twelve Data free tier = 8 calls/min, 800/day. We cap at 7/min.
export const twelveLimiter = new RateLimiter(7, 60_000);

// ---------- cache ----------
function cached(key, ttlMs) { const c = store.get('cache:' + key); return c && Date.now() - c.t < ttlMs ? c.v : null; }
function putCache(key, v) { store.set('cache:' + key, { t: Date.now(), v }); }

const HOUR = 3_600_000, DAY = 24 * HOUR;

async function finnhub(path, params = {}, ttl = 0, priority = false) {
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `fh:${path}?${qs}`;
  if (ttl) { const hit = cached(cacheKey, ttl); if (hit) return hit; }
  if (!keys.finnhub) throw new Error('Add your Finnhub API key in ⚙ Settings.');
  const doFetch = async (retry = true) => {
    const res = await fetch(`https://finnhub.io/api/v1/${path}?${qs}&token=${encodeURIComponent(keys.finnhub)}`);
    if (res.status === 429 && retry) { await new Promise((r) => setTimeout(r, 5000)); return doFetch(false); }
    if (res.status === 401) throw new Error('Finnhub rejected the API key.');
    // Every endpoint this app uses is free for US listings, so a 403 almost always means the
    // *symbol* (e.g. a foreign listing like VOOG.MX) isn't covered, not the feature.
    if (res.status === 403) {
      const err = new Error(params.symbol
        ? `${params.symbol} isn't covered by Finnhub's free plan, which only includes US-listed stocks and ETFs.`
        : `Finnhub refused "${path}" on the free plan.`);
      err.noAccess = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Finnhub ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const data = await finnhubLimiter.schedule(() => doFetch(), priority);
  if (ttl) putCache(cacheKey, data);
  return data;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
export const api = {
  search: (q) => finnhub('search', { q }, DAY, true),
  quote: (s, priority) => finnhub('quote', { symbol: s }, 0, priority),
  profile: (s) => finnhub('stock/profile2', { symbol: s }, 7 * DAY),
  metric: (s) => finnhub('stock/metric', { symbol: s, metric: 'all' }, 12 * HOUR),
  recs: (s) => finnhub('stock/recommendation', { symbol: s }, DAY),
  earnings: (s) => finnhub('stock/earnings', { symbol: s }, DAY),
  insider: (s) => finnhub('stock/insider-sentiment', { symbol: s, from: isoDate(new Date(Date.now() - 400 * DAY)), to: isoDate(new Date()) }, DAY).then((r) => r.data || []),
  news: (s) => {
    const to = new Date(), from = new Date(Date.now() - 10 * DAY);
    return finnhub('company-news', { symbol: s, from: isoDate(from), to: isoDate(to) }, 2 * HOUR);
  },
};

// ---------- daily price history (Twelve Data) ----------
// Finnhub's candle endpoint is premium-only, so history comes from Twelve Data's free tier.
// History is cached until the next calendar day, so each ticker costs ~1 call per day.
export async function history(symbol, lastQuote) {
  const cacheKey = `td2:${symbol}:${isoDate(new Date())}`;
  const hit = store.get('cache:' + cacheKey);
  if (hit) return hit.v;
  const key = keys.twelve || 'demo';
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=1300&apikey=${encodeURIComponent(key)}`;
  try {
    const j = await twelveLimiter.schedule(() => fetch(url).then((r) => r.json()));
    if (j.status === 'error' || !j.values) throw new Error(j.message || 'No data');
    const v = [...j.values].reverse();
    const data = { dates: v.map((x) => x.datetime), open: v.map((x) => +x.open), high: v.map((x) => +x.high), low: v.map((x) => +x.low),
      close: v.map((x) => +x.close), volume: v.map((x) => +x.volume || 0), source: 'Twelve Data' };
    // Drop stale cache entries for this symbol, then save today's.
    try { Object.keys(localStorage).filter((k) => (k.startsWith(`cache:td2:${symbol}:`) || k.startsWith(`cache:td:${symbol}:`))).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    putCache(cacheKey, data);
    return data;
  } catch (e) {
    const reason = !keys.twelve ? 'No Twelve Data key set (the "demo" key only works for AAPL).' : String(e.message || e);
    return { ...simulated(symbol, lastQuote?.c || 100), simulatedReason: reason };
  }
}

// ---------- intraday bars for the 1D / 1W chart ranges (Twelve Data) ----------
const INTRA = { '1D': { interval: '5min', size: 160, ttl: 5 * 60_000 }, '1W': { interval: '30min', size: 90, ttl: 30 * 60_000 } };
export async function intraday(symbol, range) {
  const cfgI = INTRA[range], cacheKey = `ti:${symbol}:${range}`;
  const hit = cached(cacheKey, cfgI.ttl);
  if (hit) return hit;
  if (!keys.twelve) throw new Error('Intraday charts need a Twelve Data key (⚙ Settings).');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${cfgI.interval}&outputsize=${cfgI.size}&apikey=${encodeURIComponent(keys.twelve)}`;
  const j = await twelveLimiter.schedule(() => fetch(url).then((r) => r.json()));
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'No intraday data');
  let v = [...j.values].reverse();
  // Keep exactly the last 1 (1D) or 5 (1W) trading sessions so the chart matches the change figure.
  const sessions = [...new Set(v.map((x) => x.datetime.slice(0, 10)))].slice(range === '1D' ? -1 : -5);
  v = v.filter((x) => sessions.includes(x.datetime.slice(0, 10)));
  const data = { times: v.map((x) => x.datetime), close: v.map((x) => +x.close), volume: v.map((x) => +x.volume || 0) };
  putCache(cacheKey, data);
  return data;
}

// Clearly-labelled synthetic data so the learning tools can still be explored.
function simulated(symbol, lastPrice) {
  const r = rng(hashStr(symbol)), n = 750, close = new Array(n), volume = new Array(n), dates = [];
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  let p = 100; const tmp = [];
  for (let i = 0; i < n; i++) { p *= Math.exp(0.0003 + 0.018 * gauss()); tmp.push(p); }
  const k = lastPrice / tmp[n - 1];
  const d = new Date();
  for (let i = n - 1; i >= 0; ) { d.setDate(d.getDate() - 1); if (d.getDay() % 6 === 0) continue; dates[i] = isoDate(d); i--; }
  for (let i = 0; i < n; i++) { close[i] = tmp[i] * k; volume[i] = Math.round(5e6 * Math.exp(0.4 * gauss())); }
  return { dates, open: close, high: close, low: close, close, volume, source: 'SIMULATED', simulated: true };
}

// ---------- live trades over WebSocket ----------
// Webhooks need a server to receive them, which a static GitHub Pages site doesn't have.
// A WebSocket is the browser-friendly push channel, and it doesn't count against the REST limit.
export class LiveFeed {
  constructor(onTrade, onStatus) { this.onTrade = onTrade; this.onStatus = onStatus; this.subs = new Set(); this.ws = null; this.backoff = 2000; this.status = 'off'; }
  connect() {
    if (!keys.finnhub || this.ws) return;
    this.setStatus('connecting');
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(keys.finnhub)}`);
    this.ws = ws;
    ws.onopen = () => { this.backoff = 2000; this.setStatus('live'); this.subs.forEach((s) => this.send('subscribe', s)); };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.type === 'trade') m.data.forEach((t) => this.onTrade(t.s, t.p, t.t, t.v)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.ws = null; this.setStatus('reconnecting');
      setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    ws.onerror = () => ws.close();
  }
  send(type, symbol) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type, symbol })); }
  subscribe(s) { this.subs.add(s); this.send('subscribe', s); }
  unsubscribe(s) { this.subs.delete(s); this.send('unsubscribe', s); }
  setStatus(s) { this.status = s; this.onStatus?.(s); }
  restart() { if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } this.connect(); }
}
