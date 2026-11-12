import { describe, expect, it } from 'vitest';
import { figmaToDtcg, type FigmaVariablesResponse } from '../scripts/figma-export.js';

/** Shape of GET /v1/files/:key/variables/local, trimmed to what the converter reads. */
const response: FigmaVariablesResponse = {
  meta: {
    variableCollections: {
      'VC:1': { id: 'VC:1', name: 'Color', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] },
      'VC:2': { id: 'VC:2', name: 'Spacing & Type', defaultModeId: 's1', modes: [{ modeId: 's1', name: 'Default' }] },
    },
    variables: {
      'V:1': { id: 'V:1', name: 'color/primitive/forest/700', variableCollectionId: 'VC:1', resolvedType: 'COLOR', valuesByMode: { m1: { r: 0.1216, g: 0.302, b: 0.2275, a: 1 }, m2: { r: 1, g: 1, b: 1, a: 1 } } },
      'V:2': { id: 'V:2', name: 'color/action/primary', variableCollectionId: 'VC:1', resolvedType: 'COLOR', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'V:1' }, m2: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, description: 'Buttons and links' },
      'V:3': { id: 'V:3', name: 'color/overlay', variableCollectionId: 'VC:1', resolvedType: 'COLOR', valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 0.5 }, m2: { r: 0, g: 0, b: 0, a: 0.7 } } },
      'V:4': { id: 'V:4', name: 'space/4', variableCollectionId: 'VC:2', resolvedType: 'FLOAT', scopes: ['GAP', 'WIDTH_HEIGHT'], valuesByMode: { s1: 16 } },
      'V:5': { id: 'V:5', name: 'font/weight/bold', variableCollectionId: 'VC:2', resolvedType: 'FLOAT', scopes: ['FONT_WEIGHT'], valuesByMode: { s1: 700 } },
      'V:6': { id: 'V:6', name: 'font/family/body', variableCollectionId: 'VC:2', resolvedType: 'STRING', scopes: ['FONT_FAMILY'], valuesByMode: { s1: 'Inter, Arial, sans-serif' } },
      'V:7': { id: 'V:7', name: 'flags/beta', variableCollectionId: 'VC:2', resolvedType: 'BOOLEAN', valuesByMode: { s1: true } },
      'V:8': { id: 'V:8', name: 'color/library/remote', variableCollectionId: 'VC:1', resolvedType: 'COLOR', remote: true, valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } } },
    },
  },
};

describe('Figma Variables → DTCG 2025.10', () => {
  const out = figmaToDtcg(response);

  it('writes one file per collection', () => {
    expect(Object.keys(out).sort()).toEqual(['color', 'spacing-type']);
  });

  it('converts colours to 2025.10 colour objects with a hex fallback', () => {
    expect((out.color as any).color.primitive.forest['700']).toEqual({ $type: 'color', $value: { colorSpace: 'srgb', components: [0.1216, 0.302, 0.2275], hex: '#1F4D3A' } });
    expect((out.color as any).color.overlay.$value).toMatchObject({ alpha: 0.5 });
  });

  it('turns aliases into references and keeps descriptions', () => {
    expect((out.color as any).color.action.primary).toEqual({ $type: 'color', $value: '{color.primitive.forest.700}', $description: 'Buttons and links' });
  });

  it('maps FLOAT and STRING by scope', () => {
    const t = out['spacing-type'] as any;
    expect(t.space['4']).toEqual({ $type: 'dimension', $value: { value: 16, unit: 'px' } });
    expect(t.font.weight.bold).toEqual({ $type: 'fontWeight', $value: 700 });
    expect(t.font.family.body.$value).toEqual(['Inter', 'Arial', 'sans-serif']);
  });

  it('skips booleans and remote library variables', () => {
    expect((out['spacing-type'] as any).flags).toBeUndefined();
    expect((out.color as any).color.library).toBeUndefined();
  });

  it('reads another mode by name', () => {
    expect((figmaToDtcg(response, 'Dark').color as any).color.primitive.forest['700'].$value.hex).toBe('#FFFFFF');
  });
});
