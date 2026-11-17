import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Shared head/header/footer partials injected into every page.
const read = (p) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
const partials = {
  name: 'stagger-partials',
  transformIndexHtml(html, ctx) {
    const path = '/' + (ctx.path || '/').replace(/^\//, '').replace(/index\.html$/, '');
    const cur = (href) => (path === href ? ' aria-current="page"' : '');
    const header = read('partials/header.html').replace(/__CUR_([a-z]+)__/g, (_, k) => cur(k === 'home' ? '/' : `/${k}/`));
    return html
      .replace('<!--HEAD-->', read('partials/head.html'))
      .replace('<!--HEADER-->', header)
      .replace('<!--FOOTER-->', read('partials/footer.html'));
  },
};

const pages = ['index', 'token/index', 'docs/index', '404'];

export default defineConfig({
  appType: 'mpa',
  plugins: [partials],
  server: {
    port: 5262,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4252', changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p.replace('/index', '') || 'index', resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
});
