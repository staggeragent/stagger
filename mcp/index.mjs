#!/usr/bin/env node
// Stagger MCP server: lets other agents ask the Stagger range agent for a plan and get calldata to sign.
// It never signs or sends anything. Usage in an MCP client: { "command": "npx", "args": ["stagger-mcp"] }
// STAGGER_API overrides the API base (default https://staggeragent.xyz).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.STAGGER_API || 'https://staggeragent.xyz').replace(/\/$/, '');

async function get(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  const r = await fetch(`${API}/api/${path}${qs ? `?${qs}` : ''}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

const server = new McpServer({ name: 'stagger', version: '0.1.0' });

server.registerTool(
  'stagger_pools',
  {
    title: 'Stagger: top pools',
    description: 'Top Uniswap v3 pools on Robinhood Chain (4663) by 24h volume, with TVL, volume and fees/TVL.',
    inputSchema: { limit: z.number().int().min(1).max(60).optional() },
  },
  async ({ limit = 15 }) => text((await get('pools')).slice(0, limit)),
);

server.registerTool(
  'stagger_plan',
  {
    title: 'Stagger: range plan',
    description:
      'Ask the Stagger range agent for a liquidity ladder on a Uniswap v3 pool on Robinhood Chain: it measures the pool, ' +
      'picks a shape (spot/curve/bidask), a price range and bins, explains every number, and returns unsigned calldata ' +
      'for LadderManager.open plus the token approvals needed. The caller signs and sends; Stagger never holds funds.',
    inputSchema: {
      pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('Uniswap v3 pool address'),
      horizonDays: z.number().min(1).max(30).optional().describe('How long the position should stay in range (default 7)'),
      mode: z.enum(['both', 'below', 'above']).optional().describe('both = two-sided; below/above = one-sided vs the displayed price'),
      shape: z.enum(['spot', 'curve', 'bidask']).optional().describe('Override the agent shape'),
      amount0: z.number().nonnegative().optional().describe('Max amount of token0 to put in (human units)'),
      amount1: z.number().nonnegative().optional().describe('Max amount of token1 to put in (human units)'),
      bins: z.number().int().min(1).max(40).optional(),
    },
  },
  async (args) => {
    const p = await get('plan', args);
    return text({
      pair: p.pair,
      shape: p.shape,
      range: p.range,
      stayProbability: p.stayProbability,
      feesPerDayUsd: p.feesPerDayUsd,
      explain: p.explain,
      bins: p.bins.length,
      totals: p.totals,
      tx: p.tx,
    });
  },
);

server.registerTool(
  'stagger_ladders',
  {
    title: 'Stagger: ladders of a wallet',
    description: 'Open Stagger ladders of a wallet: bins in range and unclaimed fees.',
    inputSchema: { owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  },
  async ({ owner }) => text(await get('ladders', { owner })),
);

server.registerTool(
  'stagger_track_record',
  {
    title: 'Stagger: agent track record',
    description: "The agent's public 1-day calls on top pools and whether the price stayed inside the range.",
    inputSchema: {},
  },
  async () => text(await get('scoreboard')),
);

await server.connect(new StdioServerTransport());
