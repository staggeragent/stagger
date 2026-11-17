// viem wallet + chain helpers. Loaded on demand (connect / sign).
import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbi, maxUint256 } from 'viem';
import { CHAIN, getConfig } from './api.js';
import { connect, account } from './state.js';

let chain, pub;
async function setup() {
  if (chain) return;
  let cfg = {};
  try { cfg = await getConfig(); } catch {}
  const rpc = cfg.rpc || CHAIN.rpc;
  const explorer = cfg.explorer || CHAIN.explorer;
  chain = defineChain({
    id: cfg.chainId || CHAIN.id,
    name: CHAIN.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'Blockscout', url: explorer } },
  });
  pub = createPublicClient({ chain, transport: http(rpc) });
}

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
export const ladderAbi = parseAbi([
  'function claim(uint256 ladderId, address to, bool asWeth) returns (uint256, uint256)',
  'function withdraw(uint256 ladderId, uint256[] indices, address to, bool asWeth, uint256 min0, uint256 min1, uint256 deadline)',
  'function close(uint256 ladderId, address to, bool asWeth, uint256 min0, uint256 min1, uint256 deadline)',
]);
export const stakeAbi = parseAbi([
  'function rungs() view returns (address)',
  'function stake(uint256 amount)',
  'function unstake(uint256 amount)',
  'function claim() returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)',
]);

export async function publicClient() {
  await setup();
  return pub;
}

async function ensureChain(eth) {
  const id = await eth.request({ method: 'eth_chainId' });
  if (parseInt(id, 16) === chain.id) return;
  const hex = '0x' + chain.id.toString(16);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || '')) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [chain.blockExplorers.default.url],
        }],
      });
    } else throw e;
  }
}

/** Connected wallet client on chain 4663 */
export async function wallet() {
  await setup();
  const eth = window.ethereum;
  const acc = account || (await connect());
  await ensureChain(eth);
  const wc = createWalletClient({ account: acc, chain, transport: custom(eth) });
  return { wc, pub, account: acc, chain };
}

/** send a tx and wait for 1 confirmation; returns hash */
export async function send(req, onStatus = () => {}) {
  const { wc, pub, chain } = await wallet();
  onStatus('Confirm in your wallet…');
  const hash = await wc.sendTransaction(req);
  onStatus(`Sent ${hash.slice(0, 10)}… waiting for confirmation`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`Transaction reverted: ${chain.blockExplorers.default.url}/tx/${hash}`);
  return hash;
}

export async function write(address, abi, functionName, args, onStatus = () => {}, value) {
  const { wc, pub, chain, account: acc } = await wallet();
  onStatus('Confirm in your wallet…');
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: acc, value });
  const hash = await wc.writeContract(request);
  onStatus(`Sent ${hash.slice(0, 10)}… waiting for confirmation`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`Transaction reverted: ${chain.blockExplorers.default.url}/tx/${hash}`);
  return hash;
}

/** approve `spender` for `amount` of `token` if the current allowance is lower */
export async function ensureAllowance(token, spender, amount, label, onStatus) {
  const { pub, account: acc } = await wallet();
  const need = BigInt(amount);
  if (need === 0n) return;
  const have = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [acc, spender] });
  if (have >= need) return;
  onStatus?.(`Approve ${label || 'token'} (1 of 2)…`);
  await write(token, erc20Abi, 'approve', [spender, need], onStatus);
}

export const explorerTx = (h) => `${(chain?.blockExplorers.default.url) || CHAIN.explorer}/tx/${h}`;
export { maxUint256 };

export function niceError(e) {
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  if (/user rejected|denied|rejected the request/i.test(m)) return 'You rejected the request in your wallet.';
  if (/insufficient funds/i.test(m)) return 'Not enough ETH for this transaction plus gas.';
  return m.split('\n')[0].slice(0, 220);
}
