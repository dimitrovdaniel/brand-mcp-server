import { describe, expect, it } from 'vitest';
import { checkAdSpec, findSlot } from '../src/checks/ad-spec.js';
import { checkCode } from '../src/checks/code.js';
import { checkPairs } from '../src/checks/contrast.js';
import { checkCopy } from '../src/checks/copy.js';
import { getBrand } from '../src/data.js';

const hg = getBrand('haferglueck'), ks = getBrand('kiesel'), sf = getBrand('sonnfeld');
const rulesOf = (f: { rule: string }[]) => f.map(x => x.rule);

describe('check_copy', () => {
  it('catches “milk” for an oat drink, also inflected health claims', () => {
    const f = checkCopy(hg, { text: 'Die gesunde Hafermilch' });
    expect(f.map(x => x.where)).toEqual(expect.arrayContaining(['line 1: “Hafermilch”', 'line 1: “gesunde”']));
    // "Milch" inside "Hafermilch" is reported once, not twice
    expect(f.filter(x => x.rule === 'copy.forbidden-term')).toHaveLength(2);
  });

  it('enforces du for Haferglück but ignores “Sie” starting a sentence (= they)', () => {
    expect(rulesOf(checkCopy(hg, { text: 'Probieren Sie unseren Haferdrink.' }))).toContain('copy.address-form');
    expect(rulesOf(checkCopy(hg, { text: 'Unsere Bauern? Sie wohnen 20 km entfernt.' }))).not.toContain('copy.address-form');
  });

  it('enforces Sie for Sonnfeld', () => {
    const f = checkCopy(sf, { text: 'Schütze dich und deine Kinder.' });
    expect(f.filter(x => x.rule === 'copy.address-form')).toHaveLength(2);
  });

  it('applies the EU sunscreen recommendation wording rules', () => {
    const f = checkCopy(sf, { text: 'Der Sunblocker mit 100% Schutz, ganztägiger Schutz ohne Nachcremen.' });
    expect(f.filter(x => x.rule === 'copy.forbidden-term').map(x => x.where)).toEqual(['line 1: “Sunblocker”', 'line 1: “100% Schutz”', 'line 1: “ganztägiger”']);
  });

  it('requires the biocide sentence when a Kiesel text talks about disinfection', () => {
    expect(rulesOf(checkCopy(ks, { text: 'Desinfektion für die Küche.' }))).toContain('copy.required-disclaimer');
    const ok = 'Desinfektion für die Küche. Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.';
    expect(rulesOf(checkCopy(ks, { text: ok }))).not.toContain('copy.required-disclaimer');
  });

  it('checks brand-name spelling case-sensitively and ignores URLs', () => {
    expect(rulesOf(checkCopy(hg, { text: 'Neu von HAFERGLÜCK' }))).toContain('copy.brand-name');
    expect(rulesOf(checkCopy(hg, { text: 'Mehr auf https://haferglueck.de/rezepte' }))).not.toContain('copy.brand-name');
  });

  it('applies the headline limit of the slot', () => {
    const slot = findSlot(hg, 'mobile-banner')!;
    expect(rulesOf(checkCopy(hg, { text: 'Hafer aus Bayern, vier Zutaten, ein guter Morgen', kind: 'headline' }, slot))).toContain('copy.length');
  });

  it('passes clean copy', () => {
    expect(checkCopy(hg, { text: 'Hafer aus Bayern. Vier Zutaten. Ein guter Morgen.' }).filter(f => f.severity === 'error')).toEqual([]);
  });
});

describe('check_code', () => {
  it('suggests semantic tokens for hard-coded brand colours, by role', () => {
    const f = checkCode(hg, '.btn { background: #1F4D3A; }');
    expect(f[0]).toMatchObject({ rule: 'code.hardcoded-color', severity: 'warning' });
    expect(f[0].suggestion).toContain('color.action.primary');
  });
  it('flags near-miss and foreign colours as off-palette with the nearest token', () => {
    const f = checkCode(hg, 'a { color: #1F4D3B }\nb { color: hotpink; color: #ff00aa }');
    const off = f.filter(x => x.rule === 'code.off-palette-color');
    expect(off).toHaveLength(2);
    expect(off[0].message).toContain('close to');
    expect(off[1].where).toBe('line 2: #ff00aa');
  });
  it('flags primitives, unknown tokens, foreign fonts and off-scale sizes', () => {
    const code = `.a { color: var(--hg-color-primitive-sun-400); }
.b { color: var(--hg-color-text-loud); }
.c { font-family: "Comic Sans MS", cursive; padding: 13px; font-size: 11px; }`;
    expect(rulesOf(checkCode(hg, code))).toEqual(expect.arrayContaining(['code.primitive-token', 'code.unknown-token', 'code.off-brand-font', 'code.off-scale-size']));
  });
  it('understands JSX style objects', () => {
    const f = checkCode(ks, `<div style={{ fontFamily: 'Roboto', padding: '24px', color: '#136a73' }} />`);
    expect(rulesOf(f)).toEqual(expect.arrayContaining(['code.off-brand-font', 'code.hardcoded-size', 'code.hardcoded-color']));
  });
  it('is quiet on token-only code', () => {
    expect(checkCode(hg, '.btn { background: var(--hg-color-action-primary); color: var(--hg-color-action-on-primary); padding: var(--hg-space-3); }')).toEqual([]);
  });
});

describe('check_contrast', () => {
  it('approves listed pairs', () => {
    const { results, findings } = checkPairs(hg, [{ foreground: 'color.text.inverse', background: 'color.surface.brand', usage: 'text' }]);
    expect(results[0].brandStatus).toBe('allowed');
    expect(findings).toEqual([]);
  });
  it('rejects forbidden pairs with the brand’s reason, even as raw hex', () => {
    const { results, findings } = checkPairs(hg, [{ foreground: '#FFFFFF', background: '#F2B33D' }]);
    expect(results[0].brandStatus).toBe('forbidden');
    expect(rulesOf(findings)).toEqual(['contrast.wcag', 'contrast.forbidden-pair']);
  });
  it('rejects a pair used beyond its approved usage', () => {
    const { findings } = checkPairs(ks, [{ foreground: 'color.accent.default', background: 'color.surface.brand', usage: 'text' }]);
    expect(rulesOf(findings)).toContain('contrast.wrong-usage');
  });
});

describe('check_ad (spec only)', () => {
  const slot = findSlot(hg, 'medium-rectangle')!;
  it('passes a compliant creative', () => {
    const f = checkAdSpec(hg, slot, { width: 300, height: 250, fileType: 'png', fileSizeKb: 90, headline: 'Ein guter Morgen.', cta: 'Jetzt probieren', logoVariant: 'primary', logoWidthPx: 80, logoPlacement: 'top-left', background: 'color.surface.default', hasBorder: true });
    expect(f.filter(x => x.severity === 'error')).toEqual([]);
  });
  it('reports every broken rule', () => {
    const f = checkAdSpec(hg, slot, { width: 300, height: 260, fileType: 'webp', fileSizeKb: 400, animationSeconds: 20, loops: 5, logoWidthPx: 40, logoPlacement: 'top-right', background: '#1F4D3A', logoVariant: 'primary', cta: '' });
    expect(new Set(rulesOf(f))).toEqual(new Set(['ad.size', 'ad.file-type', 'ad.file-size', 'ad.animation', 'ad.logo-size', 'ad.logo-placement', 'ad.logo-background', 'ad.cta']));
  });
  it('needs a border on light backgrounds', () => {
    expect(rulesOf(checkAdSpec(hg, slot, { background: 'color.surface.default', hasBorder: false }))).toContain('ad.border');
  });
});
