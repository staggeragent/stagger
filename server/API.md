# Stagger API (server/, port 4252 locally, behind nginx at /api in production)

All amounts are strings of raw integer units unless the field ends in `Human`/`Usd`. Chain 4663 (Robinhood Chain mainnet).

## GET /api/config
`{ chainId: 4663, rpc, explorer, ladderManager: "0x…"|null, stake: "0x…"|null, weth, usdg, feeBps: 500 }`
`ladderManager`/`stake` are null until the contracts are deployed: the web must still work read-only (Pools, Agent plan) and
show "contract not deployed yet" on the sign button.

## GET /api/token
`{ name: "Stagger", ticker: "RUNGS", ca: null|"0x…", launchAt: "2026-11-17T15:00:00Z", pons: null|"https://ponsfamily.com/launchpad/<ca>", x: "https://x.com/staggeragent" }`
`ca` stays null until T0 (golive). Web shows an empty CA slot with copy button and a countdown to launchAt (UTC).

## GET /api/pools
Top Uniswap v3 pools on Robinhood Chain by 24h volume (cached 2 min).
`[{ address, name, tvlUsd, volume24hUsd, feesTvl24h, priceChange24h, createdAt }]`
(`feesTvl24h` = 24h fees / TVL as a fraction; the fee tier is in `name`, e.g. "USDG / WETH 0.01%").

## GET /api/plan?pool=0x…&horizonDays=7&mode=both|below|above&shape=spot|curve|bidask&amount0=1&amount1=2000&bins=
The range agent. `shape` and `bins` are optional overrides; without them the agent decides. `amount0/amount1` are HUMAN
amounts = the most the user wants to put in of each token. Response:
```
{
  pool, pair: "ETH/USDG", fee: 100, token0:{address,symbol,decimals}, token1:{…},
  tick, price,                      // token0 priced in token1 (human)
  display: { base, quote, invert }, // show prices as `quote per base`; when invert=true use 1/price for every price field
  horizonDays, mode, shape,
  measured: { windowHours, source: "candles"|"oracle", sigmaDay, autocorr, drift, trendScore } | null,
  history: [price, …],              // hourly prices oldest→newest (token0 in token1, apply invert for display)
  range: { tickLower, tickUpper, priceLower, priceUpper },
  stayProbability: 0.8|null,
  bins: [{ tickLower, tickUpper, priceLower, priceUpper, weight, amount0, amount1 }],
  totals: { amount0, amount1, amount0Human, amount1Human },
  feesPerDayUsd: number|null,
  explain: ["sentence", …],         // plain-words reasoning, show all of it
  tx: { to: ladderManager|null, data, value, approve: [{ token, amount }] }
}
```
To open: for each `approve` entry call `approve(ladderManager, amount)` on the token, then send `{to, data, value}`.

## GET /api/ladders?owner=0x…
```
[{ id, pair, token0, token1, fee, inRangeBins, bins: [{ tokenId, tickLower, tickUpper, priceLower, priceUpper, liquidity, inRange }],
   unclaimed0, unclaimed1, unclaimed0Human, unclaimed1Human }]
```
Actions are direct contract calls from the wallet: `claim(id, to, asWeth)`, `withdraw(id, indices[] strictly descending, to, asWeth, min0, min1, deadline)`, `close(id, to, asWeth, min0, min1, deadline)`. Use `to` = the connected wallet, `asWeth` = false (receive native ETH), `min0/min1` = 0 or a slippage floor. After a partial withdraw the remaining bins are reordered (swap-and-pop): re-read the ladder.

## GET /api/scoreboard
The agent's public track record. Every 6 hours it plans a 1-day range for the top pools and later checks the result.
```
{ hitRate: 0.0-1.0|null, settled: n, live: n,
  plans: [{ id, pool, pair, shape, createdAt, priceAtPlan, priceLower, priceUpper, timeInRange (0-1), status: "live"|"in"|"out", settledAt }] }
```

## GET /api/stake  (after deploy)
`{ totalStaked, rewardRate, periodFinish, unstreamed, committed }`; per-user via `?user=0x…` adds `{ balance, earned }`.
Stake actions are direct calls on StaggerStake: `stake(amount)` (after RUNGS approve), `unstake(amount)`, `claim()`, and permissionless `notify()`. The protocol cut is 5% of the ETH side of claimed fees only; StaggerStake holds only ETH.

## MCP
`mcp/` exposes the same plan as an MCP tool `stagger_plan` and pools as `stagger_pools`, for other agents.
