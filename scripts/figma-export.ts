/**
 * Figma Variables → DTCG 2025.10 token files.
 *
 *   FIGMA_TOKEN=… npm run figma:export -- --file <fileKey> --brand haferglueck [--mode Light]
 *
 * Reads GET /v1/files/:key/variables/local (Figma REST API; needs a token with the
 * file_variables:read scope, Enterprise plan) and writes one brands/<brand>/tokens/<collection>.tokens.json
 * per variable collection. Variable names use "/" as the group separator ("color/action/primary").
 * Aliases become DTCG references ("{color.primitive.forest.700}"). Run `npm run build:brands` afterwards;
 * it validates the result and fails on broken references.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRANDS_DIR } from './paths.js';

export interface FigmaVariable {
  id: string;
  name: string;
  variableCollectionId: string;
  resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  valuesByMode: Record<string, FigmaValue>;
  scopes?: string[];
  description?: string;
  remote?: boolean;
  hiddenFromPublishing?: boolean;
}
type FigmaValue = { r: number; g: number; b: number; a: number } | number | string | boolean | { type: 'VARIABLE_ALIAS'; id: string };
export interface FigmaCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
  remote?: boolean;
}
export interface FigmaVariablesResponse {
  meta: { variables: Record<string, FigmaVariable>; variableCollections: Record<string, FigmaCollection> };
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const tokenPath = (name: string) => name.split('/').map(s => s.trim().replace(/\s+/g, '-').replace(/[{}.]/g, '-').toLowerCase());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function typeOf(v: FigmaVariable): string | undefined {
  const scopes = v.scopes ?? [];
  switch (v.resolvedType) {
    case 'COLOR':
      return 'color';
    case 'FLOAT':
      if (scopes.includes('FONT_WEIGHT')) return 'fontWeight';
      if (scopes.some(s => ['OPACITY', 'LINE_HEIGHT'].includes(s)) && !scopes.includes('ALL_SCOPES')) return 'number';
      return 'dimension';
    case 'STRING':
      return scopes.includes('FONT_FAMILY') ? 'fontFamily' : undefined;
    default:
      return undefined; // DTCG has no boolean type
  }
}

/** Converts the Figma response into { collectionSlug: dtcgTree }. */
export function figmaToDtcg(res: FigmaVariablesResponse, modeName?: string): Record<string, Record<string, unknown>> {
  const { variables, variableCollections } = res.meta;
  const out: Record<string, Record<string, unknown>> = {};
  for (const v of Object.values(variables)) {
    if (v.remote || v.hiddenFromPublishing) continue;
    const col = variableCollections[v.variableCollectionId];
    if (!col) continue;
    const type = typeOf(v);
    if (!type) continue;
    const mode = (modeName && col.modes.find(m => m.name.toLowerCase() === modeName.toLowerCase())?.modeId) || col.defaultModeId;
    const raw = v.valuesByMode[mode];
    let $value: unknown;
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
      const target = variables[raw.id];
      if (!target) throw new Error(`${v.name}: alias to unknown variable ${raw.id}`);
      $value = `{${tokenPath(target.name).join('.')}}`;
    } else if (type === 'color') {
      const c = raw as { r: number; g: number; b: number; a: number };
      $value = { colorSpace: 'srgb', components: [r4(c.r), r4(c.g), r4(c.b)], ...(c.a < 1 ? { alpha: r4(c.a) } : {}), hex: hex(c) };
    } else if (type === 'dimension') {
      $value = { value: raw as number, unit: 'px' };
    } else if (type === 'fontFamily') {
      $value = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      $value = raw;
    }
    const tree = (out[slug(col.name)] ??= {});
    const parts = tokenPath(v.name);
    let node: any = tree;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)!] = { $type: type, $value, ...(v.description ? { $description: v.description } : {}) };
  }
  return out;
}

async function main() {
  const arg = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1];
  const file = arg('file'), brand = arg('brand'), mode = process.argv.includes('--mode') ? arg('mode') : undefined;
  if (!file || !brand || !process.env.FIGMA_TOKEN) {
    console.error('Usage: FIGMA_TOKEN=… npm run figma:export -- --file <fileKey> --brand <brand-id> [--mode <mode name>]');
    process.exit(2);
  }
  const res = await fetch(`https://api.figma.com/v1/files/${file}/variables/local`, { headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const trees = figmaToDtcg((await res.json()) as FigmaVariablesResponse, mode);
  const dir = path.join(BRANDS_DIR, brand, 'tokens');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, tree] of Object.entries(trees)) {
    const target = path.join(dir, `${name}.tokens.json`);
    fs.writeFileSync(target, JSON.stringify(tree, null, 2) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), target)}`);
  }
}

if (process.argv[1]?.endsWith('figma-export.ts')) await main();
