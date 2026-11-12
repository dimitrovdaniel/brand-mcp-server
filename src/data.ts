import bundle from './generated/brand-data.json' with { type: 'json' };
import { parseColor, type Rgba } from './lib/color.js';
import type { BrandBundle, TokenEntry } from './types.js';

export const BRANDS = (bundle as unknown as { brands: Record<string, BrandBundle> }).brands;
export const BRAND_IDS = Object.keys(BRANDS).sort() as [string, ...string[]];

export class BrandError extends Error {}

export function getBrand(id: string): BrandBundle {
  const b = BRANDS[id];
  if (!b) throw new BrandError(`Unknown brand "${id}". Known brands: ${BRAND_IDS.join(', ')}.`);
  return b;
}

export const tokenByPath = (b: BrandBundle, path: string) => b.tokens.find(t => t.path === path);

/** Semantic (non-primitive) tokens first: those are what product code and ads should use. */
export const isPrimitive = (t: TokenEntry) => t.path.includes('.primitive.');

export interface ResolvedColor {
  input: string;
  rgba: Rgba;
  hex: string;
  token?: TokenEntry;
}

/**
 * Accepts a token path ("color.action.primary"), a CSS custom property ("--hg-color-action-primary"
 * or "var(--hg-…)") or any CSS colour literal, and returns the colour plus the token it came from.
 */
export function resolveColor(b: BrandBundle, input: string): ResolvedColor | undefined {
  const s = input.trim();
  const varName = s.match(/^var\(\s*(--[\w-]+)/)?.[1] ?? (s.startsWith('--') ? s : undefined);
  const token = varName ? b.tokens.find(t => t.cssVar === varName) : b.tokens.find(t => t.path === s || t.path === `color.${s}`);
  if (token) {
    if (token.type !== 'color') return undefined;
    const rgba = parseColor(token.value);
    return rgba && { input, rgba, hex: token.value.toUpperCase(), token };
  }
  const rgba = parseColor(s);
  if (!rgba) return undefined;
  const hex = s.startsWith('#') ? s.toUpperCase() : undefined;
  const exact = b.tokens.filter(t => t.type === 'color' && t.value.toUpperCase() === (hex ?? '')).sort((x, y) => Number(isPrimitive(x)) - Number(isPrimitive(y)))[0];
  return { input, rgba, hex: hex ?? s, token: exact };
}

/** All colour tokens with parsed values. */
export const colorTokens = (b: BrandBundle) =>
  b.tokens.filter(t => t.type === 'color').map(t => ({ token: t, rgba: parseColor(t.value)! })).filter(x => x.rgba);
