/** Ad spec check from creative metadata (no browser needed): size, file, animation, logo, background, copy. */
import { resolveColor } from '../data.js';
import { luminance } from '../lib/color.js';
import type { AdSlot, BrandBundle } from '../types.js';
import { checkCopy } from './copy.js';
import type { Finding } from './finding.js';

export interface AdCreative {
  width?: number;
  height?: number;
  fileType?: string;
  fileSizeKb?: number;
  animationSeconds?: number;
  loops?: number;
  headline?: string;
  body?: string;
  cta?: string;
  logoVariant?: string;
  logoWidthPx?: number;
  logoPlacement?: string;
  background?: string;
  hasBorder?: boolean;
}

export function findSlot(b: BrandBundle, slotId: string): AdSlot | undefined {
  return b.rules.adSlots.find(s => s.id === slotId);
}

export function checkAdSpec(b: BrandBundle, slot: AdSlot, c: AdCreative): Finding[] {
  const out: Finding[] = [];
  const src = `brand://${b.meta.id}/rules/ad-slots`;
  const add = (rule: string, severity: Finding['severity'], message: string, suggestion?: string) => out.push({ rule, severity, message, suggestion, source: src });
  const brand = slot.brand!;

  if (c.width !== undefined && c.height !== undefined && (c.width !== slot.width || c.height !== slot.height))
    add('ad.size', 'error', `Creative is ${c.width}×${c.height}; ${slot.name} is ${slot.width}×${slot.height}.`);
  if (c.fileType && !slot.fileTypes.includes(c.fileType.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')))
    add('ad.file-type', 'error', `${c.fileType} is not accepted for ${slot.name}; use ${slot.fileTypes.join(', ')}.`);
  if (c.fileSizeKb !== undefined) {
    if (slot.maxInitialLoadKb && c.fileSizeKb > slot.maxInitialLoadKb) add('ad.file-size', 'error', `Initial load ${c.fileSizeKb} KB exceeds ${slot.maxInitialLoadKb} KB.`);
    if (slot.maxFileSizeMb && c.fileSizeKb > slot.maxFileSizeMb * 1024) add('ad.file-size', 'error', `File ${c.fileSizeKb} KB exceeds ${slot.maxFileSizeMb} MB.`);
  }
  if (c.animationSeconds !== undefined && slot.maxAnimationSeconds !== undefined && c.animationSeconds > slot.maxAnimationSeconds)
    add('ad.animation', 'error', `Animation runs ${c.animationSeconds}s; at most ${slot.maxAnimationSeconds}s.`);
  if (c.loops !== undefined && slot.maxLoops !== undefined && c.loops > slot.maxLoops) add('ad.animation', 'error', `${c.loops} loops; at most ${slot.maxLoops}.`);

  if (c.logoVariant && c.logoVariant !== brand.logo) add('ad.logo-variant', 'warning', `${slot.name} uses the “${brand.logo}” logo, not “${c.logoVariant}”.`, brand.logo);
  if (c.logoWidthPx !== undefined && c.logoWidthPx < brand.logoMinWidthPx) add('ad.logo-size', 'error', `Logo is ${c.logoWidthPx}px wide; at least ${brand.logoMinWidthPx}px in ${slot.name}.`);
  if (c.logoPlacement && !brand.logoPlacement.includes(c.logoPlacement)) add('ad.logo-placement', 'error', `Logo placement “${c.logoPlacement}” is not allowed; use ${brand.logoPlacement.join(' or ')}.`);

  if (c.background) {
    const bg = resolveColor(b, c.background);
    if (!bg) add('ad.background', 'error', `Cannot read background “${c.background}”.`);
    else {
      const ok = brand.backgrounds.some(p => b.tokens.find(t => t.path === p)?.value.toUpperCase() === bg.hex.toUpperCase());
      if (!ok) add('ad.background', 'error', `Background ${bg.hex} is not an approved ad background.`, brand.backgrounds.join(', '));
      // the logo variant must suit the background
      const variant = b.logos.find(l => l.id === (c.logoVariant ?? brand.logo));
      if (variant && !variant.backgrounds.some(p => b.tokens.find(t => t.path === p)?.value.toUpperCase() === bg.hex.toUpperCase())) {
        const fit = b.logos.filter(l => l.backgrounds.some(p => b.tokens.find(t => t.path === p)?.value.toUpperCase() === bg.hex.toUpperCase())).map(l => l.id);
        add('ad.logo-background', 'error', `The “${variant.id}” logo is not approved on ${bg.hex}.`, fit.length ? `Use the ${fit.join(' or ')} logo.` : undefined);
      }
      if (slot.borderRequiredOnLightBackground && luminance(bg.rgba) > 0.8 && c.hasBorder === false)
        add('ad.border', 'error', `Light-background display ads need a 1px border (color.border.default).`);
    }
  }

  if (slot.ctaRequired && c.cta !== undefined && !c.cta.trim()) add('ad.cta', 'error', `${slot.name} requires a call to action.`);
  if (slot.ctaRequired && c.cta === undefined && (c.headline !== undefined || c.body !== undefined)) add('ad.cta', 'warning', `${slot.name} requires a call to action; none was given.`);
  if (c.headline) out.push(...checkCopy(b, { text: c.headline, kind: 'headline' }, slot));
  if (c.body) out.push(...checkCopy(b, { text: c.body, kind: 'body' }, slot));
  if (c.cta) out.push(...checkCopy(b, { text: c.cta, kind: 'cta' }, slot));
  // the disinfectant sentence may sit in the body while the trigger word is in the headline
  const all = [c.headline, c.body, c.cta].filter(Boolean).join('\n');
  if (all) {
    const combined = checkCopy(b, { text: all }).filter(f => f.rule === 'copy.required-disclaimer');
    const already = new Set(out.filter(f => f.rule === 'copy.required-disclaimer').map(f => f.message));
    for (const f of combined) if (!already.has(f.message)) out.push(f);
    // drop per-part disclaimer findings that the combined text satisfies
    if (!combined.length) for (let i = out.length - 1; i >= 0; i--) if (out[i].rule === 'copy.required-disclaimer') out.splice(i, 1);
  }
  return out;
}
