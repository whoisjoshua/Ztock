// Lightweight, explainable headline sentiment (a "lexicon" model).
// It runs fully in the browser, so it works on a static GitHub Pages site.
const POS = `beat beats beating surge surges surged soar soars soared record records upgrade upgraded upgrades outperform outperforms
growth grow grows strong stronger strongest rally rallies rallied gain gains gained jump jumps jumped raise raises raised bullish profit profits
profitable buy tops topped exceed exceeds exceeded expand expands expansion approval approved approves partnership wins win won boost boosts boosted
rebound rebounds optimistic upbeat higher climb climbs climbed breakthrough innovative launch launches launched dividend buyback accelerate accelerates
momentum best positive robust solid upside lead leads leading winner winners success successful favorable rise rises rising rose`.split(/\s+/);
const NEG = `miss misses missed plunge plunges plunged downgrade downgraded downgrades lawsuit lawsuits sue sued probe investigation investigated recall recalls
weak weaker weakness fall falls fell drop drops dropped cut cuts loss losses lose losing bearish sell sells selling sold selloff sell-off decline declines declined slump slumps
layoffs layoff fraud warning warns warned concern concerns fear fears risk risks risky tumble tumbles tumbled sink sinks sank lower delay delays delayed
fine fined antitrust bankruptcy default crash crashes crashed slowdown slows slowing underperform worst negative halt halted scandal volatile uncertainty
shortfall disappoint disappoints disappointing disappointed struggle struggles struggling plummet plummets tariff tariffs downturn`.split(/\s+/);
const NEGATORS = new Set(['not', 'no', 'never', "isn't", "doesn't", "didn't", "won't", 'without', 'fails', 'failed']);
const posSet = new Set(POS), negSet = new Set(NEG);

export function scoreText(text) {
  const words = text.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  let s = 0; const hits = [];
  words.forEach((w, i) => {
    let v = posSet.has(w) ? 1 : negSet.has(w) ? -1 : 0;
    if (!v) return;
    if (NEGATORS.has(words[i - 1]) || NEGATORS.has(words[i - 2])) v = -v;
    s += v; hits.push({ w, v });
  });
  return { score: Math.tanh(s / 2), hits };
}

export function scoreNews(articles) {
  const items = (articles || []).slice(0, 30).map((a) => {
    const h = scoreText(a.headline || ''), body = scoreText(a.summary || '');
    return { ...a, sentiment: 0.7 * h.score + 0.3 * body.score, hits: h.hits };
  });
  if (!items.length) return { score: null, items };
  // Newer headlines count more (half-life ≈ 3 days).
  const now = Date.now() / 1000;
  let s = 0, w = 0;
  for (const it of items) { const wt = Math.pow(0.5, (now - it.datetime) / 86400 / 3); s += it.sentiment * wt; w += wt; }
  return { score: w ? s / w : 0, items };
}
