import { initShell } from './shell.js';
import { api, getConfig } from './api.js';
import { esc, usd, num, pct, signedPct, age, utc, short, units, splitName } from './fmt.js';
import { account, onAccount, connect, toast } from './state.js';
import { ladderSvg, axisLabels } from './ladder2d.js';

initShell();

const $ = (id) => document.getElementById(id);
const SHAPE = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
const params = { pool: null, horizonDays: 7, mode: 'both', shape: '', amount0: '', amount1: '' };
let pools = [];
let showAllPools = false;
let cfg = null;
let plan = null;
let vm = null;
let planAt = 0;
let scene = null;
let fallback = null;

/* ------------------------------------------------------------------ hero visual */
function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
const lite = matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(max-width: 760px)').matches || !webglOK();
const stage = $('stage');
if (lite) {
  fallback = document.createElement('div');
  fallback.className = 'stage-fallback';
  stage.classList.add('is-poster');
  fallback.innerHTML = '<img src="/poster.webp" alt="" width="1575" height="1925" fetchpriority="high">';
  stage.querySelector('.stage-copy').after(fallback);
} else {
  // three.js is loaded after first paint
  const start = () => import('./scene.js').then((m) => { scene = m.createScene(stage, $('ruler')); if (vm) paintHero(); }).catch(() => {});
  (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(start);
}

const MIN_SLATS = 18;
function slatInfo() {
  const nb = vm.bins.length;
  const n = Math.min(48, Math.max(MIN_SLATS, nb));
  const t = (Math.log(vm.price) - Math.log(vm.range[0])) / (Math.log(vm.range[1]) - Math.log(vm.range[0]) || 1);
  return { n, live: t >= 0 && t <= 1 ? Math.min(n - 1, Math.floor(t * n)) : t < 0 ? 0 : n - 1, outside: t < 0 ? 'below' : t > 1 ? 'above' : null };
}

/** the survey staff: range low (bottom) to range high (top), a major tick per bin edge, a minor tick per slat, live price in yellow */
function paintRuler(info) {
  const unit = `${plan.display.quote}/${plan.display.base}`;
  const nb = vm.bins.length;
  let h = '';
  for (let i = 0; i <= info.n; i++) h += `<i class="t-minor" style="bottom:${((i / info.n) * 100).toFixed(3)}%"></i>`;
  for (let j = 0; j <= nb; j++) h += `<i class="t-major" style="bottom:${((j / nb) * 100).toFixed(3)}%"></i>`;
  h += `<span class="r-lab r-hi" style="bottom:100%">high ${num(vm.range[1])}</span>`;
  h += `<span class="r-lab r-lo" style="bottom:0%">low ${num(vm.range[0])}</span>`;
  const f = info.outside === 'above' ? 1.04 : info.outside === 'below' ? -0.04 : (info.live + 0.5) / info.n;
  const note = info.outside ? ` · ${info.outside} range` : '';
  h += `<span class="r-now" style="bottom:${(f * 100).toFixed(3)}%"><b>${num(vm.price)}</b> ${esc(unit)}${note}</span>`;
  $('rulerTicks').innerHTML = h;
}

function paintHero() {
  if (!vm) return;
  $('stageTag').innerHTML = `${esc(plan.pair)} · ${esc(SHAPE[plan.shape] || plan.shape)}<br>${vm.bins.length} bin${vm.bins.length > 1 ? 's' : ''} · ${esc(plan.horizonDays)}d`;
  const info = scene ? scene.update(vm) : slatInfo();
  paintRuler(info);
}

/* ------------------------------------------------------------------ plan */
function toVM(p) {
  const inv = !!p.display?.invert;
  const d = (x) => (inv ? 1 / x : x);
  const bins = (p.bins || [])
    .map((b) => {
      const a = d(b.priceLower), c = d(b.priceUpper);
      return { lo: Math.min(a, c), hi: Math.max(a, c), weight: Number(b.weight) || 0 };
    })
    .sort((a, b) => a.lo - b.lo);
  const price = d(p.price);
  const ra = d(p.range.priceLower), rb = d(p.range.priceUpper);
  const range = [Math.min(ra, rb), Math.max(ra, rb)];
  bins.forEach((b) => (b.live = price >= b.lo && price < b.hi));
  const history = (p.history || []).filter((x) => x > 0).map(d);
  let lo = Math.min(range[0], price), hi = Math.max(range[1], price);
  const span = Math.log(hi) - Math.log(lo) || 0.02;
  lo = Math.exp(Math.log(lo) - span * 0.22);
  hi = Math.exp(Math.log(hi) + span * 0.22);
  return { bins, price, range, history, domain: [lo, hi] };
}

const planPath = () => {
  const q = new URLSearchParams({ pool: params.pool, horizonDays: params.horizonDays, mode: params.mode, amount0: params.amount0 || '0', amount1: params.amount1 || '0' });
  if (params.shape) q.set('shape', params.shape);
  if (account) q.set('owner', account);
  return '/plan?' + q;
};

let planSeq = 0;
async function loadPlan({ silent = false } = {}) {
  if (!params.pool) return;
  const seq = ++planSeq;
  if (!silent) $('plan').style.opacity = '0.55';
  try {
    const p = await api(planPath(), { timeout: 30000 });
    if (seq !== planSeq) return;
    plan = p;
    vm = toVM(p);
    planAt = Date.now();
    renderPlan();
    paintHero();
  } catch (e) {
    if (seq !== planSeq) return;
    if (!silent || !plan) {
      $('plan').innerHTML = `<div class="empty err">The agent could not plan this pool: ${esc(e.message)}. <button class="btn" type="button" id="planRetry">Try again</button></div>`;
      $('planRetry').onclick = () => loadPlan();
      $('stageTag').textContent = 'No plan loaded';
    }
  } finally {
    if (seq === planSeq) $('plan').style.opacity = '';
  }
}

function signState() {
  if (!cfg) return { ok: false, label: 'Loading contract config…' };
  if (cfg.error) return { ok: false, label: 'Contract config unavailable · reload to retry' };
  if (!cfg.ladderManager) return { ok: false, label: 'LadderManager not deployed yet · plan only' };
  if (!plan?.tx?.to) return { ok: false, label: 'Plan has no transaction' };
  const t = plan.totals || {};
  if (!(Number(t.amount0Human) > 0 || Number(t.amount1Human) > 0)) return { ok: false, label: 'Enter an amount to sign' };
  return { ok: true, label: account ? 'Sign & open ladder' : 'Connect wallet & open ladder' };
}

function renderPlan() {
  const p = plan;
  const m = p.measured;
  const unit = `${esc(p.display.quote)} per ${esc(p.display.base)}`;
  $('lbl0').textContent = `${p.token0.symbol} max`;
  $('lbl1').textContent = `${p.token1.symbol} max`;
  const widthPct = (vm.range[1] / vm.range[0] - 1) * 100;
  const s = signState();
  const src = m
    ? `Measured over ${m.windowHours}h of ${m.source === 'candles' ? 'hourly candles (GeckoTerminal)' : 'pool oracle TWAP'} · σ ${pct(m.sigmaDay, 2)}/day · autocorr ${num(m.autocorr, 2)} · trend ${num(m.trendScore, 2)}`
    : 'Too little price history to measure: the agent assumes a wild market and goes wide.';
  const t = p.totals || {};
  $('plan').innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Shape</span><b>${esc(SHAPE[p.shape] || p.shape)}</b></div>
      <div class="kpi"><span>Stays inside${p.stayProbability == null ? '' : ` · ${esc(p.horizonDays)}d`}</span><b>${p.stayProbability == null ? 'one-sided' : pct(p.stayProbability, 0)}</b></div>
      <div class="kpi"><span>Fees / day est.</span><b>${p.feesPerDayUsd == null || !(Number(t.amount0Human) > 0 || Number(t.amount1Human) > 0) ? '—' : usd(p.feesPerDayUsd)}</b></div>
    </div>
    <div class="range-line">
      <div>${num(vm.range[0])} – ${num(vm.range[1])} <span class="muted">${unit}</span></div>
      <div class="muted">now <span class="sodium">${num(vm.price)}</span> · width ${widthPct.toFixed(1)}% · ${vm.bins.length} bin${vm.bins.length > 1 ? 's' : ''} · fee tier ${(p.fee / 10000).toFixed(2)}%</div>
    </div>
    <div>${ladderSvg(vm, { w: 400, h: 120 }).replace('<svg ', '<svg class="binchart" ')}${axisLabels(vm)}</div>
    <ol class="explain">${(p.explain || []).map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ol>
    <div class="source">${esc(src)}</div>
    <div class="range-line small">Goes in: <b>${num(Number(t.amount0Human) || 0)}</b> ${esc(p.token0.symbol)} + <b>${num(Number(t.amount1Human) || 0)}</b> ${esc(p.token1.symbol)}${p.feesPerDayUsd == null || !(Number(t.amount0Human) > 0 || Number(t.amount1Human) > 0) ? '<br><span class="muted">Fee estimate needs an amount and 24h volume. Two-sided needs both tokens.</span>' : ''}</div>
    <button class="btn btn-primary" type="button" id="signBtn" ${s.ok ? '' : 'disabled'}>${esc(s.label)}</button>
    <div class="status" id="signStatus"></div>
    <p class="sign-note">One wallet transaction (plus a token approval if needed). The LadderManager holds the bins for you; only your wallet can claim, withdraw or close. Not advice. <a href="/docs/#risks">Risks</a>.</p>`;
  $('signBtn').onclick = sign;
}

async function sign() {
  const btn = $('signBtn');
  const st = (msg, cls = '') => { const el = $('signStatus'); if (el) { el.className = 'status ' + cls; el.innerHTML = msg; } };
  btn.disabled = true;
  try {
    const w = await import('./wallet.js');
    await w.wallet();
    st('Refreshing the plan at the latest price…');
    const fresh = await api(planPath(), { timeout: 30000 });
    if (!fresh.tx?.to) throw new Error('The contract is not deployed yet.');
    const sym = (addr) => (addr.toLowerCase() === fresh.token0.address.toLowerCase() ? fresh.token0.symbol : fresh.token1.symbol);
    for (const a of fresh.tx.approve || []) await w.ensureAllowance(a.token, fresh.tx.to, a.amount, sym(a.token), (m) => st(esc(m)));
    st('Open the ladder: confirm in your wallet…');
    const hash = await w.send({ to: fresh.tx.to, data: fresh.tx.data, value: BigInt(fresh.tx.value || 0) }, (m) => st(esc(m)));
    st(`Ladder opened. <a href="${w.explorerTx(hash)}" target="_blank" rel="noopener">View on Blockscout</a> · <a href="#portfolio">Portfolio</a>`, 'sodium');
    loadPortfolio();
  } catch (e) {
    const w = await import('./wallet.js');
    st(esc(w.niceError(e)), 'err');
  } finally {
    btn.disabled = !signState().ok;
  }
}

/* ------------------------------------------------------------------ controls */
let debounce;
const replan = (ms = 350) => { clearTimeout(debounce); debounce = setTimeout(() => loadPlan(), ms); };
function seg(id, key, cast = (x) => x) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    params[key] = cast(b.dataset.v);
    replan(0);
  });
}
seg('horizon', 'horizonDays', Number);
seg('mode', 'mode');
seg('shape', 'shape');
$('poolSel').addEventListener('change', (e) => selectPool(e.target.value));
for (const k of ['amount0', 'amount1']) {
  const el = $(k === 'amount0' ? 'amt0' : 'amt1');
  el.addEventListener('input', () => { params[k] = el.value && Number(el.value) >= 0 ? el.value : ''; replan(); });
}
$('balHint').textContent = 'Amounts are the most you want to put in; the agent may use less of one side.';

function selectPool(addr, scroll = false) {
  params.pool = addr;
  $('poolSel').value = addr;
  document.querySelectorAll('#poolRows tr[data-pool]').forEach((tr) => tr.setAttribute('aria-selected', String(tr.dataset.pool === addr)));
  loadPlan();
  if (scroll) document.getElementById('agent').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

setInterval(() => {
  if (plan && document.visibilityState === 'visible') loadPlan({ silent: true });
}, 60000);
setInterval(() => {
  if (planAt) $('planAge').textContent = `updated ${Math.round((Date.now() - planAt) / 1000)}s ago`;
}, 1000);

/* ------------------------------------------------------------------ pools */
async function loadPools() {
  try {
    const list = await api('/pools');
    pools = Array.isArray(list) ? list : [];
    if (!pools.length) {
      $('poolRows').innerHTML = `<tr><td colspan="7"><div class="empty">No Uniswap v3 pools returned right now.</div></td></tr>`;
      $('poolSel').innerHTML = '<option>No pools</option>';
      $('plan').innerHTML = '<div class="empty">No pool to plan yet.</div>';
      return;
    }
    $('poolSel').innerHTML = pools.map((p) => `<option value="${esc(p.address)}">${esc(p.name)}</option>`).join('');
    const shown = showAllPools ? pools : pools.slice(0, 20);
    $('poolsMore').hidden = showAllPools || pools.length <= 20;
    $('poolsMore').textContent = `Show all ${pools.length} pools`;
    $('poolRows').innerHTML = shown
      .map((p) => {
        const n = splitName(p.name);
        const ch = Number(p.priceChange24h) / 100;
        return `<tr data-pool="${esc(p.address)}" tabindex="0" aria-selected="false">
          <td><b>${esc(n.pair)}</b> <span class="mono small muted">${esc(short(p.address))}</span></td>
          <td class="mono">${esc(n.tier)}</td>
          <td class="num">${usd(p.tvlUsd)}</td>
          <td class="num">${usd(p.volume24hUsd)}</td>
          <td class="num">${p.feesTvl24h == null ? '—' : pct(p.feesTvl24h, 2)}</td>
          <td class="num ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${signedPct(ch)}</td>
          <td class="num">${age(p.createdAt)}</td></tr>`;
      })
      .join('');
    if (!params.pool || !pools.some((p) => p.address === params.pool)) {
      const fromHash = new URLSearchParams(location.hash.split('?')[1] || '').get('pool');
      selectPool(pools.find((p) => p.address.toLowerCase() === (fromHash || '').toLowerCase())?.address || pools[0].address);
    } else {
      $('poolSel').value = params.pool;
      document.querySelectorAll('#poolRows tr[data-pool]').forEach((tr) => tr.setAttribute('aria-selected', String(tr.dataset.pool === params.pool)));
    }
  } catch (e) {
    $('poolRows').innerHTML = `<tr><td colspan="7"><div class="empty err">Could not load pools: ${esc(e.message)}. Retrying in 30s.</div></td></tr>`;
    if (!plan) {
      $('poolSel').innerHTML = '<option>Pools unavailable</option>';
      $('plan').innerHTML = `<div class="empty err">The agent needs the pool list first. Retrying in 30s.</div>`;
    }
    setTimeout(loadPools, 30000);
  }
}
$('poolRows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-pool]'); if (tr) selectPool(tr.dataset.pool, true); });
$('poolRows').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-pool]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectPool(tr.dataset.pool, true); } });
setInterval(loadPools, 120000);
$('poolsMore').onclick = () => { showAllPools = true; loadPools(); };

/* ------------------------------------------------------------------ portfolio */
const sym = (t, fallback) => (t && typeof t === 'object' ? t.symbol : t ? short(t) : fallback);
async function loadPortfolio() {
  const el = $('pf');
  if (!account) {
    el.innerHTML = `<div class="empty">Connect a wallet to see your ladders. <button class="btn" type="button" id="pfConnect">Connect wallet</button></div>`;
    $('pfConnect').onclick = () => connect().catch((e) => toast(e.message));
    return;
  }
  el.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
  try {
    const list = await api(`/ladders?owner=${account}`);
    if (!list.length) {
      el.innerHTML = `<div class="empty">No ladders for ${esc(short(account))} yet. Plan one at the <a href="#agent">top of the page</a>.</div>`;
      return;
    }
    el.innerHTML = `<div class="cards">${list.map(ladderCard).join('')}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty err">Could not load ladders: ${esc(e.message)}</div>`;
  }
}
function ladderCard(l) {
  const s0 = sym(l.token0, 'token0'), s1 = sym(l.token1, 'token1');
  const n = l.bins.length;
  return `<article class="card" data-ladder="${esc(l.id)}">
    <div class="card-head"><h3>${esc(l.pair)} <span class="mono small muted">#${esc(l.id)}</span></h3><span class="pill ${l.inRangeBins ? 'in' : 'out'}">${l.inRangeBins}/${n} in range</span></div>
    <div class="range-line small">Unclaimed fees: <b>${num(Number(l.unclaimed0Human) || 0)}</b> ${esc(s0)} + <b>${num(Number(l.unclaimed1Human) || 0)}</b> ${esc(s1)}<br><span class="muted">${(l.fee / 10000).toFixed(2)}% pool · prices in ${esc(s1)} per ${esc(s0)} · 5% of the ETH side of claimed fees goes to $RUNGS stakers</span></div>
    <div class="bins">${l.bins
      .map((b, i) => `<label class="bin ${b.inRange ? 'in' : 'out'}"><input type="checkbox" data-idx="${i}" aria-label="Select bin ${i + 1}"><span>${num(b.priceLower)} – ${num(b.priceUpper)}</span><span class="muted">${b.inRange ? 'in' : 'out'}</span></label>`)
      .join('')}</div>
    <div class="actions">
      <button class="btn" type="button" data-act="claim">Claim fees</button>
      <button class="btn" type="button" data-act="withdraw">Withdraw selected</button>
      <button class="btn btn-ghost" type="button" data-act="close">Close ladder</button>
    </div>
    <div class="status"></div>
  </article>`;
}
$('pf').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const card = b.closest('[data-ladder]');
  const st = (m, cls = '') => { const s = card.querySelector('.status'); s.className = 'status ' + cls; s.innerHTML = m; };
  if (!cfg?.ladderManager) return st('LadderManager not deployed yet.', 'err');
  const id = BigInt(card.dataset.ladder);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const to = account;
  if (!to) return st('Connect the owner wallet first.', 'err');
  let fn, args;
  // min0/min1 = 0: no on-chain estimate here; the contract still checks ownership and deadline
  if (b.dataset.act === 'claim') { fn = 'claim'; args = [id, to, false]; }
  else if (b.dataset.act === 'close') {
    if (!confirm('Close this ladder? All bins are withdrawn to your wallet with their fees.')) return;
    fn = 'close'; args = [id, to, false, 0n, 0n, deadline];
  } else {
    const idx = [...card.querySelectorAll('input[data-idx]:checked')].map((x) => Number(x.dataset.idx)).sort((a, c) => c - a);
    if (!idx.length) return st('Select one or more bins first.');
    fn = 'withdraw'; args = [id, idx.map(BigInt), to, false, 0n, 0n, deadline];
  }
  card.querySelectorAll('button').forEach((x) => (x.disabled = true));
  const w = await import('./wallet.js');
  try {
    const hash = await w.write(cfg.ladderManager, w.ladderAbi, fn, args, (m) => st(esc(m)));
    st(`Done. <a href="${w.explorerTx(hash)}" target="_blank" rel="noopener">View on Blockscout</a>`, 'sodium');
    // bins are reordered on-chain after a withdraw (swap-and-pop), so always re-fetch
    setTimeout(loadPortfolio, 2500);
  } catch (err) {
    st(esc(w.niceError(err)), 'err');
    card.querySelectorAll('button').forEach((x) => (x.disabled = false));
  }
});
$('pfRefresh').onclick = loadPortfolio;

/* ------------------------------------------------------------------ scoreboard */
async function loadScoreboard() {
  const el = $('sb');
  try {
    const s = await api('/scoreboard');
    const plans = s.plans || [];
    const stats = `<div class="stats">
      <div class="stat"><b>${s.hitRate == null ? '—' : pct(s.hitRate, 0)}</b><span>Hit rate (price stayed inside)</span></div>
      <div class="stat"><b>${s.settled ?? 0}</b><span>Calls settled</span></div>
      <div class="stat"><b>${s.live ?? 0}</b><span>Calls running now</span></div></div>`;
    const note = !s.settled ? `<div class="empty" style="margin-bottom:18px">No call has settled yet. First results 24h after the first call.</div>` : '';
    const rows = plans.length
      ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Pair</th><th>Shape</th><th>Called</th><th class="num">Price at call</th><th class="num">Range</th><th class="num">Time inside</th><th>Result</th></tr></thead><tbody>${plans
          .map((p) => {
            const d = (x) => (p.invert && x ? 1 / x : x);
            const lo = Math.min(d(p.priceLower), d(p.priceUpper)), hi = Math.max(d(p.priceLower), d(p.priceUpper));
            return `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.pair)}</td><td>${esc(SHAPE[p.shape] || p.shape)}</td><td class="mono small">${utc(p.createdAt)}</td>
            <td class="num">${num(d(p.priceAtPlan))}</td><td class="num">${num(lo)} – ${num(hi)}</td><td class="num">${p.timeInRange == null ? '—' : pct(p.timeInRange, 0)}</td>
            <td><span class="pill ${esc(p.status)}">${p.status === 'in' ? 'stayed in' : p.status === 'out' ? 'left range' : 'live'}</span>${p.settledAt ? ` <span class="mono small muted">${utc(p.settledAt)}</span>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : `<div class="empty">The agent has not made a public call yet. It plans the top pools every 6 hours.</div>`;
    el.innerHTML = stats + note + rows;
  } catch (e) {
    el.innerHTML = `<div class="empty err">Could not load the track record: ${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ stake */
async function loadStake() {
  const el = $('stakeCard');
  if (cfg && cfg.feeBps != null) $('feePct').textContent = `${cfg.feeBps / 100}%`;
  if (!cfg || cfg.error) { el.innerHTML = `<div class="empty err">Contract config unavailable right now. Reload to retry.</div>`; return; }
  if (!cfg.stake) {
    el.innerHTML = `<div class="card-head"><h3>StaggerStake</h3><span class="pill">not deployed yet</span></div>
      <p class="muted">The stake contract is not deployed yet, so there is nothing to stake into. When it is, this card reads the totals from the contract and lets you stake, unstake and claim from your wallet. <span class="mono small">$RUNGS</span> exists from 15:00 UTC.</p>
      <a class="btn" href="/token/">About $RUNGS</a>`;
    return;
  }
  try {
    const s = await api(`/stake${account ? `?user=${account}` : ''}`);
    const perDay = s.rewardRate != null ? (Number(BigInt(s.rewardRate) * 86400n / 10n ** 18n) / 1e18) : null;
    const ends = s.periodFinish ? new Date(Number(s.periodFinish) * 1000).toISOString() : null;
    el.innerHTML = `<div class="card-head"><h3>StaggerStake</h3><a class="mono small" href="${esc(cfg.explorer || 'https://robinhoodchain.blockscout.com')}/address/${esc(cfg.stake)}" target="_blank" rel="noopener">${esc(short(cfg.stake))}</a></div>
      <div class="kpis">
        <div class="kpi"><span>Total staked</span><b>${units(s.totalStaked, 18, 4)}</b></div>
        <div class="kpi"><span>ETH / day now</span><b>${perDay == null ? '—' : num(perDay, 4)}</b></div>
        <div class="kpi"><span>Waiting to stream</span><b>${units(s.unstreamed ?? '0', 18, 4)}</b></div>
      </div>
      <div class="source">Stream ends ${ends && Number(s.periodFinish) * 1000 > Date.now() ? utc(ends) : '— (no active stream)'} · read from the contract</div>
      ${account ? `<div class="range-line">You stake <b>${units(s.balance ?? '0', 18, 6)}</b> RUNGS · claimable <b class="sodium">${units(s.earned ?? '0', 18, 6)}</b> ETH</div>` : ''}
      <label class="field"><span>Amount of RUNGS</span><input type="number" id="stAmt" min="0" step="any" placeholder="0" /></label>
      <div class="actions">
        <button class="btn btn-primary" type="button" data-st="stake">Stake</button>
        <button class="btn" type="button" data-st="unstake">Unstake</button>
        <button class="btn" type="button" data-st="claim">Claim ETH</button>
      </div>
      <div class="status" id="stStatus"></div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty err">Could not read the stake contract: ${esc(e.message)}</div>`;
  }
}
$('stakeCard').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-st]');
  if (!b) return;
  const st = (m, cls = '') => { const s = $('stStatus'); s.className = 'status ' + cls; s.innerHTML = m; };
  const w = await import('./wallet.js');
  const { parseUnits } = await import('viem');
  const btns = $('stakeCard').querySelectorAll('button');
  btns.forEach((x) => (x.disabled = true));
  try {
    let hash;
    if (b.dataset.st === 'claim') hash = await w.write(cfg.stake, w.stakeAbi, 'claim', [], (m) => st(esc(m)));
    else {
      const v = $('stAmt').value;
      if (!v || Number(v) <= 0) throw new Error('Enter an amount of RUNGS.');
      const amt = parseUnits(v, 18);
      if (b.dataset.st === 'stake') {
        const pub = await w.publicClient();
        const rungs = await pub.readContract({ address: cfg.stake, abi: w.stakeAbi, functionName: 'rungs' });
        if (/^0x0+$/.test(rungs)) throw new Error('$RUNGS is not set on the stake contract yet.');
        await w.ensureAllowance(rungs, cfg.stake, amt, 'RUNGS', (m) => st(esc(m)));
      }
      hash = await w.write(cfg.stake, w.stakeAbi, b.dataset.st, [amt], (m) => st(esc(m)));
    }
    st(`Done. <a href="${w.explorerTx(hash)}" target="_blank" rel="noopener">View on Blockscout</a>`, 'sodium');
    setTimeout(loadStake, 2500);
  } catch (err) {
    st(esc(w.niceError(err)), 'err');
  } finally {
    btns.forEach((x) => (x.disabled = false));
  }
});

/* ------------------------------------------------------------------ boot */
onAccount(() => { loadPortfolio(); if (cfg?.stake) loadStake(); if (plan) renderPlan(); });
loadPools();
getConfig()
  .then((c) => { cfg = c; if (plan) renderPlan(); })
  .catch(() => { cfg = { error: true }; if (plan) renderPlan(); })
  .finally(loadStake);
loadScoreboard();
loadPortfolio();
