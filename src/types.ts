export interface TokenEntry {
  /** Dot path, e.g. "color.action.primary". */
  path: string;
  type: string;
  /** Resolved CSS value (aliases followed). */
  value: string;
  cssVar: string;
  /** Path of the referenced token when this one is an alias. */
  aliasOf?: string;
  /** The DTCG 2025.10 $value as written in the source file. */
  raw: unknown;
  description?: string;
}

export interface LogoSpec {
  id: string;
  file: string;
  use: string;
  backgrounds: string[];
  minWidthPx: number;
  minWidthMm: number;
  /** Clear space as a fraction of the logo height. */
  clearSpace: number;
}

export interface BrandData {
  id: string;
  name: string;
  tokenPrefix: string;
  category: string;
  market: string;
  locale: string;
  summary: string;
  personality: string[];
  fonts: Record<string, { family: string; weights: number[]; source: string; license: string }>;
  logos: LogoSpec[];
  layout: { minBodyFontPx: number; minTapTargetPx: number; maxLineLengthCh: number; gridColumns: number; logoPlacement: string[] };
  visual: { minPaletteCoverage: number; requiredColors: string[] };
}

export interface GuidelineSection {
  /** "<page>/<heading-slug>", e.g. "logo/clear-space". */
  id: string;
  page: string;
  pageTitle: string;
  heading: string;
  text: string;
}

export type PairUsage = 'text' | 'large-text' | 'ui';
export interface ColorPairRules {
  pairs: { foreground: string; background: string; usage: PairUsage[]; note?: string }[];
  forbidden: { foreground: string; background: string; reason: string }[];
}

export interface CopyRules {
  addressForm: 'du' | 'sie';
  brandName: { correct: string; wrong: string[] };
  maxExclamationMarks: number;
  forbidden: { term: string; severity: 'error' | 'warning'; reason: string; suggestion: string }[];
  requiredDisclaimers: { id: string; whenAny: string[]; text: string; reason: string }[];
  preferred: { avoid: string; use: string; reason: string }[];
  cta: { labels: string[]; maxChars: number };
}

export interface AdSlot {
  id: string;
  name: string;
  channel: string;
  width: number;
  height: number;
  fileTypes: string[];
  maxInitialLoadKb?: number;
  maxFileSizeMb?: number;
  maxAnimationSeconds?: number;
  maxLoops?: number;
  safeZone: { top: number; right: number; bottom: number; left: number };
  headlineMaxChars: number;
  ctaRequired: boolean;
  borderRequiredOnLightBackground?: boolean;
  textCoverageMax?: number;
  minFontPx?: number;
  /** Brand defaults merged with the brand's per-slot override. */
  brand?: { logo: string; logoMinWidthPx: number; logoPlacement: string[]; backgrounds: string[] };
}

export interface Format {
  id: string;
  name: string;
  channel: string;
  width: number;
  height: number;
  unit: 'px' | 'mm';
  [k: string]: unknown;
}

export interface BrandBundle {
  meta: BrandData;
  tokens: TokenEntry[];
  /** Merged DTCG 2025.10 source, as exported from Figma. */
  dtcg: Record<string, unknown>;
  outputs: { css: string; scss: string; js: string };
  guidelines: GuidelineSection[];
  rules: { colorPairs: ColorPairRules; copy: CopyRules; adSlots: AdSlot[]; formats: Format[] };
  logos: (LogoSpec & { svg: string })[];
}
