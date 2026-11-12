/**
 * Validates the brand repo and bundles it into src/generated/brand-data.json, the only file the
 * server reads at runtime (so it runs unchanged on Node, Vercel or a Worker; no file system needed).
 *
 * Run after build-tokens.ts:  npm run build:brands
 * Exits non-zero with a list of problems when the brand repo is inconsistent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBrand } from './build-tokens.js';
import { BRANDS_DIR, BUILD_DIR, GENERATED_FILE, listBrandIds, readJson } from './paths.js';
import { contrastRatio, parseColor } from '../src/lib/color.js';
import type { AdSlot, BrandData, BrandBundle, ColorPairRules, GuidelineSection, TokenEntry } from '../src/types.js';

const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

const VALID_TYPES = new Set(['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number', 'typography', 'shadow', 'border', 'gradient', 'transition', 'strokeStyle']);

/** Structural DTCG 2025.10 checks on the source files (Style Dictionary is lenient about these). */
function validateDtcg(brand: string, file: string, node: any, pathParts: string[] = [], inheritedType?: string) {
  const type = node.$type ?? inheritedType;
  if ('$value' in node) {
    const where = `${brand}/${file}: ${pathParts.join('.')}`;
    if (!type) fail(`${where} has no $type (own or inherited)`);
    else if (!VALID_TYPES.has(type)) fail(`${where} has unknown $type "${type}"`);
    const v = node.$value;
    const isRef = typeof v === 'string' && /^\{[^}]+\}$/.test(v);
    if (type === 'color' && !isRef) {
      if (typeof v !== 'object' || !v.colorSpace || !Array.isArray(v.components)) fail(`${where}: colour must be a 2025.10 object {colorSpace, components}`);
    }
    if (type === 'dimension' && !isRef && (typeof v !== 'object' || typeof v.value !== 'number' || !['px', 'rem'].includes(v.unit))) fail(`${where}: dimension must be {value, unit: px|rem}`);
    if (type === 'duration' && !isRef && (typeof v !== 'object' || !['ms', 's'].includes(v.unit))) fail(`${where}: duration must be {value, unit: ms|s}`);
    return;
  }
  for (const [k, child] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (/[{}.]/.test(k)) fail(`${brand}/${file}: token or group name "${k}" must not contain {, } or .`);
    if (child && typeof child === 'object') validateDtcg(brand, file, child, [...pathParts, k], type);
  }
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

/** Splits each markdown file into ## sections; the # title names the page. */
function readGuidelines(brand: string): GuidelineSection[] {
  const dir = path.join(BRANDS_DIR, brand, 'guidelines');
  const out: GuidelineSection[] = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const md = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const page = file.replace(/^\d+-/, '').replace(/\.md$/, '');
    const title = md.match(/^# (.+)$/m)?.[1]?.trim() ?? page;
    const parts = md.split(/^## /m).slice(1);
    if (!parts.length) fail(`${brand}/guidelines/${file} has no "## " sections`);
    for (const part of parts) {
      const [heading, ...rest] = part.split('\n');
      const slug = heading.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push({ id: `${page}/${slug}`, page, pageTitle: title, heading: heading.trim(), text: rest.join('\n').trim() });
    }
  }
  return out;
}

const sharedSlots: AdSlot[] = readJson(path.join(BRANDS_DIR, '_shared', 'ad-slots.json')).slots;
const sharedFormats = readJson(path.join(BRANDS_DIR, '_shared', 'formats.json')).formats;

const brands: Record<string, BrandBundle> = {};
for (const id of listBrandIds()) {
  await buildBrand(id);
  const dir = path.join(BRANDS_DIR, id);
  const meta: BrandData = readJson(path.join(dir, 'brand.json'));
  if (meta.id !== id) fail(`${id}/brand.json: id "${meta.id}" does not match its folder`);

  // tokens: DTCG source (merged), Style Dictionary outputs
  const dtcg: any = {};
  for (const f of fs.readdirSync(path.join(dir, 'tokens')).filter(f => f.endsWith('.tokens.json')).sort()) {
    const src = readJson(path.join(dir, 'tokens', f));
    validateDtcg(id, f, src);
    Object.assign(dtcg, deepMerge(dtcg, src));
  }
  const tokens: TokenEntry[] = readJson(path.join(BUILD_DIR, id, 'tokens.json'));
  const tokenByPath = new Map(tokens.map(t => [t.path, t]));
  const outputs = Object.fromEntries(['css', 'scss', 'js'].map(ext => [ext, fs.readFileSync(path.join(BUILD_DIR, id, `tokens.${ext}`), 'utf8')]));
  const needToken = (p: string, where: string) => {
    if (!tokenByPath.has(p)) fail(`${id}/${where}: unknown token "${p}"`);
  };

  // rules
  const colorPairs: ColorPairRules = readJson(path.join(dir, 'rules', 'color-pairs.json'));
  for (const p of colorPairs.pairs) {
    needToken(p.foreground, 'rules/color-pairs.json');
    needToken(p.background, 'rules/color-pairs.json');
    const fg = tokenByPath.get(p.foreground)?.value, bg = tokenByPath.get(p.background)?.value;
    if (typeof fg !== 'string' || typeof bg !== 'string') continue;
    const ratio = contrastRatio(parseColor(fg)!, parseColor(bg)!);
    const need = p.usage.includes('text') ? 4.5 : 3;
    if (ratio < need) fail(`${id}: allowed pair ${p.foreground} on ${p.background} is ${ratio.toFixed(2)}:1 but usage [${p.usage}] needs ${need}:1`);
  }
  for (const p of colorPairs.forbidden) {
    needToken(p.foreground, 'rules/color-pairs.json (forbidden)');
    needToken(p.background, 'rules/color-pairs.json (forbidden)');
  }
  const copy = readJson(path.join(dir, 'rules', 'copy.json'));
  const adRules = readJson(path.join(dir, 'rules', 'ad-slots.json'));
  const adSlots = (adRules.allowed as string[]).map(slotId => {
    const base = sharedSlots.find(s => s.id === slotId);
    if (!base) {
      fail(`${id}/rules/ad-slots.json: unknown slot "${slotId}"`);
      return undefined;
    }
    return { ...base, brand: deepMerge(adRules.defaults, adRules.overrides?.[slotId] ?? {}) };
  }).filter(Boolean) as AdSlot[];
  for (const s of adSlots) {
    for (const bg of s.brand?.backgrounds ?? []) needToken(bg, `rules/ad-slots.json backgrounds`);
    if (!meta.logos.some(l => l.id === s.brand?.logo)) fail(`${id}: slot ${s.id} uses unknown logo "${s.brand?.logo}"`);
  }

  // logos
  const logos = meta.logos.map(l => {
    const file = path.join(dir, l.file);
    if (!fs.existsSync(file)) fail(`${id}: logo file ${l.file} missing`);
    for (const bg of l.backgrounds) needToken(bg, `brand.json logo ${l.id}`);
    return { ...l, svg: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  });
  for (const c of meta.visual?.requiredColors ?? []) needToken(c, 'brand.json visual.requiredColors');

  brands[id] = {
    meta,
    tokens,
    dtcg,
    outputs: outputs as BrandBundle['outputs'],
    guidelines: readGuidelines(id),
    rules: { colorPairs, copy, adSlots, formats: sharedFormats },
    logos,
  };
}

if (problems.length) {
  console.error(`Brand repo has ${problems.length} problem(s):\n- ` + problems.join('\n- '));
  process.exit(1);
}
fs.mkdirSync(path.dirname(GENERATED_FILE), { recursive: true });
fs.writeFileSync(GENERATED_FILE, JSON.stringify({ generatedFrom: 'brands/', brands }) + '\n');
console.log(`bundled ${Object.keys(brands).length} brands -> ${path.relative(process.cwd(), GENERATED_FILE)}`);
