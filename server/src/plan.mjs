// The range agent: reads a Uniswap v3 pool's own oracle, measures how the price moves,
// and proposes a shape, a range and bins. It never holds keys; it returns calldata the user signs.
import { encodeFunctionData, getAddress } from 'viem';
import { client, poolAbi, ladderAbi, tokenInfo, ADDR } from './chain.mjs';
import { poolStats, hourlyCloses } from './gecko.mjs';

const LN_TICK = Math.log(1.0001);
const HOUR = 3600;

const SHAPES = {
  spot: { bins: 1, z: 1.28, why: 'no clear pattern, so the liquidity is spread evenly across the range' },
  curve: { bins: 9, z: 1.0, why: 'the price is quiet and tends to snap back, so most liquidity sits near the current price' },
  bidask: { bins: 12, z: 1.64, why: 'the price moves a lot, so most liquidity sits toward the edges where it gets paid when the price travels' },
};

// standard normal CDF (Abramowitz-Stegun)
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Hourly TWAP ticks for the last `hours` hours from the pool oracle (newest last). */
async function hourlyTicks(pool, hours) {
  const ago = Array.from({ length: hours + 1 }, (_, i) => (hours - i) * HOUR);
  const [cum] = await client.readContract({ address: pool, abi: poolAbi, functionName: 'observe', args: [ago] });
  const out = [];
  for (let i = 1; i < cum.length; i++) out.push(Number(cum[i] - cum[i - 1]) / HOUR);
  return out;
}

export async function readPool(pool) {
  pool = getAddress(pool);
  const [slot0, liquidity, token0, token1, fee, spacing] = await Promise.all(
    ['slot0', 'liquidity', 'token0', 'token1', 'fee', 'tickSpacing'].map((fn) =>
      client.readContract({ address: pool, abi: poolAbi, functionName: fn }),
    ),
  );
  const [t0, t1] = await Promise.all([tokenInfo(token0), tokenInfo(token1)]);
  return {
    pool,
    tick: Number(slot0[1]),
    sqrtPriceX96: slot0[0],
    liquidity,
    token0: t0,
    token1: t1,
    fee: Number(fee),
    spacing: Number(spacing),
  };
}

/** price of token0 in token1 units (human) at a tick */
const priceAt = (tick, p) => Math.pow(1.0001, tick) * Math.pow(10, p.token0.decimals - p.token1.decimals);

async function measure(p) {
  let ticks = null;
  let window = 0;
  let source = 'oracle';
  // 7 days of hourly candles first; GeckoTerminal "currency=token" closes are token0 priced in token1
  try {
    const closes = await hourlyCloses(p.pool);
    if (closes.length >= 24) {
      const scale = Math.pow(10, p.token0.decimals - p.token1.decimals);
      ticks = closes.map((c) => Math.log(c / scale) / LN_TICK);
      // sanity: candle price must be near the live pool price, else the base/quote order differs
      const last = ticks[ticks.length - 1];
      if (Math.abs(last - p.tick) > 2000) ticks = ticks.map((t) => -t);
      if (Math.abs(ticks[ticks.length - 1] - p.tick) > 2000) ticks = null;
      if (ticks) {
        window = ticks.length;
        source = 'candles';
      }
    }
  } catch {
    /* fall back to the oracle */
  }
  for (const h of ticks ? [] : [168, 72, 24, 6]) {
    try {
      ticks = await hourlyTicks(p.pool, h);
      window = h;
      break;
    } catch {
      /* oracle too short for this window, try a shorter one */
    }
  }
  if (!ticks || ticks.length < 4) return { window: 0 };
  const rets = [];
  for (let i = 1; i < ticks.length; i++) rets.push((ticks[i] - ticks[i - 1]) * LN_TICK);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sigmaH = Math.sqrt(variance);
  let num = 0;
  for (let i = 1; i < rets.length; i++) num += (rets[i] - mean) * (rets[i - 1] - mean);
  const autocorr = variance > 0 ? num / ((rets.length - 1) * variance) : 0;
  const drift = (ticks[ticks.length - 1] - ticks[0]) * LN_TICK;
  const trendScore = sigmaH > 0 ? Math.abs(drift) / (sigmaH * Math.sqrt(rets.length)) : 0;
  return { window, source, sigmaH, sigmaD: sigmaH * Math.sqrt(24), autocorr, drift, trendScore, ticks };
}

function pickShape(m, override) {
  if (override && SHAPES[override]) return override;
  if (!m.window) return 'spot';
  if (m.sigmaD > 0.05 || m.trendScore > 1.2) return 'bidask';
  if (m.sigmaD < 0.015 && m.autocorr < 0) return 'curve';
  return 'spot';
}

function weight(shape, d) {
  if (shape === 'curve') return Math.exp(-((d / 0.45) ** 2) / 2);
  if (shape === 'bidask') return 0.15 + d * d;
  return 1;
}

/** token amounts per unit of liquidity for [a,b] at the current sqrt price s (all real sqrt prices) */
function unitAmounts(a, b, s) {
  if (s <= a) return [1 / a - 1 / b, 0];
  if (s >= b) return [0, b - a];
  return [1 / s - 1 / b, s - a];
}

const sq = (tick) => Math.pow(1.0001, tick / 2);
const floorTo = (t, s) => Math.floor(t / s) * s;
const ceilTo = (t, s) => Math.ceil(t / s) * s;
const fmt = (x, d = 4) => (Math.abs(x) >= 1000 ? x.toFixed(0) : Number(x.toPrecision(d)).toString());
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const spct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/**
 * @param {object} q
 *   pool, horizonDays (1-30), mode ('both'|'below'|'above'), shape (optional override),
 *   amount0, amount1 (human units, the most you want to put in), bins (optional), owner (optional)
 */
export async function plan(q) {
  const p = await readPool(q.pool);
  const horizon = Math.min(30, Math.max(1, Number(q.horizonDays) || 7));
  const uiMode = ['both', 'below', 'above'].includes(q.mode) ? q.mode : 'both';
  const STABLES = new Set([ADDR.usdg.toLowerCase()]);
  const stable = (t) => STABLES.has(t.address.toLowerCase()) || /^(USD|DAI)/i.test(t.symbol);
  const weth = (t) => t.address.toLowerCase() === ADDR.weth.toLowerCase();
  // show prices as `quote per base` with the volatile coin as base (CASHCAT in ETH, ETH in USDG, NVDA in USDG)
  const invert = stable(p.token0) || (weth(p.token0) && !stable(p.token1));
  const base = invert ? p.token1 : p.token0;
  const quoteTok = invert ? p.token0 : p.token1;
  const dp = (x) => (invert ? 1 / x : x);
  // modes are chosen against the displayed price; flip them when the display is inverted
  const mode = invert && uiMode !== 'both' ? (uiMode === 'below' ? 'above' : 'below') : uiMode;
  const m = await measure(p);
  const shape = pickShape(m, q.shape);
  const cfg = SHAPES[shape];

  const sigmaD = m.window ? m.sigmaD : 0.05; // no history: assume a wild 5%/day
  let half = cfg.z * sigmaD * Math.sqrt(horizon);
  half = Math.min(Math.max(half, (4 * p.spacing * LN_TICK)), Math.log(4));
  const halfTicks = half / LN_TICK;

  let lower, upper;
  if (mode === 'below') {
    upper = floorTo(p.tick, p.spacing);
    if (upper === p.tick) upper -= p.spacing; // strictly below: token1 only
    lower = floorTo(upper - 2 * halfTicks, p.spacing);
  } else if (mode === 'above') {
    lower = ceilTo(p.tick + 1, p.spacing);
    upper = ceilTo(lower + 2 * halfTicks, p.spacing);
  } else {
    lower = floorTo(p.tick - halfTicks, p.spacing);
    upper = ceilTo(p.tick + halfTicks, p.spacing);
  }

  const span = (upper - lower) / p.spacing;
  let nBins = Math.min(40, Math.max(1, Number(q.bins) || cfg.bins));
  nBins = Math.min(nBins, span);

  // bin edges aligned to spacing
  const edges = [];
  for (let i = 0; i <= nBins; i++) edges.push(lower + Math.round((span * i) / nBins) * p.spacing);
  const s = sq(p.tick) * 1; // real sqrt price (raw units)
  const center = mode === 'both' ? p.tick : mode === 'below' ? upper : lower;
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const mid = (lo + hi) / 2;
    const d = Math.min(1, Math.abs(mid - center) / (mode === 'both' ? halfTicks : 2 * halfTicks));
    const w = weight(shape, d);
    const [u0, u1] = unitAmounts(sq(lo), sq(hi), s);
    bins.push({ tickLower: lo, tickUpper: hi, w, u0, u1 });
  }

  // scale liquidity to the budget
  const max0 = Number(q.amount0 || 0) * 10 ** p.token0.decimals;
  const max1 = Number(q.amount1 || 0) * 10 ** p.token1.decimals;
  const need0 = bins.reduce((a, b) => a + b.w * b.u0, 0);
  const need1 = bins.reduce((a, b) => a + b.w * b.u1, 0);
  const caps = [];
  if (need0 > 0) caps.push(max0 / need0);
  if (need1 > 0) caps.push(max1 / need1);
  const c = caps.length ? Math.min(...caps) : 0;
  const binsOut = bins.map((b) => ({
    tickLower: b.tickLower,
    tickUpper: b.tickUpper,
    priceLower: priceAt(b.tickLower, p),
    priceUpper: priceAt(b.tickUpper, p),
    weight: b.w,
    amount0: BigInt(Math.floor(c * b.w * b.u0 * 0.999)),
    amount1: BigInt(Math.floor(c * b.w * b.u1 * 0.999)),
  }));
  const total0 = binsOut.reduce((a, b) => a + b.amount0, 0n);
  const total1 = binsOut.reduce((a, b) => a + b.amount1, 0n);

  // fee estimate: our liquidity in the bin holding the current tick vs the pool's active liquidity
  const stats = await poolStats(p.pool);
  const active = bins.find((b) => b.tickLower <= p.tick && p.tick < b.tickUpper);
  const ourL = active ? c * active.w : 0;
  const share = ourL > 0 ? ourL / (Number(p.liquidity) + ourL) : 0;
  const feesPerDayUsd = stats ? stats.volume24hUsd * (p.fee / 1e6) * share : null;
  const stayProb = mode === 'both' ? 2 * phi(cfg.z) - 1 : null;

  const price = priceAt(p.tick, p);
  const pair = `${base.symbol}/${quoteTok.symbol}`;
  const quote = quoteTok.symbol;
  const lo = Math.min(dp(priceAt(lower, p)), dp(priceAt(upper, p)));
  const hi = Math.max(dp(priceAt(lower, p)), dp(priceAt(upper, p)));
  const now = dp(price);
  const explain = [];
  if (m.window) {
    const drift = invert ? -m.drift : m.drift;
    explain.push(
      `Over the last ${m.window} hours ${base.symbol} moved about ±${pct(m.sigmaD)} a day against ${quote} (${m.sigmaD < 0.015 ? 'quiet' : m.sigmaD < 0.05 ? 'normal' : 'wild'}), measured from ${m.source === 'oracle' ? "the pool's own on-chain oracle" : 'hourly candles of this pool'}; the current price is read live from the pool.`,
    );
    explain.push(
      `Hour to hour the price tends to ${m.autocorr < -0.05 ? 'reverse' : m.autocorr > 0.05 ? 'keep going' : 'wander without a pattern'} (autocorrelation ${m.autocorr.toFixed(2)}), and it drifted ${drift >= 0 ? '+' : ''}${pct(Math.exp(drift) - 1)} over the window.`,
    );
  } else {
    explain.push('This pool has too little price history to measure, so the agent assumes a wild 5%/day and goes wide.');
  }
  explain.push(`Shape: ${shape === 'bidask' ? 'Bid-Ask' : shape[0].toUpperCase() + shape.slice(1)}, because ${cfg.why}.`);
  explain.push(
    `Range: ${fmt(lo)} to ${fmt(hi)} ${quote} per ${base.symbol} (now ${fmt(now)}), ${spct(lo / now - 1)} / ${spct(hi / now - 1)}.` +
      (stayProb ? ` In a normal model there is about a ${Math.round(stayProb * 100)}% chance the price is still inside after ${horizon} day${horizon > 1 ? 's' : ''}.` : ''),
  );
  if (uiMode === 'below') explain.push(`One-sided below the price: only ${quote} goes in, and it buys ${base.symbol} as the price falls through the range.`);
  if (uiMode === 'above') explain.push(`One-sided above the price: only ${base.symbol} goes in, and it sells into ${quote} as the price rises through the range.`);
  explain.push(`${nBins} bin${nBins > 1 ? 's' : ''}; each bin is one Uniswap position, so each costs gas to open.`);
  if (feesPerDayUsd != null && c > 0) {
    explain.push(`At the last 24h volume this would earn roughly $${fmt(feesPerDayUsd, 3)} a day in fees while the price stays inside; nothing while it is outside.`);
  }
  explain.push('This is a calculation from past prices, not advice. You sign the transaction yourself; the agent never touches your funds.');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const isWeth0 = p.token0.address.toLowerCase() === ADDR.weth.toLowerCase();
  const isWeth1 = p.token1.address.toLowerCase() === ADDR.weth.toLowerCase();
  const args = [
    p.token0.address,
    p.token1.address,
    p.fee,
    binsOut.map((b) => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, amount0: b.amount0, amount1: b.amount1 })),
    300n,
    deadline,
  ];
  const tx = {
    to: ADDR.ladder,
    data: encodeFunctionData({ abi: ladderAbi, functionName: 'open', args }),
    value: (isWeth0 ? total0 : isWeth1 ? total1 : 0n).toString(),
    approve: [
      !isWeth0 && total0 > 0n ? { token: p.token0.address, amount: total0.toString() } : null,
      !isWeth1 && total1 > 0n ? { token: p.token1.address, amount: total1.toString() } : null,
    ].filter(Boolean),
  };

  return {
    pool: p.pool,
    pair,
    fee: p.fee,
    token0: p.token0,
    token1: p.token1,
    tick: p.tick,
    price,
    display: { base: base.symbol, quote, invert },
    horizonDays: horizon,
    mode: uiMode,
    shape,
    measured: m.window
      ? { windowHours: m.window, source: m.source, sigmaDay: m.sigmaD, autocorr: m.autocorr, drift: m.drift, trendScore: m.trendScore }
      : null,
    history: m.ticks ? m.ticks.map((t) => priceAt(t, p)) : [],
    range: { tickLower: lower, tickUpper: upper, priceLower: priceAt(lower, p), priceUpper: priceAt(upper, p) },
    stayProbability: stayProb,
    bins: binsOut.map((b) => ({ ...b, amount0: b.amount0.toString(), amount1: b.amount1.toString() })),
    totals: {
      amount0: total0.toString(),
      amount1: total1.toString(),
      amount0Human: Number(total0) / 10 ** p.token0.decimals,
      amount1Human: Number(total1) / 10 ** p.token1.decimals,
    },
    feesPerDayUsd,
    stats,
    explain,
    tx,
  };
}
