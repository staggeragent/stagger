// Renders public/og.png (1200x630), favicon-32.png and apple-touch-icon.png with headless Chrome.
// Uses public/poster.webp (render it first with `npm run poster`). Decorative, no data values.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const fs = (p) => 'file://' + resolve(root, 'node_modules/@fontsource', p);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = mkdtempSync(join(tmpdir(), 'stagger-og-'));

const poster = 'file://' + resolve(root, 'public/poster.webp');
const ticks = Array.from({ length: 19 }, (_, i) => `<i style="top:${(i / 18) * 100}%;width:${i % 3 === 0 ? 18 : 8}px"></i>`).join('');
const og = `<!doctype html><html><head><style>
@font-face{font-family:HG;src:url(${fs('host-grotesk/files/host-grotesk-latin-800-normal.woff2')})}
@font-face{font-family:CG;font-style:italic;src:url(${fs('cormorant-garamond/files/cormorant-garamond-latin-500-italic.woff2')})}
@font-face{font-family:OM;src:url(${fs('overpass-mono/files/overpass-mono-latin-600-normal.woff2')})}
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:radial-gradient(45% 70% at 72% 55%,rgba(255,207,63,.09),rgba(255,255,255,.025) 45%,transparent 75%),#0a0a0b;color:#f2f1ec;position:relative}
.k{position:absolute;left:60px;top:52px;font:600 15px OM;letter-spacing:.16em;color:#9a9993;text-transform:uppercase}
.w{position:absolute;left:60px;top:84px;font:800 34px HG;letter-spacing:-.04em}
h1{position:absolute;left:56px;bottom:112px;margin:0;font:800 92px/0.92 HG;letter-spacing:-.04em;text-transform:uppercase;white-space:nowrap;z-index:2}
h1 em{font-family:CG;font-style:italic;font-weight:500;text-transform:none;color:#ffcf3f;font-size:1.14em;letter-spacing:-.01em}
.b{position:absolute;left:60px;bottom:54px;font:600 20px OM;z-index:2}
.b span{color:#ffcf3f}
img{position:absolute;right:40px;top:-40px;height:820px;width:auto}
.r{position:absolute;right:30px;top:110px;height:380px;width:2px;border-right:1px solid rgba(255,255,255,.25)}
.r i{position:absolute;right:0;height:1px;background:rgba(242,241,236,.7)}
.r b{position:absolute;right:0;top:84%;width:30px;height:3px;background:#ffcf3f;box-shadow:0 0 14px rgba(255,207,63,.8)}
</style></head><body>
<img src="${poster}">
<div class="r">${ticks}<b></b></div>
<div class="k">Range agent · Uniswap v3 · Robinhood Chain</div>
<div class="w">stagger</div>
<h1>The agent<br>picks the <em>rungs.</em></h1>
<div class="b"><span>$RUNGS</span> · Robinhood Chain · staggeragent.xyz</div>
</body></html>`;

const icon = (size) => `<!doctype html><html><head><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#0a0a0b}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><rect width="32" height="32" fill="#0a0a0b"/><g fill="#d9dde3"><rect x="5" y="17" width="4" height="9"/><rect x="11" y="11" width="4" height="15"/><rect x="17" y="6" width="4" height="20"/><rect x="23" y="13" width="4" height="13"/></g><path d="M3 21.5h26" stroke="#ffcf3f" stroke-width="1.8"/></svg></body></html>`;

function shot(html, out, w, h) {
  const f = join(tmp, out + '.html');
  writeFileSync(f, html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${w},${h}`, `--screenshot=${resolve(root, 'public', out)}`, '--virtual-time-budget=1500', 'file://' + f], { stdio: 'ignore' });
  console.log('wrote public/' + out);
}
shot(og, 'og.png', 1200, 630);
shot(icon(32), 'favicon-32.png', 32, 32);
shot(icon(180), 'apple-touch-icon.png', 180, 180);
