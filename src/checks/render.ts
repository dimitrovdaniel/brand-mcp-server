/** Browser-based checks: page layout + accessibility, visual palette coverage, and rendered HTML5 ads. */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { colorTokens, isPrimitive } from '../data.js';
import { deltaE, parseColor, toHex, type Rgba } from '../lib/color.js';
import type { AdSlot, BrandBundle } from '../types.js';
import { withPage } from './browser.js';
import { checkCopy } from './copy.js';
import type { Finding } from './finding.js';

interface El {
  sel: string;
  tag: string;
  text: string;
  color: string;
  bg: string;
  borders: string[];
  font: string;
  size: number;
  x: number;
  y: number;
  w: number;
  h: number;
  interactive: boolean;
  logo: boolean;
  cta: boolean;
}

/** Runs in the page: one record per visible element. */
function collect(brandName: string): { els: El[]; scrollW: number; scrollH: number; vw: number; vh: number } {
  const out: El[] = [];
  const short = (e: Element): string => {
    if (e.id) return `#${e.id}`;
    const cls = [...e.classList].slice(0, 2).map(c => `.${c}`).join('');
    const parent = e.parentElement && e.parentElement !== document.body ? short(e.parentElement) + ' > ' : '';
    return (parent + e.tagName.toLowerCase() + cls).slice(-120);
  };
  for (const e of Array.from(document.body.querySelectorAll('*'))) {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || r.width === 0 || r.height === 0) continue;
    const own = Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    const label = `${e.getAttribute('alt') ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.querySelector?.('title')?.textContent ?? ''}`;
    const tag = e.tagName.toLowerCase();
    out.push({
      sel: short(e),
      tag,
      text: own,
      color: cs.color,
      bg: cs.backgroundColor,
      borders: ['Top', 'Right', 'Bottom', 'Left'].filter(s => parseFloat((cs as any)[`border${s}Width`]) > 0 && (cs as any)[`border${s}Style`] !== 'none').map(s => (cs as any)[`border${s}Color`]),
      font: cs.fontFamily,
      size: parseFloat(cs.fontSize),
      x: r.left + scrollX,
      y: r.top + scrollY,
      w: r.width,
      h: r.height,
      interactive: e.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [tabindex]:not([tabindex="-1"])'),
      logo: e.hasAttribute('data-brand-logo') || ((tag === 'img' || tag === 'svg') && label.toLowerCase().includes(brandName.toLowerCase())),
      cta: e.hasAttribute('data-cta') || (e.matches('a[href], button') && own.length > 0),
    });
  }
  const se = document.scrollingElement ?? document.documentElement;
  return { els: out, scrollW: se.scrollWidth, scrollH: se.scrollHeight, vw: innerWidth, vh: innerHeight };
}

function palette(b: BrandBundle) {
  return colorTokens(b);
}

/** Groups used colours that are not brand tokens. */
function colorFindings(b: BrandBundle, els: El[]): Finding[] {
  const pal = palette(b);
  const uses = new Map<string, { rgba: Rgba; where: Set<string>; roles: Set<string> }>();
  const add = (css: string, role: string, sel: string) => {
    const c = parseColor(css);
    if (!c || c.a === 0) return;
    const key = toHex(c) + (c.a < 1 ? `@${c.a.toFixed(2)}` : '');
    const u = uses.get(key) ?? { rgba: c, where: new Set(), roles: new Set() };
    u.where.add(sel);
    u.roles.add(role);
    uses.set(key, u);
  };
  for (const e of els) {
    if (e.text) add(e.color, 'text', e.sel);
    add(e.bg, 'background', e.sel);
    for (const bc of e.borders) add(bc, 'border', e.sel);
  }
  const out: Finding[] = [];
  for (const [key, u] of uses) {
    if (u.rgba.a < 1) continue; // translucent overlays are judged by contrast, not palette
    const nearest = pal.map(p => ({ ...p, d: deltaE(u.rgba, p.rgba) })).sort((x, y) => x.d - y.d)[0];
    if (nearest && nearest.d < 0.5) continue;
    // suggest the closest semantic token made for that role (text → color.text.*, background → color.surface.* …)
    const rolePrefix = u.roles.has('text') ? ['color.text.', 'color.feedback.'] : u.roles.has('border') ? ['color.border.'] : ['color.surface.', 'color.action.', 'color.accent.'];
    const sem = pal
      .filter(p => !isPrimitive(p.token) && rolePrefix.some(r => p.token.path.startsWith(r)))
      .map(p => ({ t: p.token, d: deltaE(u.rgba, p.rgba) }))
      .sort((x, y) => x.d - y.d)[0]?.t;
    out.push({
      rule: 'page.off-palette-color',
      severity: nearest && nearest.d < 4 ? 'warning' : 'error',
      message: `${key} used as ${[...u.roles].join('/')} is not a ${b.meta.name} colour${nearest ? ` (nearest ${nearest.token.path} ${nearest.token.value}, ΔE ${nearest.d.toFixed(1)})` : ''}.`,
      where: [...u.where].slice(0, 3).join(', ') + (u.where.size > 3 ? ` +${u.where.size - 3} more` : ''),
      suggestion: sem ? `var(${sem.cssVar})` : undefined,
      source: `brand://${b.meta.id}/guidelines/color-and-type`,
    });
  }
  return out;
}

function typeFindings(b: BrandBundle, els: El[]): Finding[] {
  const out: Finding[] = [];
  const fams = Object.values(b.meta.fonts).map(f => f.family.toLowerCase());
  const bad = new Map<string, string[]>();
  for (const e of els.filter(e => e.text)) {
    const first = e.font.split(',')[0].trim().replace(/["']/g, '').toLowerCase();
    if (!fams.includes(first)) bad.set(first, [...(bad.get(first) ?? []), e.sel]);
  }
  for (const [fam, sels] of bad)
    out.push({ rule: 'page.off-brand-font', severity: 'error', message: `Text is set in “${fam}”, not a ${b.meta.name} typeface.`, where: sels.slice(0, 3).join(', ') + (sels.length > 3 ? ` +${sels.length - 3} more` : ''), suggestion: `var(--${b.meta.tokenPrefix}-font-family-body)`, source: `brand://${b.meta.id}/guidelines/color-and-type` });

  const min = b.meta.layout.minBodyFontPx;
  const tiny = els.filter(e => e.text && e.size < 12);
  if (tiny.length) out.push({ rule: 'page.font-size', severity: 'error', message: `${tiny.length} text element(s) below 12px.`, where: tiny.slice(0, 3).map(e => `${e.sel} (${e.size}px)`).join(', '), source: `brand://${b.meta.id}/guidelines/color-and-type` });
  const smallBody = els.filter(e => e.text && ['p', 'li', 'td', 'dd', 'blockquote'].includes(e.tag) && e.size >= 12 && e.size < min);
  if (smallBody.length) out.push({ rule: 'page.body-size', severity: 'warning', message: `${smallBody.length} body text element(s) below ${min}px.`, where: smallBody.slice(0, 3).map(e => `${e.sel} (${e.size}px)`).join(', '), suggestion: `var(--${b.meta.tokenPrefix}-font-size-md)` });
  const longLines = els.filter(e => e.tag === 'p' && e.text.length > 120 && e.w / (e.size * 0.5) > b.meta.layout.maxLineLengthCh * 1.15);
  if (longLines.length) out.push({ rule: 'page.line-length', severity: 'warning', message: `Paragraph lines are longer than about ${b.meta.layout.maxLineLengthCh} characters.`, where: longLines.slice(0, 3).map(e => e.sel).join(', '), suggestion: `max-width: ${b.meta.layout.maxLineLengthCh}ch` });
  return out;
}

async function axe(page: Page, only?: string[]): Promise<Finding[]> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (only) builder = builder.withRules(only);
  const res = await builder.analyze();
  return res.violations.map(v => ({
    rule: `a11y.${v.id}`,
    severity: v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning',
    message: `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`,
    where: v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', '),
    suggestion: v.nodes[0]?.failureSummary?.split('\n').slice(1, 2).join(' ').trim() || v.helpUrl,
  }));
}

function logoFindings(b: BrandBundle, els: El[], minWidth: number, required: boolean): Finding[] {
  const logos = els.filter(e => e.logo);
  const src = `brand://${b.meta.id}/guidelines/logo`;
  if (!logos.length) return required ? [{ rule: 'logo.missing', severity: 'error', message: 'No logo found. Mark it with data-brand-logo or give it alt text with the brand name.', source: src }] : [];
  return logos.filter(l => l.w < minWidth).map(l => ({ rule: 'logo.size', severity: 'error' as const, message: `Logo is ${Math.round(l.w)}px wide; minimum ${minWidth}px.`, where: l.sel, source: src }));
}

export interface PageCheckResult {
  findings: Finding[];
  stats: { elements: number; textElements: number; viewport: string; pageSize: string };
  screenshot?: string;
}

export async function checkPage(b: BrandBundle, target: { html?: string; url?: string }, viewport: { width: number; height: number }, screenshot: boolean): Promise<PageCheckResult> {
  return withPage({ ...target, ...viewport }, async page => {
    const data = await page.evaluate(collect, b.meta.name);
    const findings: Finding[] = [...(await axe(page)), ...colorFindings(b, data.els), ...typeFindings(b, data.els)];
    if (data.scrollW > data.vw + 1) findings.push({ rule: 'page.horizontal-overflow', severity: 'error', message: `Content is ${data.scrollW}px wide in a ${data.vw}px viewport (horizontal scrolling).` });
    const tap = b.meta.layout.minTapTargetPx;
    const small = data.els.filter(e => e.interactive && (e.w < tap || e.h < tap) && e.tag !== 'input');
    if (small.length) findings.push({ rule: 'page.tap-target', severity: 'warning', message: `${small.length} interactive element(s) smaller than ${tap}×${tap}px.`, where: small.slice(0, 3).map(e => `${e.sel} (${Math.round(e.w)}×${Math.round(e.h)})`).join(', '), source: `brand://${b.meta.id}/guidelines/imagery-and-layout` });
    findings.push(...logoFindings(b, data.els, Math.min(...b.meta.logos.map(l => l.minWidthPx)), false));
    const shot = screenshot ? (await page.screenshot({ type: 'png' })).toString('base64') : undefined;
    return {
      findings,
      stats: { elements: data.els.length, textElements: data.els.filter(e => e.text).length, viewport: `${data.vw}×${data.vh}`, pageSize: `${data.scrollW}×${data.scrollH}` },
      screenshot: shot,
    };
  });
}

export interface VisualResult {
  findings: Finding[];
  paletteCoverage: number;
  dominant: { hex: string; share: number; nearestToken?: string; deltaE: number }[];
  screenshot: string;
}

/** Share of rendered pixels that sit on the brand palette, the dominant colours, and the screenshot. */
export async function checkVisual(b: BrandBundle, target: { html?: string; url?: string }, viewport: { width: number; height: number }): Promise<VisualResult> {
  return withPage({ ...target, ...viewport }, async page => {
    const buf = await page.screenshot({ type: 'png' });
    const png = PNG.sync.read(buf);
    const pal = palette(b);
    // sample every 2nd pixel both ways; group by 5 bits per channel, keep the first exact colour as representative
    const buckets = new Map<number, { n: number; rgba: Rgba }>();
    let total = 0;
    for (let y = 0; y < png.height; y += 2)
      for (let x = 0; x < png.width; x += 2) {
        const i = (png.width * y + x) * 4;
        const key = ((png.data[i] >> 3) << 10) | ((png.data[i + 1] >> 3) << 5) | (png.data[i + 2] >> 3);
        const bucket = buckets.get(key);
        if (bucket) bucket.n++;
        else buckets.set(key, { n: 1, rgba: { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: 1 } });
        total++;
      }
    let onPalette = 0;
    const perToken = new Map<string, number>();
    const groups: { rgba: Rgba; n: number; nearest?: string; d: number }[] = [];
    for (const { n, rgba } of buckets.values()) {
      const near = pal.map(p => ({ p, d: deltaE(rgba, p.rgba) })).sort((x, y) => x.d - y.d)[0];
      if (near && near.d < 4) {
        onPalette += n;
        perToken.set(near.p.token.value, (perToken.get(near.p.token.value) ?? 0) + n);
      }
      groups.push({ rgba, n, nearest: near?.p.token.path, d: near?.d ?? 99 });
    }
    const coverage = Math.round((onPalette / total) * 1000) / 1000;
    const dominant = groups
      .sort((x, y) => y.n - x.n)
      .filter(g => g.n / total >= 0.002)
      .slice(0, 6)
      .map(g => ({ hex: toHex(g.rgba), share: Math.round((g.n / total) * 1000) / 1000, nearestToken: g.d < 4 ? g.nearest : undefined, deltaE: Math.round(g.d * 10) / 10 }));
    const findings: Finding[] = [];
    const src = `brand://${b.meta.id}/guidelines/color-and-type`;
    if (coverage < b.meta.visual.minPaletteCoverage)
      findings.push({ rule: 'visual.palette-coverage', severity: 'warning', message: `${Math.round(coverage * 100)}% of the pixels are brand colours; ${b.meta.name} aims for at least ${Math.round(b.meta.visual.minPaletteCoverage * 100)}% (photos lower this).`, source: src });
    for (const req of b.meta.visual.requiredColors) {
      const t = b.tokens.find(x => x.path === req)!;
      const share = (perToken.get(t.value) ?? 0) / total;
      if (share < 0.005) findings.push({ rule: 'visual.required-color', severity: 'warning', message: `${req} (${t.value}) is barely visible (${(share * 100).toFixed(1)}% of pixels).`, source: src });
    }
    return { findings, paletteCoverage: coverage, dominant, screenshot: buf.toString('base64') };
  });
}

export interface AdRenderResult {
  findings: Finding[];
  initialLoadKb: number;
  screenshot?: string;
}

/** Renders an HTML5 creative at the slot size and checks bounds, safe zone, logo, CTA, copy and contrast. */
export async function checkAdHtml(b: BrandBundle, slot: AdSlot, html: string, screenshot: boolean): Promise<AdRenderResult> {
  const brand = slot.brand!;
  const src = `brand://${b.meta.id}/rules/ad-slots`;
  const initialLoadKb = Math.round((new TextEncoder().encode(html).length / 1024) * 10) / 10;
  return withPage({ html, width: slot.width, height: slot.height }, async page => {
    await page.addStyleTag({ content: 'html,body{margin:0}' }).catch(() => undefined);
    const data = await page.evaluate(collect, b.meta.name);
    const f: Finding[] = [];
    if (slot.maxInitialLoadKb && initialLoadKb > slot.maxInitialLoadKb) f.push({ rule: 'ad.file-size', severity: 'error', message: `HTML is ${initialLoadKb} KB; initial load limit is ${slot.maxInitialLoadKb} KB.`, source: src });
    if (data.scrollW > slot.width + 1 || data.scrollH > slot.height + 1) f.push({ rule: 'ad.overflow', severity: 'error', message: `Content is ${data.scrollW}×${data.scrollH}px; the slot is ${slot.width}×${slot.height}px.`, source: src });
    const z = slot.safeZone;
    const outside = data.els.filter(e => e.text && (e.x < z.left - 0.5 || e.y < z.top - 0.5 || e.x + e.w > slot.width - z.right + 0.5 || e.y + e.h > slot.height - z.bottom + 0.5));
    if (outside.length) f.push({ rule: 'ad.safe-zone', severity: 'error', message: `${outside.length} text element(s) outside the safe zone (${z.top}/${z.right}/${z.bottom}/${z.left}px).`, where: outside.slice(0, 3).map(e => `${e.sel} “${e.text.slice(0, 30)}”`).join(', '), source: src });

    f.push(...logoFindings(b, data.els, brand.logoMinWidthPx, true));
    const logo = data.els.find(e => e.logo);
    if (logo) {
      const cx = logo.x + logo.w / 2, cy = logo.y + logo.h / 2;
      const place = slot.height <= 120 ? (cx < slot.width / 3 ? 'left' : cx > (slot.width * 2) / 3 ? 'right' : 'center') : `${cy < slot.height / 2 ? 'top' : 'bottom'}-${cx < slot.width / 3 ? 'left' : cx > (slot.width * 2) / 3 ? 'right' : 'center'}`;
      if (!brand.logoPlacement.includes(place)) f.push({ rule: 'ad.logo-placement', severity: 'error', message: `Logo sits ${place}; ${slot.name} allows ${brand.logoPlacement.join(' or ')}.`, where: logo.sel, source: src });
    }
    if (slot.ctaRequired && !data.els.some(e => e.cta)) f.push({ rule: 'ad.cta', severity: 'error', message: `${slot.name} requires a call to action (a link or button with text, or [data-cta]).`, source: src });
    if (slot.minFontPx) {
      const small = data.els.filter(e => e.text && e.size < slot.minFontPx!);
      if (small.length) f.push({ rule: 'ad.font-size', severity: 'error', message: `${small.length} text element(s) below ${slot.minFontPx}px for ${slot.name}.`, where: small.slice(0, 3).map(e => e.sel).join(', '), source: src });
    }

    // background and border of the creative's outermost box
    const root = data.els.filter(e => Math.abs(e.w - slot.width) < 2 && Math.abs(e.h - slot.height) < 2)[0];
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const bg = parseColor(root && parseColor(root.bg)?.a ? root.bg : bodyBg);
    if (bg && bg.a > 0) {
      const hex = toHex(bg);
      const ok = brand.backgrounds.some(p => b.tokens.find(t => t.path === p)?.value.toUpperCase() === hex);
      if (!ok) f.push({ rule: 'ad.background', severity: 'error', message: `Background ${hex} is not an approved ad background.`, suggestion: brand.backgrounds.join(', '), source: src });
      const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
      if (slot.borderRequiredOnLightBackground && lum > 225 && !(root && root.borders.length === 4)) f.push({ rule: 'ad.border', severity: 'error', message: 'Light-background display ads need a 1px border on the creative (color.border.default).', source: src });
    }

    const text = data.els.filter(e => e.text).map(e => e.text).join('\n');
    if (text) f.push(...checkCopy(b, { text }).map(x => ({ ...x, where: x.where ?? 'rendered text' })));
    const headline = data.els.filter(e => e.text && /^h[1-3]$/.test(e.tag))[0];
    if (headline) f.push(...checkCopy(b, { text: headline.text, kind: 'headline' }, slot).filter(x => x.rule === 'copy.length'));
    f.push(...typeFindings(b, data.els).filter(x => x.rule === 'page.off-brand-font'));
    f.push(...colorFindings(b, data.els));
    f.push(...(await axe(page, ['color-contrast', 'image-alt', 'link-name', 'button-name'])));
    const shot = screenshot ? (await page.screenshot({ type: 'png' })).toString('base64') : undefined;
    return { findings: f, initialLoadKb, screenshot: shot };
  });
}
