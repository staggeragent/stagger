import { initShell } from './shell.js';
import { api, getConfig } from './api.js';
import { esc } from './fmt.js';

initShell();
api('/token')
  .then((t) => { if (t.ca) document.getElementById('caText').innerHTML = `<a href="https://robinhoodchain.blockscout.com/token/${esc(t.ca)}" target="_blank" rel="noopener">${esc(t.ca)}</a>`; })
  .catch(() => {});
getConfig().then((c) => { if (c.feeBps != null) document.getElementById('feeTxt').textContent = `${c.feeBps / 100}%`; }).catch(() => {});
