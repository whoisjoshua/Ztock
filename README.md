# Ztock
Personal stock dashboard for learning the market: valuation, technical indicators and machine learning, each one
**graded honestly on real data**.

It's a fully static site: plain HTML, CSS and vanilla JavaScript (ES modules). No backend, no build step, no
`npm install`. It runs on GitHub Pages and every API call goes straight from the browser. Every metric and model has a
**?** button that explains what it is, how to read it and what to watch out for.

*For education only, not financial advice.*

---

## What the app does
- **Search & watchlist.** Finnhub symbol search, live prices over WebSocket, and REST polling that stays under the free limit.
- **16 techniques in the left panel**, each graded A–F per stock on data it never trained on:
  - Baselines: always-bullish and coin flip, so you can see what "no skill" looks like
  - Trend: SMA/EMA crossovers, linear & polynomial regression (with an overfitting demo), Holt smoothing
  - Oscillators: RSI, MACD, Bollinger Bands
  - Volume: OBV, volume-spike anomaly detector
  - ML: logistic regression (shows learned feature weights), k-nearest neighbors pattern matching, neural network (MLP), k-means regimes, ensemble vote
- **Report card for each technique.** Hit rate vs. baseline, a z-score "is it luck?" check, coverage, strategy vs. buy & hold, Sharpe ratio, train-vs-test accuracy and an equity curve.
- **Prediction horizon.** Choose how many days ahead the techniques are scored on (default 5).
- **Bull/bear confidence.** Blends 11 factors: valuation, P/E-vs-growth (PEG/GARP), quality, growth, momentum, **traction**
  (volume × trend × 52-week range), earnings surprises, analysts, news sentiment, the ML models that beat their baseline,
  and **combo pattern flags** (value trap, GARP sweet spot, volume-confirmed breakout, speculative froth, capitulation, quality on sale, …).
- **News sentiment** scored in the browser with an explainable finance word list. Hover a headline to see which words drove its score.

## API keys
| Provider | Used for | Free limit | App caps itself at |
|---|---|---|---|
| [Finnhub](https://finnhub.io) | search, quotes, live WebSocket, profile, fundamentals, analysts, earnings, insider sentiment, news | 60 calls/min | 50/min |
| [Twelve Data](https://twelvedata.com) | daily price history and intraday ranges (Finnhub candles are paid-only) | 8/min, 800/day | 7/min |

Without a Twelve Data key only AAPL gets real history. Other tickers fall back to clearly labelled **simulated** prices.

Keys can come from three places (first match wins):
1. **localStorage** (`key:finnhub`, `key:twelve`), set through the welcome screen or ⚙ Settings.
2. **Setup link**: `https://<you>.github.io/Ztock/#fh=…&td=…`. Opening it saves the keys to localStorage and strips them
   from the address bar. Get yours from ⚙ Settings → *Copy my setup link*. The `#…` part is never sent to a server, but
   treat the link like a password.
3. **`config.local.js`** (git-ignored, local dev only). See below.

Keys never leave the browser except in requests to Finnhub / Twelve Data. ⚙ Settings → *Forget keys on this device* removes them.

### Why WebSocket and not a webhook?
A webhook means Finnhub POSTs to *your server*, and GitHub Pages has no server. A WebSocket is a push channel the browser
opens itself, it doesn't count against the 60/min REST budget, and Finnhub's free tier includes it.

---

## Development

### Running locally
There's nothing to build, but the page **has to be served over `http://`**, not opened as a `file://` URL, because
browsers block ES module imports (`<script type="module">`) from `file://`. Any static file server works. Pick whichever
you already have:

```bash
npx serve .                    # Node
python3 -m http.server 8000    # Python (built into macOS), only used as a file server
```
Or use the VS Code **Live Server** extension. Then open the printed URL (e.g. http://localhost:3000 or http://localhost:8000).

Edits show up on a normal refresh. If something looks stale, do a hard refresh (⌘⇧R).

### Local keys
Create `config.local.js` in the repo root (it's in `.gitignore`):
```js
window.APP_CONFIG = {
  finnhubKey: "YOUR_FINNHUB_KEY",
  twelveDataKey: "YOUR_TWELVE_DATA_KEY"
};
```
`index.html` loads it with an `onerror` fallback, so it's fine that the file doesn't exist on GitHub Pages. Keys saved in
localStorage take priority over this file. **Never commit keys:** anything in a static site's code is visible to every visitor.

### External dependencies (loaded from CDNs in `index.html`)
- [Chart.js 4.4.1](https://www.chartjs.org/) via jsDelivr, used as the global `Chart`
- Inter and JetBrains Mono from Google Fonts

All ML and indicator code is hand-written and dependency-free.

### Project layout
```
index.html          Page shell: top bar, sidebar, help + settings dialogs. Loads Chart.js, config.local.js, js/app.js
css/styles.css      All styling
js/
  app.js            Entry point. App state, rendering (watchlist, detail view, sidebar), event wiring, polling, settings
  api.js            Data layer: key handling, localStorage wrapper, rate limiters, caching, Finnhub REST + WebSocket
                    (LiveFeed), Twelve Data daily/intraday history, simulated-price fallback
  techniques.js     The 16 techniques (TECHNIQUES array), feature prep, the shared backtest (evaluate) and grading
  indicators.js     SMA, EMA, rolling std, RSI, MACD, Bollinger, OBV, volume z-score. No look-ahead
  ml.js             Seeded RNG, linear/poly regression, Holt, standardizer, logistic regression, MLP, k-means
  heuristics.js     Fundamental metrics, Piotroski score, the 11-factor bull/bear confidence and pattern flags
  sentiment.js      Lexicon-based headline sentiment
  charts.js         Chart.js rendering (price, indicator sub-chart, equity curve, intraday) and chart animation
  glossary.js       Text for every "?" button (title / what / read / watch)
```

### How the pieces fit
1. `app.js` restores state from localStorage (watchlist, selected ticker, technique, horizon, chart range).
2. Selecting a ticker fetches quote, profile, metrics, recs, earnings, insider sentiment and news through `api.js`,
   plus daily history from Twelve Data via `history()`.
3. `runAll(history, H, symbol)` in `techniques.js` runs every technique, backtests each signal and builds the ensemble.
   Results are memoised per horizon on the ticker's data object.
4. `computeFactors(...)` in `heuristics.js` combines fundamentals, news sentiment and the technique results into the
   bull/bear confidence.
5. `charts.js` draws everything. `LiveFeed` pushes live trades into the watchlist while the tab is open.

### Technique contract
Each entry in `TECHNIQUES` looks like:
```js
{
  id: 'rsi', group: 'Oscillators', name: 'RSI', help: 't_rsi',   // help = key in GLOSSARY
  run: (P) => ({ signal: [...], info: ['text lines for the panel'] }),
}
```
- `P` comes from `prepare()`: close `P.c`, volume `P.v`, `P.dates`, `P.n`, horizon `P.H`, `P.symbol`, precomputed
  indicators (`P.rsi`, `P.macd`, `P.bb`, `P.s20`/`s50`/`s200`, `P.e9`/`e21`, `P.vz`, `P.obv`, …), ML features `P.feat`,
  labels `P.label(t)`, and the train/test split (`P.trainIdx`, `P.testStart`).
- `signal` has one value per day in **[-1, 1]** (positive = bullish, `null` = no opinion). The value at day `t` may only
  use data up to `t`.
- Return `{ error: '…' }` instead if it can't run (e.g. not enough history).
- ML techniques must train only on data before `P.testStart`. The backtest scores the most recent 40% of history.

`evaluate()` measures hit rate vs. the best constant guess, z-score, coverage, strategy vs. buy & hold and Sharpe, then
turns that into a 0–100 rating and an A–F grade (A ≥ 75, B ≥ 62, C ≥ 48, D ≥ 35). Ratings shrink toward 50 when there
are few independent samples or low coverage.

**Adding a technique:** add an object to `TECHNIQUES` (it shows up in the sidebar under its `group`), add a matching
`t_<id>` entry to `GLOSSARY` in `glossary.js`, and it's automatically included in the ensemble vote unless it's in the
`Baselines` group.

**Adding a "?" button:** add `<button class="q" data-help="someKey">?</button>` in the markup and a `someKey` entry in `GLOSSARY`.

### Animations
`render()` rebuilds the page's HTML on every state change, so animation is handled in a way that survives that:
- **Charts** (`charts.js` → `make()`): Chart.js instances are kept alive. On re-render the old chart's container is
  swapped into the new markup and its data patched in place. Same x-axis (technique, horizon or theme change) → the
  lines morph; new x-axis (range or symbol change) → the chart sweeps in from the left; identical data → untouched.
  Animation is skipped above 15k points and when the OS asks for reduced motion.
- **Entrance / swap animations** (`anim(slot, key)` in `app.js`): a region gets `data-anim` for ~1 s after its key
  changes (e.g. the card grid when the stock changes, the technique card when the technique changes). Re-renders during
  that window resume the same animation through a negative `animation-delay`, so data arriving mid-animation doesn't restart it.
  The CSS lives in the "Motion" section at the bottom of `styles.css`.
- **FLIP** (`snapshot()` / `playFlips()`): watchlist cards slide when one is removed, and the active pill of the range
  buttons, horizon switch and technique list glides to the new selection (the pill is each button's `::before`).
- `prefers-reduced-motion` turns all of it off.

### Storage keys (localStorage)
| Key | Contents |
|---|---|
| `key:finnhub`, `key:twelve` | API keys |
| `watchlist`, `selected`, `tech`, `horizon`, `range` | UI state |
| `cache:fh:<path>?<query>` | Finnhub responses (search 1d, profile 7d, metrics 12h, recs/earnings/insider 1d, news 2h; quotes aren't cached) |
| `cache:td2:<symbol>:<date>` | Daily history, valid until the next calendar day (about 1 call per ticker per day) |
| `cache:ti:<symbol>:<range>` | Intraday history (1D: 5 min, 1W: 30 min) |

All values are JSON. ⚙ Settings → *Clear cached data* removes every `cache:*` key. To start completely fresh, run
`localStorage.clear()` in the DevTools console.

### Debugging tips
- The `n/60 calls/min` counter in the top bar shows Finnhub calls used in the last minute, the quote polling interval and any queued requests.
- A `403` from Finnhub almost always means the symbol isn't a US listing (not covered by the free plan).
- `429`s are retried once after 5 s. If you keep hitting them, check for a polling loop or clear the cache less often.
- Technique errors are caught per technique and logged with `console.error(<id>, err)`, so one broken technique doesn't
  break the page.
- Random parts (coin flip, MLP init, k-means) are seeded from the ticker, so results are reproducible run to run.

---

## Deploy to GitHub Pages
1. Push to GitHub (`config.local.js` stays out because of `.gitignore`).
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Open the site and paste your keys on the welcome screen (or open your setup link).

No build or Actions workflow is needed. Whatever is on `main` is what gets served.

## Ideas for later
- Better news sentiment: run FinBERT in the browser with [transformers.js](https://huggingface.co/docs/transformers.js), which still works on a static site.
- Sector-relative P/E using Finnhub `stock/peers`.
