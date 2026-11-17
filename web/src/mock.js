// DEV ONLY. Shapes copied from server/API.md so the UI can be built before the server answers.
// Imported dynamically behind import.meta.env.DEV, so it is never part of a production build.
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const POOLS = [
  { address: '0x1111111111111111111111111111111111111111', name: 'USDG / WETH 0.05%', tvlUsd: 412000, volume24hUsd: 965000, feesTvl24h: 0.00117, priceChange24h: 1.8, createdAt: iso(86400e3 * 41), p: 3150, s0: 'USDG', s1: 'WETH', inv: true, sig: 0.031 },
  { address: '0x2222222222222222222222222222222222222222', name: 'WETH / TSLA 0.3%', tvlUsd: 98000, volume24hUsd: 121000, feesTvl24h: 0.0037, priceChange24h: -2.4, createdAt: iso(86400e3 * 12), p: 7.1, s0: 'WETH', s1: 'TSLA', inv: false, sig: 0.045 },
  { address: '0x3333333333333333333333333333333333333333', name: 'USDG / NVDA 0.3%', tvlUsd: 51000, volume24hUsd: 33000, feesTvl24h: 0.0019, priceChange24h: 0.4, createdAt: iso(86400e3 * 6), p: 1 / 182, s0: 'USDG', s1: 'NVDA', inv: true, sig: 0.022 },
];

function plan(q) {
  const P = POOLS.find((p) => p.address.toLowerCase() === (q.get('pool') || '').toLowerCase()) || POOLS[0];
  const days = Number(q.get('horizonDays') || 7);
  const mode = q.get('mode') || 'both';
  const sig = P.sig;
  const shape = q.get('shape') || (sig > 0.04 ? 'bidask' : sig < 0.025 ? 'curve' : 'spot');
  const z = { spot: 1.28, curve: 1.0, bidask: 1.64 }[shape];
  const n = Number(q.get('bins')) || { spot: 1, curve: 9, bidask: 12 }[shape];
  const half = z * sig * Math.sqrt(days);
  const t0 = Math.round(Math.log(P.p) / Math.log(1.0001));
  const hw = Math.round(Math.log(1 + half) / Math.log(1.0001));
  let lo = t0 - hw, hi = t0 + hw;
  if (mode === 'below') hi = t0 - 10;
  if (mode === 'above') lo = t0 + 10;
  const step = (hi - lo) / n;
  const pa = (t) => Math.pow(1.0001, t);
  const bins = Array.from({ length: n }, (_, i) => {
    const a = Math.round(lo + i * step), b = Math.round(lo + (i + 1) * step);
    const d = Math.abs((a + b) / 2 - t0) / (hw || 1);
    const w = shape === 'curve' ? Math.exp(-2 * d * d) : shape === 'bidask' ? 0.3 + d : 1;
    return { tickLower: a, tickUpper: b, priceLower: pa(a), priceUpper: pa(b), w };
  });
  const sw = bins.reduce((s, b) => s + b.w, 0);
  bins.forEach((b) => { b.weight = b.w / sw; delete b.w; b.amount0 = String(Math.round(b.weight * 1e18)); b.amount1 = String(Math.round(b.weight * 3e9)); });
  const history = Array.from({ length: 168 }, (_, i) => P.p * (1 + sig * 0.6 * Math.sin(i / 9) + sig * 0.25 * Math.sin(i / 2.3)));
  history.push(P.p);
  const base = P.inv ? P.s1 : P.s0, quote = P.inv ? P.s0 : P.s1;
  return {
    pool: P.address, pair: `${base}/${quote}`, fee: 500,
    token0: { address: '0xa0', symbol: P.s0, decimals: 18 }, token1: { address: '0xa1', symbol: P.s1, decimals: 18 },
    tick: t0, price: P.p, display: { base, quote, invert: P.inv },
    horizonDays: days, mode, shape,
    measured: { windowHours: 168, source: 'candles', sigmaDay: sig, autocorr: -0.12, drift: 0.002, trendScore: 0.2 },
    history, range: { tickLower: lo, tickUpper: hi, priceLower: pa(lo), priceUpper: pa(hi) },
    stayProbability: mode === 'both' ? 0.8 : null, bins,
    totals: { amount0: '0', amount1: '0', amount0Human: Number(q.get('amount0') || 0), amount1Human: Number(q.get('amount1') || 0) },
    feesPerDayUsd: 0.42,
    explain: [
      `MOCK: measured over 168 hours of candles, ${base} moves about ${(sig * 100).toFixed(1)}% a day.`,
      `MOCK: shape ${shape} because the mock says so.`,
      `MOCK: range = ${z} × ${(sig * 100).toFixed(1)}% × √${days} days.`,
      `${n} bins; each bin is one Uniswap position, so each costs gas to open.`,
      'This is a calculation from past prices, not advice. You sign the transaction yourself; the agent never touches your funds.',
    ],
    tx: { to: null, data: '0x', value: '0', approve: [] },
  };
}

export function mock(path) {
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');
  switch (p) {
    case '/config': return { chainId: 4663, rpc: 'https://robinhood-rpc.publicnode.com', explorer: 'https://robinhoodchain.blockscout.com', ladderManager: null, stake: null, weth: null, usdg: null, feeBps: 500 };
    case '/token': return { name: 'Stagger', ticker: 'RUNGS', ca: null, launchAt: '2026-11-17T15:00:00Z', pons: null, x: 'https://x.com/staggeragent' };
    case '/pools': return POOLS.map(({ p, s0, s1, inv, sig, ...r }) => r);
    case '/plan': return plan(q);
    case '/ladders': return [];
    case '/scoreboard': return { hitRate: null, settled: 0, live: 2, plans: [
      { id: 2, pool: POOLS[0].address, pair: 'ETH/USDG', shape: 'spot', createdAt: iso(3600e3 * 2), priceAtPlan: 3150, priceLower: 3040, priceUpper: 3260, timeInRange: 1, status: 'live', settledAt: null },
      { id: 1, pool: POOLS[1].address, pair: 'WETH/TSLA', shape: 'bidask', createdAt: iso(3600e3 * 5), priceAtPlan: 7.1, priceLower: 6.8, priceUpper: 7.4, timeInRange: 1, status: 'live', settledAt: null },
    ] };
    case '/stake': return undefined;
  }
  return undefined;
}
