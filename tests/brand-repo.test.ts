/** Invariants of the brand repo itself. These run on every change to brands/. */
import { describe, expect, it } from 'vitest';
import { BRAND_IDS, getBrand } from '../src/data.js';
import { contrastRatio, parseColor } from '../src/lib/color.js';

describe.each(BRAND_IDS)('brand %s', id => {
  const b = getBrand(id);

  it('has the semantic colour roles every agent relies on', () => {
    for (const role of ['text.default', 'text.muted', 'text.inverse', 'surface.default', 'surface.brand', 'action.primary', 'action.on-primary', 'border.default'])
      expect(b.tokens.find(t => t.path === `color.${role}`), role).toBeDefined();
  });

  it('builds every token to CSS with the brand prefix', () => {
    for (const t of b.tokens) {
      expect(t.cssVar.startsWith(`--${b.meta.tokenPrefix}-`)).toBe(true);
      expect(b.outputs.css).toContain(`${t.cssVar}:`);
    }
  });

  it('keeps colour tokens in DTCG 2025.10 object form in the source', () => {
    const primitives = b.tokens.filter(t => t.path.startsWith('color.primitive.'));
    expect(primitives.length).toBeGreaterThan(5);
    for (const t of primitives) expect(t.raw).toMatchObject({ colorSpace: 'srgb', components: expect.any(Array) });
  });

  it('only approves colour pairs that pass WCAG 2.1 AA for their usage', () => {
    const value = (p: string) => parseColor(b.tokens.find(t => t.path === p)!.value)!;
    for (const p of b.rules.colorPairs.pairs) {
      const ratio = contrastRatio(value(p.foreground), value(p.background));
      expect(ratio, `${p.foreground} on ${p.background}`).toBeGreaterThanOrEqual(p.usage.includes('text') ? 4.5 : 3);
    }
  });

  it('has guidelines for logo, colour, voice and advertising', () => {
    const pages = new Set(b.guidelines.map(g => g.page));
    for (const p of ['essence', 'logo', 'color-and-type', 'voice-and-copy', 'imagery-and-layout', 'advertising']) expect(pages).toContain(p);
  });

  it('ships an SVG for every logo version', () => {
    for (const l of b.logos) expect(l.svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });

  it('books only ad slots with a known logo and approved backgrounds', () => {
    for (const s of b.rules.adSlots) {
      expect(b.logos.map(l => l.id)).toContain(s.brand!.logo);
      expect(s.brand!.backgrounds.length).toBeGreaterThan(0);
    }
  });
});
