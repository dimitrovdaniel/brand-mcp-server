/** Contrast check: WCAG 2.1 ratios plus the brand's own allowed/forbidden pair list. */
import { resolveColor } from '../data.js';
import { wcag, type WcagResult } from '../lib/color.js';
import type { BrandBundle, PairUsage } from '../types.js';
import type { Finding } from './finding.js';

export interface PairInput {
  foreground: string;
  background: string;
  usage?: PairUsage;
}

export interface PairResult extends WcagResult {
  foreground: string;
  background: string;
  foregroundToken?: string;
  backgroundToken?: string;
  usage: PairUsage;
  /** "allowed" when the brand lists this pair for this usage, "forbidden" when it bans it, else "unlisted". */
  brandStatus: 'allowed' | 'forbidden' | 'unlisted' | 'allowed-other-usage';
  note?: string;
}

const NEED: Record<PairUsage, number> = { text: 4.5, 'large-text': 3, ui: 3 };

export function checkPairs(b: BrandBundle, pairs: PairInput[]): { results: PairResult[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const results: PairResult[] = [];
  const src = `brand://${b.meta.id}/rules/color-pairs`;
  for (const p of pairs) {
    const usage = p.usage ?? 'text';
    const fg = resolveColor(b, p.foreground), bg = resolveColor(b, p.background);
    const where = `${p.foreground} on ${p.background}`;
    if (!fg || !bg) {
      findings.push({ rule: 'contrast.unknown-color', severity: 'error', message: `Cannot read ${!fg ? p.foreground : p.background} as a token path, CSS variable or colour.`, where });
      continue;
    }
    const w = wcag(fg.rgba, bg.rgba);
    const ft = fg.token?.path, bt = bg.token?.path;
    // a raw hex that equals a token value counts as that token for the pair list
    const allowed = b.rules.colorPairs.pairs.filter(x => sameColor(b, x.foreground, fg.hex) && sameColor(b, x.background, bg.hex));
    const forbidden = b.rules.colorPairs.forbidden.find(x => sameColor(b, x.foreground, fg.hex) && sameColor(b, x.background, bg.hex));
    const forUsage = allowed.find(x => x.usage.includes(usage));
    const brandStatus: PairResult['brandStatus'] = forbidden ? 'forbidden' : forUsage ? 'allowed' : allowed.length ? 'allowed-other-usage' : 'unlisted';
    results.push({ ...w, foreground: fg.hex, background: bg.hex, foregroundToken: ft, backgroundToken: bt, usage, brandStatus, note: forbidden?.reason ?? forUsage?.note });

    if (w.ratio < NEED[usage]) {
      findings.push({ rule: 'contrast.wcag', severity: 'error', message: `${w.ratio}:1 is below WCAG 2.1 AA (${NEED[usage]}:1) for ${usage}.`, where, suggestion: suggest(b, bg.hex, usage), source: src });
    }
    if (forbidden) findings.push({ rule: 'contrast.forbidden-pair', severity: 'error', message: forbidden.reason, where, suggestion: suggest(b, bg.hex, usage), source: src });
    else if (brandStatus === 'allowed-other-usage')
      findings.push({ rule: 'contrast.wrong-usage', severity: 'error', message: `The brand allows this pair only for ${allowed.flatMap(a => a.usage).join(', ')}.`, where, suggestion: suggest(b, bg.hex, usage), source: src });
    else if (brandStatus === 'unlisted' && w.ratio >= NEED[usage])
      findings.push({ rule: 'contrast.unlisted-pair', severity: 'warning', message: 'Passes WCAG but is not one of the brand’s approved pairs.', where, suggestion: suggest(b, bg.hex, usage), source: src });
  }
  return { results, findings };
}

function sameColor(b: BrandBundle, tokenPath: string, hex: string) {
  return b.tokens.find(t => t.path === tokenPath)?.value.toUpperCase() === hex.toUpperCase();
}

/** Approved foregrounds for a background and usage. */
export function allowedForegrounds(b: BrandBundle, backgroundHex: string, usage: PairUsage) {
  return b.rules.colorPairs.pairs.filter(p => sameColor(b, p.background, backgroundHex) && p.usage.includes(usage));
}

function suggest(b: BrandBundle, bgHex: string, usage: PairUsage) {
  const ok = allowedForegrounds(b, bgHex, usage).map(p => p.foreground);
  return ok.length ? `Approved ${usage} colours on this background: ${[...new Set(ok)].join(', ')}` : `No approved ${usage} colour on this background; change the background.`;
}
