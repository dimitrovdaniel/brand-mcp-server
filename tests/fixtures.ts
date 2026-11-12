/** HTML fixtures shared by the browser tests and the eval cases. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const logoSvg = fs.readFileSync(fileURLToPath(new URL('../brands/haferglueck/logos/primary.svg', import.meta.url)), 'utf8');
const logo = (w: number) =>
  `<img data-brand-logo alt="Haferglück" width="${w}" height="${Math.round(w / 3.75)}" src="data:image/svg+xml,${encodeURIComponent(logoSvg)}">`;

export const goodAd = `<!doctype html><html lang="de"><head><title>Anzeige</title></head><body style="margin:0">
<div style="box-sizing:border-box;width:300px;height:250px;position:relative;background:#FBF7EF;border:1px solid #E3D3B4;font-family:Inter">
  <div style="position:absolute;left:12px;top:12px">${logo(80)}</div>
  <h1 style="position:absolute;left:12px;top:64px;margin:0;font-family:Fraunces;font-size:28px;line-height:1.1;color:#1F4D3A">Hafer aus Bayern.<br>Ein guter Morgen.</h1>
  <a href="#" style="position:absolute;left:12px;bottom:12px;display:inline-block;padding:12px 18px;background:#1F4D3A;color:#FFFFFF;border-radius:999px;font-size:16px;text-decoration:none">Jetzt probieren</a>
</div></body></html>`;

export const badAd = `<!doctype html><html lang="de"><head><title>Anzeige</title></head><body style="margin:0">
<div style="box-sizing:border-box;width:300px;height:250px;position:relative;background:#FFFFFF;font-family:Arial">
  <div style="position:absolute;right:4px;top:4px">${logo(40)}</div>
  <h1 style="position:absolute;left:2px;top:70px;margin:0;font-size:26px;color:#F2B33D">Die gesunde Hafermilch für Sie!!</h1>
</div></body></html>`;

export const goodPage = `<!doctype html><html lang="de"><head><title>Haferglück</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#FBF7EF;color:#1B1B18;font-family:Inter;font-size:16px">
<header style="padding:24px">${logo(120)}</header>
<main style="padding:0 24px 48px;max-width:70ch">
  <h1 style="font-family:Fraunces;font-size:40px;color:#1F4D3A">Hafer aus Bayern</h1>
  <p>Vier Zutaten, 120 km vom Feld bis zur Flasche. Dein Frühstück hat einen neuen besten Freund.</p>
  <a href="#" style="display:inline-block;min-height:44px;line-height:44px;padding:0 24px;background:#1F4D3A;color:#FFFFFF;border-radius:999px;text-decoration:none">Jetzt probieren</a>
</main>
<footer style="background:#1F4D3A;color:#FFFFFF;padding:24px"><p style="margin:0">Haferglück aus Bayern</p></footer>
</body></html>`;

export const badPage = `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Roboto">
<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" width="60" height="16">
<h1 style="color:#F2B33D">Willkommen</h1><p style="font-size:11px;color:#bbbbbb">Kleingedrucktes</p>
<a href="#" style="font-size:12px">mehr</a><div style="width:1400px;height:20px;background:#ff00aa"></div></body></html>`;
