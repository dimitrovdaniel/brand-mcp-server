import { describe, expect, it } from 'vitest';
import { contrastRatio, deltaE, parseColor, toHex } from '../src/lib/color.js';
import { colorToCss, dimToCss } from '../scripts/build-tokens.js';

describe('colour maths', () => {
  it('parses the CSS colour syntaxes agents write', () => {
    expect(toHex(parseColor('#1f4d3a')!)).toBe('#1F4D3A');
    expect(toHex(parseColor('#fff')!)).toBe('#FFFFFF');
    expect(toHex(parseColor('rgb(31, 77, 58)')!)).toBe('#1F4D3A');
    expect(toHex(parseColor('rgb(31 77 58 / 50%)')!)).toBe('#1F4D3A');
    expect(parseColor('rgba(0,0,0,0.5)')!.a).toBe(0.5);
    expect(toHex(parseColor('hsl(0, 100%, 50%)')!)).toBe('#FF0000');
    expect(parseColor('not-a-colour')).toBeUndefined();
  });

  it('matches the WCAG 2.1 reference values', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777777')!, parseColor('#ffffff')!)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseColor('#fff')!, parseColor('#fff')!)).toBe(1);
  });

  it('measures perceptual distance', () => {
    expect(deltaE(parseColor('#1F4D3A')!, parseColor('#1F4D3A')!)).toBe(0);
    expect(deltaE(parseColor('#1F4D3A')!, parseColor('#1F4D3B')!)).toBeLessThan(1);
    expect(deltaE(parseColor('#000')!, parseColor('#fff')!)).toBeGreaterThan(90);
  });
});

describe('DTCG 2025.10 value transforms', () => {
  it('turns colour objects into CSS', () => {
    expect(colorToCss({ colorSpace: 'srgb', components: [0.1216, 0.302, 0.2275], hex: '#1F4D3A' })).toBe('#1F4D3A');
    expect(colorToCss({ colorSpace: 'srgb', components: [1, 1, 1], alpha: 0.5 })).toBe('rgb(255 255 255 / 0.5)');
    expect(colorToCss({ colorSpace: 'display-p3', components: [1, 0, 0], hex: '#FF0000' })).toBe('#FF0000');
    expect(() => colorToCss({ colorSpace: 'oklch', components: [0.5, 0.1, 30] })).toThrow();
  });
  it('turns dimension objects into CSS', () => {
    expect(dimToCss({ value: 16, unit: 'px' })).toBe('16px');
    expect(dimToCss({ value: 1.5, unit: 'rem' })).toBe('1.5rem');
  });
});
