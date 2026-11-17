// Tiny wallet state without viem (so first paint does not load it).
import { short } from './fmt.js';

const bus = new EventTarget();
export let account = null;

export function setAccount(a) {
  account = a ? a.toLowerCase() : null;
  document.querySelectorAll('[data-connect]').forEach((b) => (b.textContent = account ? short(account) : 'Connect wallet'));
  bus.dispatchEvent(new Event('account'));
}
export const onAccount = (fn) => bus.addEventListener('account', fn);

export async function initState() {
  const eth = window.ethereum;
  if (!eth) return;
  try {
    const accs = await eth.request({ method: 'eth_accounts' });
    if (accs && accs[0]) setAccount(accs[0]);
  } catch {}
  eth.on?.('accountsChanged', (accs) => setAccount(accs && accs[0]));
}

export async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No browser wallet found. Install one (MetaMask, Rabby, …) and reload.');
  const accs = await eth.request({ method: 'eth_requestAccounts' });
  setAccount(accs[0]);
  return account;
}

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
