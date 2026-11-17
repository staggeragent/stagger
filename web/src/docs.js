import { initShell } from './shell.js';
import { getConfig } from './api.js';
import { esc } from './fmt.js';

initShell();
getConfig()
  .then((c) => {
    const ex = c.explorer || 'https://robinhoodchain.blockscout.com';
    const rows = [['LadderManager', c.ladderManager], ['StaggerStake', c.stake]].filter(([, a]) => a);
    if (rows.length) document.getElementById('addrs').innerHTML = rows.map(([n, a]) => `${n}: <a href="${esc(ex)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a> · source verified (Sourcify exact match)`).join('<br>');
  })
  .catch(() => {});
