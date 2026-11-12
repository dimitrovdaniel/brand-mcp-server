/**
 * Code check for CSS, SCSS, HTML, JSX/TSX and Tailwind class strings: finds hard-coded colours,
 * fonts, font sizes, spacing and radii that should be tokens, and suggests the token to use.
 */
import { colorTokens, isPrimitive } from '../data.js';
import { deltaE, parseColor, toHex } from '../lib/color.js';
import type { BrandBundle, TokenEntry } from '../types.js';
import type { Finding } from './finding.js';

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;
const VAR_RE = /var\(\s*(--[\w-]+)/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}\n]+)|fontFamily\s*:\s*(['"`])([^'"`]+)\2/g;
const PX_DECL_RE = /\b(font-size|fontSize|margin(?:-\w+)?|padding(?:-\w+)?|gap|row-gap|column-gap|border-radius|borderRadius|margin[A-Z]\w*|padding[A-Z]\w*)\s*:\s*['"`]?([^;'"`}\n]+)/g;

const lineAt = (code: string, i: number) => code.slice(0, i).split('\n').length;

function dims(b: BrandBundle, prefix: string) {
  return b.tokens.filter(t => t.path.startsWith(prefix) && /^-?[\d.]+px$/.test(t.value)).map(t => ({ t, px: parseFloat(t.value) }));
}

/** Semantic tokens with this exact value, best first; falls back to primitives. */
function tokensFor(b: BrandBundle, hex: string): TokenEntry[] {
  return b.tokens.filter(t => t.type === 'color' && t.value.toUpperCase() === hex).sort((x, y) => Number(isPrimitive(x)) - Number(isPrimitive(y)));
}

export function checkCode(b: BrandBundle, code: string): Finding[] {
  const out: Finding[] = [];
  const src = `brand://${b.meta.id}/guidelines/color-and-type`;
  const palette = colorTokens(b);
  const prefix = `--${b.meta.tokenPrefix}-`;

  // 1. colour literals
  for (const m of code.matchAll(COLOR_RE)) {
    const rgba = parseColor(m[0]);
    if (!rgba) continue;
    const where = `line ${lineAt(code, m.index!)}: ${m[0]}`;
    if (rgba.a === 0) continue; // transparent
    const hex = toHex(rgba);
    const exact = tokensFor(b, hex);
    if (exact.length) {
      const names = exact.filter(t => !isPrimitive(t)).map(t => `${t.path} (var(${t.cssVar}))`);
      out.push({
        rule: 'code.hardcoded-color',
        severity: 'warning',
        message: `Hard-coded brand colour ${m[0]}. Use a semantic token instead.`,
        where,
        suggestion: names.length ? `Pick by role: ${names.join(', ')}` : `var(${exact[0].cssVar})`,
        source: src,
      });
      continue;
    }
    const nearest = palette.map(p => ({ ...p, d: deltaE(rgba, p.rgba) })).sort((x, y) => x.d - y.d)[0];
    const near = nearest && nearest.d < 4;
    const sem = near ? tokensFor(b, nearest.token.value.toUpperCase()).filter(t => !isPrimitive(t))[0] : undefined;
    out.push({
      rule: 'code.off-palette-color',
      severity: 'error',
      message: near
        ? `${m[0]} is not a brand colour; it is close to ${nearest.token.path} ${nearest.token.value} (ΔE ${nearest.d.toFixed(1)}).`
        : `${m[0]} is not in the ${b.meta.name} palette.`,
      where,
      suggestion: near ? `var(${(sem ?? nearest.token).cssVar})` : 'Use a colour token; see get_tokens(group: "color").',
      source: src,
    });
  }

  // 2. custom properties: unknown or primitive
  for (const m of code.matchAll(VAR_RE)) {
    const name = m[1];
    if (!name.startsWith(prefix)) continue;
    const t = b.tokens.find(x => x.cssVar === name);
    const where = `line ${lineAt(code, m.index!)}: ${name}`;
    if (!t) out.push({ rule: 'code.unknown-token', severity: 'error', message: `${name} is not a ${b.meta.name} token.`, where, suggestion: 'Check the name with find_token.', source: `brand://${b.meta.id}/tokens/css` });
    else if (isPrimitive(t)) {
      const sem = tokensFor(b, t.value.toUpperCase()).filter(x => !isPrimitive(x)).map(x => `var(${x.cssVar})`);
      out.push({ rule: 'code.primitive-token', severity: 'warning', message: `${name} is a primitive palette token. Product code should use the semantic layer.`, where, suggestion: sem.join(' or ') || undefined, source: src });
    }
  }

  // 3. font families
  const families = Object.values(b.meta.fonts).map(f => f.family.toLowerCase());
  const fallbacks = new Set(b.tokens.filter(t => t.type === 'fontFamily').flatMap(t => t.value.split(',').map(s => s.trim().replace(/["']/g, '').toLowerCase())));
  for (const m of code.matchAll(FONT_FAMILY_RE)) {
    const value = (m[1] ?? m[3]).trim();
    if (/var\(/.test(value) || /^(inherit|initial|unset)$/i.test(value)) continue;
    const first = value.split(',')[0].trim().replace(/["']/g, '').toLowerCase();
    if (!families.includes(first)) {
      out.push({
        rule: 'code.off-brand-font',
        severity: fallbacks.has(first) ? 'warning' : 'error',
        message: `font-family “${value}” does not start with a ${b.meta.name} typeface (${Object.values(b.meta.fonts).map(f => f.family).join(', ')}).`,
        where: `line ${lineAt(code, m.index!)}`,
        suggestion: `var(${prefix}font-family-body) or var(${prefix}font-family-display)`,
        source: src,
      });
    }
  }

  // 4. sizes that are not on the scale
  const scales = { font: dims(b, 'font.size.'), space: dims(b, 'space.'), radius: dims(b, 'radius.') };
  for (const m of code.matchAll(PX_DECL_RE)) {
    const prop = m[1];
    const kind = /font/i.test(prop) ? 'font' : /radius/i.test(prop) ? 'radius' : 'space';
    const scale = scales[kind];
    for (const v of m[2].matchAll(/(-?[\d.]+)px/g)) {
      const px = Math.abs(parseFloat(v[1]));
      if (px === 0 || px === 1) continue;
      if (scale.some(s => s.px === px)) {
        const t = scale.find(s => s.px === px)!.t;
        out.push({ rule: 'code.hardcoded-size', severity: 'info', message: `${prop}: ${px}px matches ${t.path}; prefer the token.`, where: `line ${lineAt(code, m.index!)}`, suggestion: `var(${t.cssVar})`, source: src });
        continue;
      }
      const nearest = [...scale].sort((x, y) => Math.abs(x.px - px) - Math.abs(y.px - px))[0];
      out.push({
        rule: 'code.off-scale-size',
        severity: kind === 'font' && px < b.meta.layout.minBodyFontPx - 4 ? 'error' : 'warning',
        message: `${prop}: ${px}px is not on the ${kind} scale.`,
        where: `line ${lineAt(code, m.index!)}`,
        suggestion: nearest ? `var(${nearest.t.cssVar}) (${nearest.px}px)` : undefined,
        source: src,
      });
    }
  }
  return out;
}
