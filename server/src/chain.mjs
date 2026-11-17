import { createPublicClient, http, parseAbi, defineChain } from 'viem';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://robinhood-rpc.publicnode.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const client = createPublicClient({ chain: robinhood, transport: http(undefined, { batch: true }) });

export const ADDR = {
  factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  npm: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  ladder: process.env.LADDER_MANAGER || null,
  stake: process.env.STAGGER_STAKE || null,
};

export const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[])',
]);

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export const ladderAbi = parseAbi([
  'struct Bin { int24 tickLower; int24 tickUpper; uint256 amount0; uint256 amount1; }',
  'function open(address token0, address token1, uint24 fee, Bin[] bins, uint256 slippageBps, uint256 deadline) payable returns (uint256)',
  'function claim(uint256 ladderId, address to, bool asWeth) returns (uint256, uint256)',
  'function withdraw(uint256 ladderId, uint256[] indices, address to, bool asWeth, uint256 min0, uint256 min1, uint256 deadline)',
  'function close(uint256 ladderId, address to, bool asWeth, uint256 min0, uint256 min1, uint256 deadline)',
  'function getLadder(uint256 ladderId) view returns (address owner, address token0, address token1, uint24 fee, uint256[] tokenIds)',
  'function laddersOf(address owner) view returns (uint256[])',
  'function feeBps() view returns (uint256)',
]);

export const npmAbi = parseAbi([
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function collect(CollectParams) returns (uint256 amount0, uint256 amount1)',
]);

const tokenCache = new Map();
export async function tokenInfo(address) {
  const k = address.toLowerCase();
  if (tokenCache.has(k)) return tokenCache.get(k);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);
  const info = { address, symbol: k === ADDR.weth.toLowerCase() ? 'ETH' : symbol, decimals: Number(decimals) };
  tokenCache.set(k, info);
  return info;
}
