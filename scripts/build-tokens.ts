/**
 * Builds every brand's DTCG 2025.10 tokens with Style Dictionary v5.
 *
 *   brands/<id>/tokens/*.tokens.json  ->  build/<id>/{tokens.css, tokens.scss, tokens.js, tokens.json}
 *
 * Style Dictionary's built-in colour/size transforms expect string values, so three small
 * value transforms turn the 2025.10 object forms (colour, dimension, duration) and the
 * typography composite into CSS strings first.
 */
import fs from 'node:fs';
import path from 'node:path';
import StyleDictionary from 'style-dictionary';
import type { TransformedToken } from 'style-dictionary/types';
import { BRANDS_DIR, BUILD_DIR, listBrandIds, readBrandMeta } from './paths.js';

type Dtcg2025Color = { colorSpace: string; components: (number | 'none')[]; alpha?: number; hex?: string };
type Dtcg2025Dim = { value: number; unit: string };

export function colorToCss(v: unknown): string {
  if (typeof v === 'string') return v;
  const c = v as Dtcg2025Color;
  if (c.colorSpace !== 'srgb' && c.hex) return c.hex; // other spaces: the hex fallback is the sRGB rendition
  if (c.colorSpace !== 'srgb') throw new Error(`Unsupported colour space ${c.colorSpace} without hex fallback`);
  const [r, g, b] = c.components.map(x => Math.round((x === 'none' ? 0 : x) * 255));
  const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (c.alpha === undefined || c.alpha === 1) return hex;
  return `rgb(${r} ${g} ${b} / ${c.alpha})`;
}

export const dimToCss = (v: unknown): string => (typeof v === 'object' && v && 'unit' in v ? `${(v as Dtcg2025Dim).value}${(v as Dtcg2025Dim).unit}` : String(v));

const fontList = (v: unknown) => (Array.isArray(v) ? v.map(f => (/\s/.test(f) ? `"${f}"` : f)).join(', ') : String(v));

StyleDictionary.registerTransform({
  name: 'dtcg2025/color',
  type: 'value',
  transitive: true,
  filter: t => (t.$type ?? t.type) === 'color',
  transform: t => colorToCss(t.$value ?? t.value),
});
StyleDictionary.registerTransform({
  name: 'dtcg2025/dimension',
  type: 'value',
  transitive: true,
  filter: t => ['dimension', 'duration'].includes(String(t.$type ?? t.type)),
  transform: t => dimToCss(t.$value ?? t.value),
});
StyleDictionary.registerTransform({
  name: 'dtcg2025/fontFamily',
  type: 'value',
  transitive: true,
  filter: t => (t.$type ?? t.type) === 'fontFamily',
  transform: t => fontList(t.$value ?? t.value),
});
StyleDictionary.registerTransform({
  name: 'dtcg2025/typography',
  type: 'value',
  transitive: true,
  filter: t => (t.$type ?? t.type) === 'typography',
  transform: t => {
    const v = (t.$value ?? t.value) as Record<string, unknown>;
    // CSS `font` shorthand: weight size/line-height family
    return `${v.fontWeight} ${dimToCss(v.fontSize)}/${v.lineHeight} ${fontList(v.fontFamily)}`;
  },
});

const TRANSFORMS = ['attribute/cti', 'name/kebab', 'dtcg2025/color', 'dtcg2025/dimension', 'dtcg2025/fontFamily', 'dtcg2025/typography'];

/** Flat JSON the MCP server reads: one entry per token with path, type, resolved CSS value and alias. */
StyleDictionary.registerFormat({
  name: 'brand/flat-json',
  format: ({ dictionary, options }) => {
    const prefix = (options as { prefix: string }).prefix;
    const out = dictionary.allTokens.map((t: TransformedToken) => ({
      path: t.path.join('.'),
      type: t.$type ?? t.type,
      value: String(t.$value ?? t.value),
      cssVar: `--${t.name}`,
      aliasOf: typeof t.original.$value === 'string' && t.original.$value.startsWith('{') ? t.original.$value.slice(1, -1) : undefined,
      raw: t.original.$value,
      description: t.$description ?? t.description,
    }));
    return JSON.stringify(out, null, 2) + '\n';
  },
});

export async function buildBrand(id: string) {
  const meta = readBrandMeta(id);
  const prefix = meta.tokenPrefix;
  const sd = new StyleDictionary({
    source: [path.join(BRANDS_DIR, id, 'tokens', '*.tokens.json').replaceAll('\\', '/')],
    log: { verbosity: 'silent', warnings: 'disabled' },
    platforms: {
      web: {
        transforms: TRANSFORMS,
        buildPath: path.join(BUILD_DIR, id).replaceAll('\\', '/') + '/',
        prefix,
        files: [
          { destination: 'tokens.css', format: 'css/variables', options: { outputReferences: true, selector: `:root, [data-brand="${id}"]` } },
          { destination: 'tokens.scss', format: 'scss/variables', options: { outputReferences: true } },
          { destination: 'tokens.json', format: 'brand/flat-json', options: { prefix } },
        ],
      },
      js: {
        transforms: TRANSFORMS.map(t => (t === 'name/kebab' ? 'name/camel' : t)),
        buildPath: path.join(BUILD_DIR, id).replaceAll('\\', '/') + '/',
        files: [{ destination: 'tokens.js', format: 'javascript/es6' }],
      },
    },
  });
  await sd.buildAllPlatforms();
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build-tokens.ts')) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  for (const id of listBrandIds()) {
    await buildBrand(id);
    console.log(`built ${id}`);
  }
}
