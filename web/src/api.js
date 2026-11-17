// API client. In production every number comes from /api (proxied to the Stagger server).
// In `vite dev` only, if the server is not answering yet, a clearly-labelled mock is used (never bundled in builds).
let mockOn = false;
const listeners = new Set();
export const onMock = (fn) => (mockOn ? fn() : listeners.add(fn));

export async function api(path, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch('/api' + path, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('API not reachable');
    return await r.json();
  } catch (e) {
    if (import.meta.env.DEV) {
      const m = await import('./mock.js');
      const out = m.mock(path);
      if (out !== undefined) {
        if (!mockOn) { mockOn = true; listeners.forEach((fn) => fn()); listeners.clear(); }
        return out;
      }
    }
    if (e.name === 'AbortError') throw new Error('The server took too long to answer');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Cached shared calls
let cfgP, tokP;
export const getConfig = () => (cfgP ||= api('/config').catch((e) => { cfgP = null; throw e; }));
export const getToken = () => (tokP ||= api('/token').catch((e) => { tokP = null; throw e; }));

// Chain constants (public infra, not data) used when /api/config is not reachable.
export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  rpc: 'https://robinhood-rpc.publicnode.com',
  explorer: 'https://robinhoodchain.blockscout.com',
};
export const LAUNCH_AT = '2026-11-17T15:00:00Z';
export const X_URL = 'https://x.com/staggeragent';
