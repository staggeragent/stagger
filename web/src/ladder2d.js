// Static SVG version of the ladder: the bins chart in the panel, and the hero fallback
// for phones / reduced motion / no WebGL. Same data as the 3D scene.
import { num } from './fmt.js';

export function ladderSvg(vm, { w = 400, h = 120, hero = false, topPad, bottomPad } = {}) {
  if (!vm || !vm.bins.length) return '';
  const padX = hero ? 24 : 4;
  const top = topPad ?? (hero ? h * 0.36 : 14);
  const bottom = h - (bottomPad ?? (hero ? 150 : 18));
  const [dLo, dHi] = vm.domain;
  const l0 = Math.log(dLo), l1 = Math.log(dHi);
  const x = (p) => padX + ((Math.log(p) - l0) / (l1 - l0)) * (w - 2 * padX);
  const maxW = Math.max(...vm.bins.map((b) => b.weight), 1e-12);
  const hh = bottom - top;
  const stag = 0;
  let out = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Liquidity per bin across the price range, with the current price marked">`;
  // range band
  const r0 = x(vm.range[0]), r1 = x(vm.range[1]);
  out += `<rect x="${r0}" y="${top - 6}" width="${Math.max(1, r1 - r0)}" height="${hh + 6}" fill="rgba(255,255,255,.05)" stroke="rgba(241,245,250,.35)" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`;
  // history trail (hero only)
  if (hero && vm.history.length > 2) {
    const hs = vm.history.slice(-96);
    const yTop = 20, yBot = top - 14;
    const pts = hs.map((p, i) => `${Math.min(w - 2, Math.max(2, x(p))).toFixed(1)},${(yTop + (i / (hs.length - 1)) * (yBot - yTop)).toFixed(1)}`).join(' ');
    out += `<polyline points="${pts}" fill="none" stroke="#ffcf3f" stroke-opacity=".5" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  }
  vm.bins.forEach((b, i) => {
    const x0 = x(b.lo), x1 = x(b.hi);
    const bw = Math.max(1, (x1 - x0) * 0.82);
    const bh = Math.max(1.5, (b.weight / maxW) * hh);
    const dy = vm.bins.length > 1 ? ((i % 3) - 1) * stag : 0;
    const bx = (x0 + x1) / 2 - bw / 2;
    const by = bottom - bh + dy;
    const fill = b.live ? 'rgba(255,207,63,.28)' : 'rgba(242,241,236,.12)';
    out += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" fill="${fill}" stroke="#f1f5fa" stroke-opacity=".85" vector-effect="non-scaling-stroke"/>`;
    out += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="2.5" fill="${b.live ? '#ffcf3f' : '#f1f5fa'}"/>`;
  });
  // axis + price
  out += `<line x1="0" x2="${w}" y1="${bottom + 0.5}" y2="${bottom + 0.5}" stroke="rgba(241,245,250,.4)" vector-effect="non-scaling-stroke"/>`;
  const px = Math.min(w - 1, Math.max(1, x(vm.price)));
  out += `<line x1="${px}" x2="${px}" y1="${top - 12}" y2="${bottom + 4}" stroke="#ffcf3f" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  out += `</svg>`;
  return out;
}

/** labels under the compact chart */
export function axisLabels(vm) {
  return `<div class="mono small muted" style="display:flex;justify-content:space-between;gap:8px"><span>${num(vm.range[0])}</span><span class="sodium">now ${num(vm.price)}</span><span>${num(vm.range[1])}</span></div>`;
}
