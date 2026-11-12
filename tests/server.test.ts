/** Protocol-level tests: a real MCP client over Streamable HTTP against the real app. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRAND_IDS } from '../src/data.js';
import { connect } from './helpers.js';

let s: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  s = await connect();
});
afterAll(async () => s.close());

describe('tool surface', () => {
  it('exposes 12 consolidated tools, every one taking a brand and marked read-only', async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      ['check_ad', 'check_code', 'check_contrast', 'check_copy', 'check_page', 'check_visual', 'find_token', 'get_ad_specs', 'get_brand', 'get_logo', 'get_tokens', 'search_guidelines'].sort(),
    );
    for (const t of tools) {
      expect(t.inputSchema.required, t.name).toContain('brand');
      expect((t.inputSchema.properties as any).brand.enum).toEqual(BRAND_IDS);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.description!.length, t.name).toBeGreaterThan(60);
    }
  });

  it('rejects an unknown brand before the handler runs', async () => {
    const r = await s.call('get_brand', { brand: 'acme' });
    expect(r.isError).toBe(true);
  });
});

describe('read tools', () => {
  it('get_brand gives the starting overview', async () => {
    const { data } = await s.call('get_brand', { brand: 'sonnfeld' });
    expect(data).toMatchObject({ name: 'Sonnfeld', addressForm: 'sie' });
    expect(data.colors['color.action.primary']).toBe('#A8402A');
  });

  it('get_tokens filters by group and returns builds in several formats', async () => {
    const list = await s.call('get_tokens', { brand: 'haferglueck', group: 'color.action' });
    expect(list.data.tokens.map((t: any) => t.path)).toEqual(['color.action.primary', 'color.action.primary-hover', 'color.action.on-primary']);
    expect(list.data.tokens[0]).toMatchObject({ value: '#1F4D3A', cssVar: '--hg-color-action-primary', aliasOf: 'color.primitive.forest.700' });
    const css = await s.call('get_tokens', { brand: 'haferglueck', group: 'radius', format: 'css' });
    expect(css.data).toContain('--hg-radius-md: 12px;');
    const dtcg = await s.call('get_tokens', { brand: 'haferglueck', group: 'color.primitive.forest', format: 'dtcg' });
    expect(dtcg.data.color.primitive.forest['700'].$value).toMatchObject({ colorSpace: 'srgb', hex: '#1F4D3A' });
    const prim = await s.call('get_tokens', { brand: 'kiesel', group: 'color' });
    expect(prim.data.tokens.some((t: any) => t.path.includes('primitive'))).toBe(false);
  });

  it('find_token does reverse lookups', async () => {
    const exact = await s.call('find_token', { brand: 'kiesel', query: '#136a73' });
    expect(exact.data.exactMatch).toBe(true);
    expect(exact.data.tokens[0].path).not.toContain('primitive');
    const near = await s.call('find_token', { brand: 'kiesel', query: 'rgb(20 106 116)' });
    expect(near.data.exactMatch).toBe(false);
    expect(near.data.tokens[0].deltaE).toBeLessThan(2);
    const byName = await s.call('find_token', { brand: 'sonnfeld', query: 'muted' });
    expect(byName.data.tokens[0].path).toBe('color.text.muted');
  });

  it('search_guidelines finds the right section in German and English', async () => {
    const en = await s.call('search_guidelines', { brand: 'haferglueck', query: 'how much space around the logo' });
    expect(en.data.sections[0].id).toBe('logo/clear-space');
    const de = await s.call('search_guidelines', { brand: 'kiesel', query: 'Desinfektion Werbung Pflichttext' });
    expect(de.data.sections.map((x: any) => x.page)).toContain('Kiesel: voice and copy');
    const page = await s.call('search_guidelines', { brand: 'sonnfeld', section: 'advertising' });
    expect(page.data.sections.length).toBeGreaterThan(3);
  });

  it('get_logo picks the version approved for a background', async () => {
    const dark = await s.call('get_logo', { brand: 'haferglueck', background: 'color.surface.brand' });
    expect(dark.data.variant).toBe('inverse');
    const wrong = await s.call('get_logo', { brand: 'haferglueck', background: '#1F4D3A', variant: 'primary' });
    expect(wrong.data).toMatchObject({ variant: 'inverse', note: expect.stringContaining('not approved') });
    expect(wrong.data.svg).toMatch(/^<svg/);
    const none = await s.call('get_logo', { brand: 'haferglueck', background: '#FF00AA' });
    expect(none.isError).toBe(true);
  });

  it('get_ad_specs merges shared slots with brand rules', async () => {
    const { data } = await s.call('get_ad_specs', { brand: 'haferglueck', slot: 'mobile-banner' });
    expect(data.slots[0]).toMatchObject({ width: 320, height: 50, brand: { logo: 'mark', logoMinWidthPx: 24 } });
    const notBooked = await s.call('get_ad_specs', { brand: 'sonnfeld', slot: 'mobile-banner' });
    expect(notBooked.isError).toBe(true);
    expect(notBooked.data).toContain('does not book');
  });
});

describe('resources and prompts', () => {
  it('lists brand:// resources for every brand', async () => {
    const { resources } = await s.client.listResources();
    for (const id of BRAND_IDS) {
      for (const suffix of ['overview', 'tokens/css', 'tokens/dtcg', 'guidelines/logo', 'logos/primary', 'rules/copy']) expect(resources.map(r => r.uri)).toContain(`brand://${id}/${suffix}`);
    }
  });

  it('reads tokens, guidelines and rules', async () => {
    const css = await s.client.readResource({ uri: 'brand://kiesel/tokens/css' });
    expect((css.contents[0] as any).text).toContain('--ks-color-action-primary');
    const page = await s.client.readResource({ uri: 'brand://sonnfeld/guidelines/voice-and-copy' });
    expect((page.contents[0] as any).text).toContain('2006/647/EC');
    const rules = await s.client.readResource({ uri: 'brand://haferglueck/rules/color-pairs' });
    expect(JSON.parse((rules.contents[0] as any).text).pairs.length).toBeGreaterThan(5);
  });

  it('offers the three review prompts', async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map(p => p.name).sort()).toEqual(['review_ad', 'review_copy', 'review_page']);
    const p = await s.client.getPrompt({ name: 'review_copy', arguments: { brand: 'sonnfeld', text: 'Ihr Sunblocker' } });
    expect((p.messages[0].content as any).text).toContain('check_copy');
  });
});
