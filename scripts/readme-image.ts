/** Renders docs/check-ad.png for the README: a compliant and a broken ad side by side with the real check_ad findings. */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { closeBrowser } from '../src/checks/browser.js';
import { connect } from '../tests/helpers.js';
import { badAd, goodAd } from '../tests/fixtures.js';

const s = await connect();
const run = async (html: string) => (await s.call('check_ad', { brand: 'haferglueck', slot: 'medium-rectangle', html })).data;
const good = await run(goodAd), bad = await run(badAd);
await s.close();
await closeBrowser();

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const col = (title: string, html: string, r: any) => `
  <section><h2>${title}</h2>
  <iframe srcdoc="${esc(html)}" width="300" height="250"></iframe>
  <div class="verdict ${r.passed ? 'ok' : 'no'}">${r.passed ? 'passed' : `${r.errors} errors · ${r.warnings} warning${r.warnings === 1 ? '' : 's'}`}</div>
  <ul>${r.findings.filter((f: any) => f.severity !== 'info').slice(0, 9).map((f: any) => `<li><code class="${f.severity}">${f.rule}</code> ${esc(f.message.length > 95 ? f.message.slice(0, 92) + '…' : f.message)}</li>`).join('') || '<li class="none">No findings</li>'}</ul>
  </section>`;
const page = `<!doctype html><html><head><style>
body{margin:0;padding:28px;font:14px/1.45 -apple-system,Segoe UI,Arial,sans-serif;background:#f6f8fa;color:#1f2328;width:1100px}
h1{font-size:18px;margin:0 0 4px} p.sub{margin:0 0 20px;color:#57606a}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
section{background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:18px}
h2{font-size:15px;margin:0 0 12px} iframe{border:1px dashed #d0d7de;display:block}
.verdict{margin:12px 0 6px;font-weight:600}.ok{color:#1a7f37}.no{color:#cf222e}
ul{margin:0;padding-left:18px} li{margin:3px 0} code{font-size:12px;padding:1px 5px;border-radius:4px;background:#eef1f4}
code.error{background:#ffebe9;color:#a40e26} code.warning{background:#fff8c5;color:#7d4e00} .none{color:#57606a;list-style:none;margin-left:-18px}
</style></head><body><h1>check_ad · Haferglück · medium rectangle 300×250</h1>
<p class="sub">Output of the check_ad tool: the HTML5 creative is rendered in headless Chromium and checked against the slot spec, brand rules, axe-core and the copy rules.</p>
<div class="grid">${col('Compliant creative', goodAd, good)}${col('Broken creative', badAd, bad)}</div></body></html>`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1156, height: 400 }, deviceScaleFactor: 2 });
await p.setContent(page, { waitUntil: 'load' });
await p.screenshot({ path: 'docs/check-ad.png', fullPage: true });
await b.close();
console.log('docs/check-ad.png');
