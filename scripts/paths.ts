import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRANDS_DIR = path.join(ROOT, 'brands');
export const BUILD_DIR = path.join(ROOT, 'build');
export const GENERATED_FILE = path.join(ROOT, 'src', 'generated', 'brand-data.json');

/** Every folder under brands/ with a brand.json; folders starting with "_" hold shared rules. */
export function listBrandIds(): string[] {
  return fs
    .readdirSync(BRANDS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(BRANDS_DIR, d.name, 'brand.json')))
    .map(d => d.name)
    .sort();
}

export const readJson = <T = any>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));
export const readBrandMeta = (id: string) => readJson(path.join(BRANDS_DIR, id, 'brand.json'));
