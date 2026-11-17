// Renders public/poster.webp from the live three.js scene (needs `npm run dev` on :5262).
// Headless Chrome opens /poster.html, which renders the hero once and POSTs the image to this local receiver.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = resolve(import.meta.dirname, '../public/poster.webp');
let chrome;
const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method !== 'POST') return res.end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.end('ok');
    const m = body.match(/^data:image\/webp;base64,(.+)$/);
    if (!m) { console.error('bad payload'); process.exit(1); }
    writeFileSync(out, Buffer.from(m[1], 'base64'));
    console.log('wrote', out);
    chrome?.kill();
    server.close();
    process.exit(0);
  });
});
server.listen(5299, '127.0.0.1', () => {
  chrome = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,1300', '--force-device-scale-factor=1', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'stagger-poster-'))}`, '--remote-debugging-port=0', 'http://localhost:5262/poster.html'], { stdio: 'ignore' });
});
setTimeout(() => { console.error('timeout'); chrome?.kill(); process.exit(1); }, 120000);
