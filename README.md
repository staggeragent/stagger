# Stagger

A range agent and LP ladder manager for Uniswap v3 on Robinhood Chain (chain 4663).
The agent reads a pool live, measures how its price moves, and proposes a shape (Spot, Curve or Bid-Ask),
a price range and 1–40 bins, explaining every number. You sign one transaction; the ladder stays yours.

Site: https://staggeragent.xyz · X: https://x.com/staggeragent

## Contracts (Robinhood Chain mainnet)

| Contract | Address | What it does |
| --- | --- | --- |
| LadderManager | [`0x0114b4E481ca3227799FF22554913431A821FBfB`](https://robinhoodchain.blockscout.com/address/0x0114b4E481ca3227799FF22554913431A821FBfB?tab=contract) | Opens 1–40 Uniswap v3 positions in one tx and holds them for the owner only (claim / withdraw some bins / close). Takes 5% of the ETH side of claimed fees, never principal; fixed at deploy. |
| StaggerStake | [`0x90F6EFde4F94BAb1906ef2D263174101a22C4872`](https://robinhoodchain.blockscout.com/address/0x90F6EFde4F94BAb1906ef2D263174101a22C4872?tab=contract) | Receives that ETH and streams it to $RUNGS stakers over 7 days. ETH only, no swaps, no oracle. |

Both are source verified (exact match) on Blockscout and Sourcify. No proxy, no upgrade, no admin;
the only privileged call is `setToken` on StaggerStake, callable once. **Not audited.** An independent
internal review found issues that were fixed before deploy (the fee-token swap path was removed entirely).

## Layout

- `contracts/` Foundry: `LadderManager.sol`, `StaggerStake.sol`, fork tests against mainnet.
- `server/` Node API: pools, the range agent (`src/plan.mjs`), ladders, the agent's public track record. See `server/API.md`.
- `mcp/` MCP server for other agents: `stagger_pools`, `stagger_plan`, `stagger_ladders`, `stagger_track_record`.
- `web/` Vite + three.js site.

## How the agent decides

Daily volatility σ comes from hourly prices of the pool (its own oracle, or hourly candles).
Shape: Curve when σ < 1.5%/day and hourly moves tend to reverse; Bid-Ask when σ > 5%/day or the price trends;
otherwise Spot. Range half-width = z × σ × √days (z = 1.0 / 1.28 / 1.64), so in a normal model the price is still
inside after the horizon about 68 / 80 / 90% of the time. These are calculations from past prices, not advice.

## Run

```bash
# contracts (fork tests read live mainnet state; publicnode refuses archive reads, use an RPC that allows them)
cd contracts && forge install foundry-rs/forge-std Uniswap/v3-core@0.8 --no-git
forge test --fork-url <robinhood-mainnet-rpc>

# API
cd server && npm ci && node src/index.mjs     # :4252

# web
cd web && npm ci && npm run dev               # /api proxied to :4252

# MCP (stdio)
cd mcp && npm ci && STAGGER_API=https://staggeragent.xyz node index.mjs
```

## License

MIT for Stagger's own code. `contracts/` tests use Uniswap v3-core math libraries (GPL-2.0-or-later).
