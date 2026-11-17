// GeckoTerminal is used only for 24h volume / TVL (cached), never for prices the agent plans on.
const BASE = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
let cache = { at: 0, pools: [] };

export async function topV3Pools() {
  if (Date.now() - cache.at < 120_000 && cache.pools.length) return cache.pools;
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`${BASE}/dexes/uniswap-v3-robinhood/pools?page=${page}&sort=h24_volume_usd_desc`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) break;
    const j = await r.json();
    for (const p of j.data || []) {
      const a = p.attributes;
      out.push({
        address: a.address.toLowerCase(),
        name: a.name,
        tvlUsd: Number(a.reserve_in_usd) || 0,
        volume24hUsd: Number(a.volume_usd?.h24) || 0,
        priceChange24h: Number(a.price_change_percentage?.h24) || 0,
        createdAt: a.pool_created_at,
      });
    }
  }
  if (out.length) cache = { at: Date.now(), pools: out };
  return cache.pools;
}

const ohlcvCache = new Map();
/** Hourly closes (oldest first) for up to 168 hours; cached 15 minutes per pool. */
export async function hourlyCloses(address) {
  const k = address.toLowerCase();
  const hit = ohlcvCache.get(k);
  if (hit && Date.now() - hit.at < 900_000) return hit.closes;
  const r = await fetch(`${BASE}/pools/${k}/ohlcv/hour?limit=168&currency=token`, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    if (hit) return hit.closes;
    throw new Error(`gecko ${r.status}`);
  }
  const j = await r.json();
  const rows = j.data?.attributes?.ohlcv_list || [];
  const closes = rows.map((x) => Number(x[4])).filter((x) => x > 0).reverse();
  ohlcvCache.set(k, { at: Date.now(), closes });
  return closes;
}

export async function poolStats(address) {
  const pools = await topV3Pools().catch(() => cache.pools);
  return pools.find((p) => p.address === address.toLowerCase()) || null;
}
