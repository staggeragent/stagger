// Shared on every page: wallet button, countdown to launch (UTC), CA slot + copy, Buy on Pons / X links, mock banner.
import '@fontsource/host-grotesk/latin-400';
import '@fontsource/host-grotesk/latin-500';
import '@fontsource/host-grotesk/latin-600';
import '@fontsource/host-grotesk/latin-800';
import '@fontsource/cormorant-garamond/latin-500-italic';
import '@fontsource/overpass-mono/latin-400';
import '@fontsource/overpass-mono/latin-600';
import './styles.css';
import { api, LAUNCH_AT, X_URL, onMock } from './api.js';
import { countdown, esc } from './fmt.js';
import { initState, connect, account, toast } from './state.js';

let token = { ca: null, launchAt: LAUNCH_AT, pons: null, x: X_URL };

function paintToken() {
  const ca = token.ca;
  document.querySelectorAll('[data-ca]').forEach((el) => {
    el.classList.toggle('live', !!ca);
    el.innerHTML = ca
      ? `<span class="mono small muted">CA</span><code title="${esc(ca)}">${esc(ca)}</code><button class="btn btn-ghost" type="button" data-copy>Copy</button>`
      : `<span class="mono small muted">CA</span><code class="muted">appears here at 15:00 UTC</code><button class="btn btn-ghost" type="button" disabled>Copy</button>`;
  });
  document.querySelectorAll('[data-buy]').forEach((a) => {
    if (token.pons) { a.href = token.pons; a.removeAttribute('aria-disabled'); a.textContent = 'Buy $RUNGS on Pons'; }
    else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.textContent = 'Pons link opens at 15:00 UTC'; }
  });
  document.querySelectorAll('[data-x]').forEach((a) => (a.href = token.x || X_URL));
}

function tick() {
  const left = new Date(token.launchAt || LAUNCH_AT).getTime() - Date.now();
  const c = countdown(left);
  const txt = c ? `$RUNGS launches in ${c}` : token.ca ? '$RUNGS is live' : '$RUNGS · launching now';
  document.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = c ? `T−${c}` : token.ca ? 'Live' : 'Launching'));
  document.querySelectorAll('[data-countdown-chip]').forEach((el) => (el.textContent = txt));
}

export function initShell() {
  initState();
  document.querySelectorAll('[data-connect]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (account) return;
      try { await connect(); } catch (e) { toast(e.message || 'Could not connect'); }
    }),
  );
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b || !token.ca) return;
    try { await navigator.clipboard.writeText(token.ca); toast('Contract address copied'); }
    catch { toast('Copy failed — select the address manually'); }
  });
  paintToken();
  tick();
  setInterval(tick, 1000);
  const load = () => api('/token').then((t) => { token = { ...token, ...t }; paintToken(); tick(); }).catch(() => {});
  load();
  // Before T0 keep polling for the CA so the slot fills itself at launch.
  setInterval(() => { if (!token.ca) { load(); } }, 30000);
  onMock(() => {
    if (document.querySelector('.mockbar')) return;
    const bar = document.createElement('div');
    bar.className = 'mockbar';
    bar.textContent = 'DEV MOCK — the API on :4252 is not answering, numbers below are generated placeholders (never in builds).';
    document.body.prepend(bar);
  });
}
