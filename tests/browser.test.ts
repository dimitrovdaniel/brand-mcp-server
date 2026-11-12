/** Phase 4 checks in a real headless Chromium (Playwright + axe-core). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser, assertUrlAllowed } from '../src/checks/browser.js';
import { badAd, badPage, goodAd, goodPage } from './fixtures.js';
import { connect, rules } from './helpers.js';

let s: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  s = await connect();
});
afterAll(async () => {
  await s.close();
  await closeBrowser();
});

describe('check_ad with HTML5 creative', () => {
  it('approves a compliant medium rectangle and returns a screenshot', async () => {
    const r = await s.call('check_ad', { brand: 'haferglueck', slot: 'medium-rectangle', html: goodAd, screenshot: true });
    expect(r.data.findings.filter((f: any) => f.severity === 'error')).toEqual([]);
    expect((r.raw.content as any[]).some(c => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
  });

  it('finds every problem in a broken one', async () => {
    const r = await s.call('check_ad', { brand: 'haferglueck', slot: 'medium-rectangle', html: badAd });
    expect(r.data.passed).toBe(false);
    expect(rules(r.data)).toEqual(
      expect.arrayContaining(['ad.safe-zone', 'logo.size', 'ad.logo-placement', 'ad.cta', 'ad.background', 'copy.forbidden-term', 'copy.address-form', 'page.off-brand-font', 'a11y.color-contrast']),
    );
  });
});

describe('check_page', () => {
  it('passes a clean page on desktop and mobile', async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const r = await s.call('check_page', { brand: 'haferglueck', html: goodPage, viewport });
      expect(r.data.findings.filter((f: any) => f.severity === 'error'), JSON.stringify(viewport)).toEqual([]);
    }
  });

  it('reports accessibility, palette, font, size, tap-target and overflow problems', async () => {
    const r = await s.call('check_page', { brand: 'haferglueck', html: badPage, viewport: { width: 390, height: 844 } });
    expect(rules(r.data)).toEqual(
      expect.arrayContaining(['a11y.html-has-lang', 'a11y.image-alt', 'a11y.color-contrast', 'page.off-palette-color', 'page.off-brand-font', 'page.font-size', 'page.tap-target', 'page.horizontal-overflow']),
    );
  });

  it('refuses URLs that are not allow-listed', async () => {
    const r = await s.call('check_page', { brand: 'haferglueck', url: 'https://169.254.169.254/latest/meta-data' });
    expect(r.isError).toBe(true);
    expect(() => assertUrlAllowed('http://example.com')).toThrow(/https/);
  });
});

describe('check_visual', () => {
  it('measures palette coverage and returns the screenshot', async () => {
    const good = await s.call('check_visual', { brand: 'haferglueck', html: goodPage });
    expect(good.data.paletteCoverage).toBeGreaterThan(0.9);
    expect(good.data.dominantColors[0]).toMatchObject({ hex: '#FBF7EF', nearestToken: expect.stringContaining('oat') });
    const bad = await s.call('check_visual', { brand: 'haferglueck', html: badPage.replace('#ffffff', '#00ff00') });
    expect(rules(bad.data)).toContain('visual.palette-coverage');
  });
});
