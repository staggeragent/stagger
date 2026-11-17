import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, parseAbi } from 'viem';
import { client, ADDR, ladderAbi, npmAbi, tokenInfo, robinhood } from './chain.mjs';
import { topV3Pools } from './gecko.mjs';
import { plan, readPool } from './plan.mjs';

const PORT = Number(process.env.PORT || 4252);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

const TOKEN = {
  name: 'Stagger',
  ticker: 'RUNGS',
  ca: process.env.RUNGS_CA || null,
  launchAt: '2026-11-17T15:00:00Z',
  x: 'https://x.com/staggeragent',
};

// ------------------------------------------------------------------ helpers
const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

const priceAt = (tick, d0, d1) => Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);

// ------------------------------------------------------------------ ladders
async function laddersOf(owner) {
  if (!ADDR.ladder) return [];
  const ids = await client.readContract({ address: ADDR.ladder, abi: ladderAbi, functionName: 'laddersOf', args: [owner] });
  const out = [];
  for (const id of ids) {
    const [, token0, token1, fee, tokenIds] = await client.readContract({
      address: ADDR.ladder,
      abi: ladderAbi,
      functionName: 'getLadder',
      args: [id],
    });
    if (!tokenIds.length) continue;
    const [t0, t1] = await Promise.all([tokenInfo(token0), tokenInfo(token1)]);
    const poolAddr = await client.readContract({
      address: ADDR.factory,
      abi: parseAbi(['function getPool(address,address,uint24) view returns (address)']),
      functionName: 'getPool',
      args: [token0, token1, fee],
    });
    const p = await readPool(poolAddr);
    let u0 = 0n, u1 = 0n;
    const bins = [];
    for (const tokenId of tokenIds) {
      const pos = await client.readContract({ address: ADDR.npm, abi: npmAbi, functionName: 'positions', args: [tokenId] });
      // simulate collect as the manager (the NFT owner) to read uncollected fees exactly
      const { result } = await client.simulateContract({
        address: ADDR.npm,
        abi: npmAbi,
        functionName: 'collect',
        args: [{ tokenId, recipient: ADDR.ladder, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }],
        account: ADDR.ladder,
      });
      u0 += result[0];
      u1 += result[1];
      const lo = Number(pos[5]), hi = Number(pos[6]);
      bins.push({
        tokenId,
        tickLower: lo,
        tickUpper: hi,
        priceLower: priceAt(lo, t0.decimals, t1.decimals),
        priceUpper: priceAt(hi, t0.decimals, t1.decimals),
        liquidity: pos[7],
        inRange: lo <= p.tick && p.tick < hi,
      });
    }
    out.push({
      id,
      pool: poolAddr,
      pair: `${t0.symbol}/${t1.symbol}`,
      token0: t0,
      token1: t1,
      fee: Number(fee),
      tick: p.tick,
      price: priceAt(p.tick, t0.decimals, t1.decimals),
      inRangeBins: bins.filter((b) => b.inRange).length,
      bins,
      unclaimed0: u0,
      unclaimed1: u1,
      unclaimed0Human: Number(u0) / 10 ** t0.decimals,
      unclaimed1Human: Number(u1) / 10 ** t1.decimals,
    });
  }
  return out;
}

// --------------------------------------------------------------- scoreboard
// Every 6 hours the agent publishes a 1-day call for the top pools; every 15 minutes it checks each live
// call against the pool price and records the share of checks that were inside. After 24h a call settles.
const SB_FILE = join(DATA, 'scoreboard.json');
const sb = existsSync(SB_FILE) ? JSON.parse(readFileSync(SB_FILE, 'utf8')) : { plans: [] };
const saveSb = () => writeFileSync(SB_FILE, JSON.stringify(sb, null, 1));

async function publishCalls() {
  const pools = (await topV3Pools()).filter((x) => x.tvlUsd > 50_000).slice(0, 6);
  for (const pool of pools) {
    try {
      const r = await plan({ pool: pool.address, horizonDays: 1, mode: 'both', amount0: 1, amount1: 1 });
      sb.plans.push({
        id: `${Date.now().toString(36)}-${pool.address.slice(2, 8)}`,
        pool: r.pool,
        pair: r.pair,
        invert: r.display.invert,
        shape: r.shape,
        createdAt: new Date().toISOString(),
        tickAtPlan: r.tick,
        tickLower: r.range.tickLower,
        tickUpper: r.range.tickUpper,
        priceAtPlan: r.display.invert ? 1 / r.price : r.price,
        priceLower: r.display.invert ? 1 / r.range.priceUpper : r.range.priceLower,
        priceUpper: r.display.invert ? 1 / r.range.priceLower : r.range.priceUpper,
        checks: 0,
        inside: 0,
        status: 'live',
      });
    } catch (e) {
      console.error('call failed', pool.address, e.shortMessage || e.message);
    }
  }
  saveSb();
}

async function checkCalls() {
  const now = Date.now();
  for (const c of sb.plans.filter((x) => x.status === 'live')) {
    try {
      const p = await readPool(c.pool);
      c.checks++;
      if (c.tickLower <= p.tick && p.tick < c.tickUpper) c.inside++;
      if (now - Date.parse(c.createdAt) >= 24 * 3600_000) {
        c.status = c.tickLower <= p.tick && p.tick < c.tickUpper ? 'in' : 'out';
        c.settledAt = new Date().toISOString();
      }
    } catch (e) {
      console.error('check failed', c.pool, e.shortMessage || e.message);
    }
  }
  saveSb();
}

function scoreboard() {
  const settled = sb.plans.filter((p) => p.status !== 'live');
  return {
    hitRate: settled.length ? settled.filter((p) => p.status === 'in').length / settled.length : null,
    settled: settled.length,
    live: sb.plans.length - settled.length,
    plans: sb.plans
      .slice(-60)
      .reverse()
      .map(({ checks, inside, ...p }) => ({ ...p, checks, timeInRange: checks ? inside / checks : null })),
  };
}

if (process.env.SCOREBOARD !== 'off') {
  const sixH = 6 * 3600_000;
  const last = sb.plans.length ? Date.parse(sb.plans[sb.plans.length - 1].createdAt) : 0;
  setTimeout(() => {
    publishCalls();
    setInterval(publishCalls, sixH);
  }, Math.max(0, last + sixH - Date.now()));
  setInterval(checkCalls, 15 * 60_000);
}

// --------------------------------------------------------------------- stake
const stakeAbi = parseAbi([
  'function totalStaked() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function committed() view returns (uint256)',
  'function unstreamed() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)',
  'function rungs() view returns (address)',
]);

async function stakeInfo(user) {
  if (!ADDR.stake) return { deployed: false };
  const r = (fn, args = []) => client.readContract({ address: ADDR.stake, abi: stakeAbi, functionName: fn, args });
  const [totalStaked, rewardRate, periodFinish, committed, unstreamed, rungs] = await Promise.all([
    r('totalStaked'),
    r('rewardRate'),
    r('periodFinish'),
    r('committed'),
    r('unstreamed'),
    r('rungs'),
  ]);
  const out = { deployed: true, address: ADDR.stake, rungs, totalStaked, rewardRateWeiPerSec: rewardRate / 10n ** 18n, periodFinish, committed, unstreamed };
  if (user) Object.assign(out, { balance: await r('balanceOf', [user]), earned: await r('earned', [user]) });
  return out;
}

// -------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    switch (url.pathname) {
      case '/api/health':
        return json(res, 200, { ok: true, block: await client.getBlockNumber() });
      case '/api/config':
        return json(res, 200, {
          chainId: robinhood.id,
          rpc: 'https://robinhood-rpc.publicnode.com',
          explorer: robinhood.blockExplorers.default.url,
          ladderManager: ADDR.ladder,
          stake: ADDR.stake,
          weth: ADDR.weth,
          usdg: ADDR.usdg,
          feeBps: 500,
        });
      case '/api/token':
        return json(res, 200, { ...TOKEN, pons: TOKEN.ca ? `https://ponsfamily.com/launchpad/${TOKEN.ca}` : null });
      case '/api/pools': {
        const pools = await topV3Pools();
        return json(
          res,
          200,
          pools.map((p) => {
            const tier = Number((p.name.match(/([\d.]+)%/) || [])[1] || 0) / 100;
            return { ...p, feesTvl24h: p.tvlUsd ? (p.volume24hUsd * tier) / p.tvlUsd : null };
          }),
        );
      }
      case '/api/plan': {
        if (!isAddress(q.pool || '')) return json(res, 400, { error: 'pool must be an address' });
        return json(res, 200, await plan(q));
      }
      case '/api/ladders': {
        if (!isAddress(q.owner || '')) return json(res, 400, { error: 'owner must be an address' });
        return json(res, 200, await laddersOf(getAddress(q.owner)));
      }
      case '/api/scoreboard':
        return json(res, 200, scoreboard());
      case '/api/stake':
        return json(res, 200, await stakeInfo(isAddress(q.user || '') ? getAddress(q.user) : null));
      default:
        return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    console.error(url.pathname, e);
    return json(res, 500, { error: e.shortMessage || e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`stagger api on :${PORT}`));
