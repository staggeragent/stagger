export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function usd(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (a >= 100) return '$' + n.toFixed(0);
  if (a >= 1) return '$' + n.toFixed(2);
  if (a === 0) return '$0';
  return '$' + n.toPrecision(2);
}

/** price-like number with sensible significant digits */
export function num(n, sig = 5) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return Number(n.toPrecision(sig)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  return Number(n.toPrecision(sig - 1)).toString();
}

export const pct = (f, d = 1) => (f == null || !isFinite(f) ? '—' : (f * 100).toFixed(d) + '%');
export const signedPct = (f, d = 2) => (f == null || !isFinite(f) ? '—' : (f >= 0 ? '+' : '') + (f * 100).toFixed(d) + '%');

/** Robust percent: API may send 0.05 or 5 for 5%; anything with |x| > 2 is already in percent. */
export const asFrac = (x) => (x == null ? null : Math.abs(x) > 2 ? x / 100 : x);

export function age(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '—';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 60) return Math.round(s / 86400) + 'd';
  return Math.round(s / 86400 / 30) + 'mo';
}

export function utc(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

/** raw integer string -> human number string */
export function units(raw, decimals = 18, sig = 6) {
  if (raw == null) return '—';
  const b = BigInt(raw);
  const neg = b < 0n;
  const v = neg ? -b : b;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return (neg ? '-' : '') + num(Number(s), sig);
}

/** "USDG / WETH 0.01%" -> { pair: "USDG / WETH", tier: "0.01%" } */
export function splitName(name = '') {
  const m = name.match(/^(.*?)\s+([\d.]+%)$/);
  return m ? { pair: m[1], tier: m[2] } : { pair: name, tier: '—' };
}

export function countdown(ms) {
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return (d ? `${d}d ` : '') + `${p(h)}:${p(m)}:${p(sec)}`;
}
