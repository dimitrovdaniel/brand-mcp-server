/**
 * Headless Chromium for the layout, visual and ad checks.
 *
 * - Local / Docker: launches Playwright's Chromium.
 * - Serverless (Vercel, Workers): set BROWSER_WS_ENDPOINT (Playwright server) or BROWSER_CDP_ENDPOINT
 *   (any CDP browser service) and the checks connect to it instead.
 *
 * Network: rendered HTML may only load data:/blob: URLs and the hosts in BRAND_CHECK_ASSET_HOSTS
 * (default: Google Fonts). Checking a live URL requires its host in BRAND_CHECK_URL_HOSTS. Everything
 * else is blocked, so a check can never be used to reach internal services.
 */
import type { Browser, Page } from 'playwright';

let browserPromise: Promise<Browser> | undefined;

async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright');
  if (process.env.BROWSER_WS_ENDPOINT) return chromium.connect(process.env.BROWSER_WS_ENDPOINT);
  if (process.env.BROWSER_CDP_ENDPOINT) return chromium.connectOverCDP(process.env.BROWSER_CDP_ENDPOINT);
  return chromium.launch({ headless: true });
}

export async function getBrowser(): Promise<Browser> {
  browserPromise ??= launch().catch(err => {
    browserPromise = undefined;
    throw new BrowserUnavailable(err);
  });
  return browserPromise;
}

export class BrowserUnavailable extends Error {
  constructor(cause: unknown) {
    super(
      'The headless browser is not available on this deployment, so layout/visual checks cannot run. ' +
        'Install it with `npx playwright install chromium`, or set BROWSER_WS_ENDPOINT / BROWSER_CDP_ENDPOINT. ' +
        `(${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`,
    );
  }
}

export async function closeBrowser() {
  const p = browserPromise;
  browserPromise = undefined;
  if (p) await (await p.catch(() => undefined))?.close();
}

const list = (v: string | undefined, dflt: string) => (v ?? dflt).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
export const assetHosts = () => list(process.env.BRAND_CHECK_ASSET_HOSTS, 'fonts.googleapis.com,fonts.gstatic.com');
export const urlHosts = () => list(process.env.BRAND_CHECK_URL_HOSTS, '');

export class UrlNotAllowed extends Error {}

export function assertUrlAllowed(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UrlNotAllowed(`Not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new UrlNotAllowed('Only https:// URLs can be checked.');
  if (!urlHosts().includes(u.hostname.toLowerCase()))
    throw new UrlNotAllowed(`${u.hostname} is not in BRAND_CHECK_URL_HOSTS. Pass the HTML instead, or ask an admin to allow the host.`);
}

export interface RenderTarget {
  html?: string;
  url?: string;
  width: number;
  height: number;
}

/** Opens a fresh, isolated page for one check and always closes it. */
export async function withPage<T>(target: RenderTarget, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: 'block' });
  const allowed = new Set([...assetHosts(), ...(target.url ? [new URL(target.url).hostname.toLowerCase()] : [])]);
  await context.route('**/*', route => {
    const u = route.request().url();
    if (/^(data|blob|about):/.test(u)) return route.continue();
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' && allowed.has(url.hostname.toLowerCase())) return route.continue();
    } catch {
      /* fall through */
    }
    return route.abort('blockedbyclient');
  });
  // esbuild/tsx wrap functions with a __name() helper; give functions passed to page.evaluate one to call
  await context.addInitScript('globalThis.__name = globalThis.__name || ((f) => f);');
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    if (target.url) {
      assertUrlAllowed(target.url);
      await page.goto(target.url, { waitUntil: 'load' });
    } else {
      await page.setContent(target.html ?? '', { waitUntil: 'load' });
    }
    await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
    return await fn(page);
  } finally {
    await context.close();
  }
}
