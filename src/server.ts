/**
 * The brand MCP server: 12 tools, brand:// resources and 3 review prompts.
 *
 * Tool design: a few broad tools that each answer a whole question an agent has ("what are the
 * colours?", "is this ad OK?") rather than one tool per data file. Every tool takes `brand`.
 * Read tools are read-only and idempotent; check tools never change anything either.
 */
import { McpServer, ResourceTemplate, type AuthInfo } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { checkAdSpec, findSlot } from './checks/ad-spec.js';
import { BrowserUnavailable, UrlNotAllowed } from './checks/browser.js';
import { checkCode } from './checks/code.js';
import { allowedForegrounds, checkPairs } from './checks/contrast.js';
import { checkCopy } from './checks/copy.js';
import { report, type Finding } from './checks/finding.js';
import { checkAdHtml, checkPage, checkVisual } from './checks/render.js';
import { BRAND_IDS, BrandError, colorTokens, getBrand, isPrimitive, resolveColor } from './data.js';
import { deltaE, parseColor } from './lib/color.js';
import { GuidelineIndex } from './lib/search.js';
import type { BrandBundle, TokenEntry } from './types.js';

export const SERVER_NAME = 'brand-mcp-server';
export const SERVER_VERSION = '1.0.0';

const brandParam = z.enum(BRAND_IDS).describe(`Brand id: ${BRAND_IDS.map(id => `${id} (${getBrand(id).meta.name})`).join(', ')}`);
const indexes = new Map<string, GuidelineIndex>();
const indexFor = (b: BrandBundle) => indexes.get(b.meta.id) ?? indexes.set(b.meta.id, new GuidelineIndex(b.guidelines)).get(b.meta.id)!;

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const CHECK = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource_link'; uri: string; name: string; mimeType?: string };
const ok = (data: unknown, extra: Content[] = []) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }, ...extra],
  ...(typeof data === 'object' && data !== null && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
});
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** Per-brand access from the token's roles (see auth.ts). Undefined = no restriction (local/stdio). */
function allowedBrands(auth?: AuthInfo): string[] | undefined {
  const b = auth?.extra?.brands;
  return Array.isArray(b) ? (b as string[]) : undefined;
}

/** Wraps a handler: brand access, readable errors instead of protocol failures. */
function guarded<A extends { brand: string }>(fn: (b: BrandBundle, args: A) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>) {
  return async (args: A, ctx: { http?: { authInfo?: AuthInfo } }) => {
    try {
      const allowed = allowedBrands(ctx?.http?.authInfo);
      if (allowed && !allowed.includes('*') && !allowed.includes(args.brand)) return fail(`Your account has no access to brand "${args.brand}". You can use: ${allowed.join(', ') || 'none'}.`);
      return await fn(getBrand(args.brand), args);
    } catch (e) {
      if (e instanceof BrandError || e instanceof BrowserUnavailable || e instanceof UrlNotAllowed) return fail(e.message);
      throw e;
    }
  };
}

const tokenView = (t: TokenEntry) => ({ path: t.path, type: t.type, value: t.value, cssVar: t.cssVar, ...(t.aliasOf ? { aliasOf: t.aliasOf } : {}), ...(t.description ? { description: t.description } : {}) });

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Brand MCP server' },
    {
      instructions:
        `Brand rules, design tokens, logos and ad formats for ${BRAND_IDS.map(id => getBrand(id).meta.name).join(', ')}. ` +
        'Start with get_brand. Use semantic tokens (color.text.default, color.action.primary …), never hex values or primitives. ' +
        'Before handing work back, run the matching check tool (check_code for code, check_copy for German copy, check_ad for ads, check_page and check_visual for rendered pages) and fix every error.',
      maxToolInputElements: 10_000,
    },
  );

  // ─── read tools ────────────────────────────────────────────────────────────────

  server.registerTool(
    'get_brand',
    {
      title: 'Brand overview',
      description: 'Start here. Summary, personality, form of address, fonts, key colours (semantic tokens), logo versions, approved colour pairs, booked ad slots and the list of guideline sections for one brand.',
      inputSchema: z.object({ brand: brandParam }),
      annotations: READ,
    },
    guarded(b => {
      const sem = b.tokens.filter(t => t.type === 'color' && !isPrimitive(t));
      return ok({
        brand: b.meta.id,
        name: b.meta.name,
        category: b.meta.category,
        summary: b.meta.summary,
        personality: b.meta.personality,
        addressForm: b.rules.copy.addressForm,
        fonts: b.meta.fonts,
        colors: Object.fromEntries(sem.map(t => [t.path, t.value])),
        approvedColorPairs: b.rules.colorPairs.pairs.map(p => `${p.foreground} on ${p.background} [${p.usage.join(', ')}]`),
        logos: b.meta.logos.map(l => ({ id: l.id, use: l.use, minWidthPx: l.minWidthPx, uri: `brand://${b.meta.id}/logos/${l.id}` })),
        layout: b.meta.layout,
        adSlots: b.rules.adSlots.map(s => `${s.id} ${s.width}×${s.height}`),
        guidelineSections: b.guidelines.map(g => g.id),
        resources: [`brand://${b.meta.id}/overview`, `brand://${b.meta.id}/tokens/css`, `brand://${b.meta.id}/guidelines/{page}`, `brand://${b.meta.id}/rules/{name}`],
      });
    }),
  );

  server.registerTool(
    'get_tokens',
    {
      title: 'Design tokens',
      description:
        'Design tokens for a brand. format "list" (default) returns path, value and CSS variable per token; "css", "scss", "js" return the Style Dictionary build; "dtcg" returns the DTCG 2025.10 source. Filter with group (e.g. "color", "color.action", "typography", "space", "radius"). Semantic tokens only unless includePrimitives is true.',
      inputSchema: z.object({
        brand: brandParam,
        group: z.string().optional().describe('Token path prefix, e.g. "color", "color.text", "font", "typography", "space", "radius", "motion"'),
        format: z.enum(['list', 'css', 'scss', 'js', 'dtcg']).default('list'),
        includePrimitives: z.boolean().default(false).describe('Include the raw palette (color.primitive.*). Product code should not use these.'),
      }),
      annotations: READ,
    },
    guarded((b, { group, format, includePrimitives }) => {
      if (format === 'css' || format === 'scss' || format === 'js') {
        if (!group) return ok(b.outputs[format]);
        const sel = b.tokens.filter(t => t.path.startsWith(group)).map(t => t.cssVar.slice(2));
        const lines = b.outputs[format].split('\n').filter(l => sel.some(n => l.includes(format === 'js' ? toCamel(n) : n)));
        return ok(lines.join('\n'));
      }
      if (format === 'dtcg') {
        const node = group ? group.split('.').reduce<any>((n, k) => n?.[k], b.dtcg) : b.dtcg;
        return node ? ok(group ? group.split('.').reduceRight<any>((acc, k) => ({ [k]: acc }), node) : node) : fail(`No token group "${group}".`);
      }
      const tokens = b.tokens.filter(t => (!group || t.path === group || t.path.startsWith(group + '.')) && (includePrimitives || !isPrimitive(t)));
      if (!tokens.length) return fail(`No tokens under "${group}". Groups: ${[...new Set(b.tokens.map(t => t.path.split('.')[0]))].join(', ')}.`);
      return ok({ brand: b.meta.id, count: tokens.length, tokens: tokens.map(tokenView) });
    }),
  );

  server.registerTool(
    'find_token',
    {
      title: 'Find the token for a value or name',
      description: 'Reverse lookup. Give a raw value ("#1f4d3a", "rgb(31 77 58)", "16px", "Inter") or part of a token name ("primary", "muted") and get the matching tokens, semantic first. For colours that are not in the palette, returns the nearest tokens with their perceptual distance (ΔE).',
      inputSchema: z.object({ brand: brandParam, query: z.string().min(1).describe('A colour, a size such as 16px, a font name, or part of a token name') }),
      annotations: READ,
    },
    guarded((b, { query }) => {
      const q = query.trim();
      const rgba = parseColor(q);
      if (rgba) {
        const ranked = colorTokens(b)
          .map(p => ({ ...tokenView(p.token), deltaE: Math.round(deltaE(rgba, p.rgba) * 10) / 10 }))
          .sort((x, y) => x.deltaE - y.deltaE || Number(x.path.includes('.primitive.')) - Number(y.path.includes('.primitive.')));
        const exact = ranked.filter(t => t.deltaE === 0);
        return ok({ query: q, exactMatch: exact.length > 0, tokens: (exact.length ? exact : ranked.slice(0, 5)) });
      }
      const lower = q.toLowerCase();
      const byValue = b.tokens.filter(t => t.value.toLowerCase() === lower || t.value.toLowerCase().split(',').map(s => s.trim().replace(/"/g, '')).includes(lower));
      const byName = b.tokens.filter(t => t.path.toLowerCase().includes(lower) || t.cssVar.includes(lower));
      const hits = [...new Set([...byValue, ...byName])].sort((x, y) => Number(isPrimitive(x)) - Number(isPrimitive(y))).slice(0, 15);
      return hits.length ? ok({ query: q, tokens: hits.map(tokenView) }) : fail(`No token matches "${q}". Try get_tokens to browse.`);
    }),
  );

  server.registerTool(
    'search_guidelines',
    {
      title: 'Search brand guidelines',
      description: 'Full-text search over the brand guidelines (German or English query), or read sections directly by id (e.g. "logo/clear-space") or by page ("voice-and-copy"). Returns the section text and its brand:// URI so you can cite it.',
      inputSchema: z.object({
        brand: brandParam,
        query: z.string().optional().describe('What you want to know, e.g. "logo on dark background", "Anrede", "exclamation marks"'),
        section: z.string().optional().describe('A section id such as "logo/clear-space", or a page such as "advertising" to get all its sections'),
        limit: z.number().int().min(1).max(10).default(3),
      }),
      annotations: READ,
    },
    guarded((b, { query, section, limit }) => {
      const view = (g: BrandBundle['guidelines'][number], score?: number) => ({ id: g.id, page: g.pageTitle, heading: g.heading, uri: `brand://${b.meta.id}/guidelines/${g.page}`, ...(score ? { score: Math.round(score * 100) / 100 } : {}), text: g.text });
      if (section) {
        const hits = b.guidelines.filter(g => g.id === section || g.page === section);
        return hits.length ? ok({ sections: hits.map(g => view(g)) }) : fail(`No section "${section}". Sections: ${b.guidelines.map(g => g.id).join(', ')}`);
      }
      if (!query) return fail('Give a query or a section.');
      const hits = indexFor(b).search(query, limit);
      return hits.length ? ok({ query, sections: hits.map(h => view(h.section, h.score)) }) : fail(`Nothing found for "${query}". Pages: ${[...new Set(b.guidelines.map(g => g.page))].join(', ')}`);
    }),
  );

  server.registerTool(
    'get_logo',
    {
      title: 'Logo for a context',
      description: 'Returns the right logo version as SVG with its usage rules (minimum size, clear space, approved backgrounds). Give background (token, CSS variable or colour) to get the version approved for it, or variant to ask for one directly.',
      inputSchema: z.object({
        brand: brandParam,
        variant: z.string().optional().describe('primary, inverse or mark'),
        background: z.string().optional().describe('Where the logo will sit, e.g. "color.surface.brand" or "#1F4D3A"'),
        includeSvg: z.boolean().default(true),
      }),
      annotations: READ,
    },
    guarded((b, { variant, background, includeSvg }) => {
      let candidates = b.logos;
      let note: string | undefined;
      if (background) {
        const bg = resolveColor(b, background);
        if (!bg) return fail(`Cannot read background "${background}".`);
        const fits = b.logos.filter(l => l.backgrounds.some(p => b.tokens.find(t => t.path === p)?.value.toUpperCase() === bg.hex.toUpperCase()));
        if (!fits.length) return fail(`No ${b.meta.name} logo is approved on ${bg.hex}. Approved backgrounds: ${[...new Set(b.logos.flatMap(l => l.backgrounds))].join(', ')}.`);
        candidates = fits;
        if (variant && !fits.some(l => l.id === variant)) note = `“${variant}” is not approved on ${bg.hex}; returning ${fits[0].id} instead.`;
      }
      const logo = candidates.find(l => l.id === variant) ?? candidates[0];
      if (!logo) return fail(`No logo "${variant}". Versions: ${b.logos.map(l => l.id).join(', ')}.`);
      return ok(
        {
          brand: b.meta.id,
          variant: logo.id,
          ...(note ? { note } : {}),
          use: logo.use,
          minWidthPx: logo.minWidthPx,
          minWidthMm: logo.minWidthMm,
          clearSpace: `${logo.clearSpace} × logo height on every side`,
          approvedBackgrounds: logo.backgrounds,
          uri: `brand://${b.meta.id}/logos/${logo.id}`,
          ...(includeSvg ? { svg: logo.svg } : {}),
        },
        [{ type: 'resource_link', uri: `brand://${b.meta.id}/logos/${logo.id}`, name: `${b.meta.name} logo (${logo.id})`, mimeType: 'image/svg+xml' }],
      );
    }),
  );

  server.registerTool(
    'get_ad_specs',
    {
      title: 'Ad slots and formats',
      description: 'Specs for the ad slots a brand books (size, file types, weight limit, animation, safe zone, headline length, CTA, logo version and minimum size, approved backgrounds) and for organic/print formats. Filter by slot id or channel (display, social, dooh, web, email, print, ooh).',
      inputSchema: z.object({ brand: brandParam, slot: z.string().optional(), channel: z.string().optional() }),
      annotations: READ,
    },
    guarded((b, { slot, channel }) => {
      const slots = b.rules.adSlots.filter(s => (!slot || s.id === slot) && (!channel || s.channel === channel));
      const formats = slot ? [] : b.rules.formats.filter(f => !channel || f.channel === channel);
      if (!slots.length && !formats.length) {
        const all = getAllSlotIds();
        return fail(slot && all.includes(slot) ? `${b.meta.name} does not book the ${slot} slot. Booked: ${b.rules.adSlots.map(s => s.id).join(', ')}.` : `Nothing matches. Slots: ${b.rules.adSlots.map(s => s.id).join(', ')}.`);
      }
      return ok({ brand: b.meta.id, slots, formats, cta: b.rules.copy.cta });
    }),
  );

  // ─── check tools ───────────────────────────────────────────────────────────────

  server.registerTool(
    'check_contrast',
    {
      title: 'Check colour pairs',
      description: 'Checks foreground/background pairs against WCAG 2.1 AA and the brand’s approved pair list. Colours can be token paths, CSS variables or CSS colours. With only a background, lists the approved foregrounds for it.',
      inputSchema: z.object({
        brand: brandParam,
        pairs: z
          .array(z.object({ foreground: z.string(), background: z.string(), usage: z.enum(['text', 'large-text', 'ui']).default('text').describe('text = body (4.5:1), large-text = 24px+ or 19px bold (3:1), ui = icons and borders (3:1)') }))
          .max(50)
          .optional(),
        background: z.string().optional().describe('List the approved foregrounds for this background instead'),
      }),
      annotations: CHECK,
    },
    guarded((b, { pairs, background }) => {
      if (background && !pairs?.length) {
        const bg = resolveColor(b, background);
        if (!bg) return fail(`Cannot read "${background}".`);
        const list = (['text', 'large-text', 'ui'] as const).map(u => ({ usage: u, foregrounds: [...new Set(allowedForegrounds(b, bg.hex, u).map(p => p.foreground))] }));
        return ok({ background: bg.token?.path ?? bg.hex, approved: list });
      }
      if (!pairs?.length) return fail('Give pairs, or a background.');
      const { results, findings } = checkPairs(b, pairs);
      return ok({ ...report(findings), results });
    }),
  );

  server.registerTool(
    'check_copy',
    {
      title: 'Check German copy',
      description: 'Checks marketing copy against the brand’s copy rules: legally risky or banned terms (e.g. “Hafermilch”, “Sunblocker”, unproven green claims), du/Sie address, brand-name spelling, exclamation marks, mandatory disclaimers (e.g. biocide sentence), CTA labels and headline length for an ad slot.',
      inputSchema: z.object({
        brand: brandParam,
        text: z.string().min(1).max(20_000),
        kind: z.enum(['headline', 'body', 'cta', 'any']).default('any'),
        slot: z.string().optional().describe('Ad slot id, to apply its headline length limit'),
      }),
      annotations: CHECK,
    },
    guarded((b, { text, kind, slot }) => {
      const s = slot ? findSlot(b, slot) : undefined;
      if (slot && !s) return fail(`${b.meta.name} does not book slot "${slot}".`);
      return ok(report(checkCopy(b, { text, kind }, s)));
    }),
  );

  server.registerTool(
    'check_code',
    {
      title: 'Check code for token use',
      description: 'Scans CSS, SCSS, HTML, JSX/TSX or Tailwind classes for hard-coded colours, off-palette colours, primitive or unknown tokens, off-brand fonts and sizes that are not on the scale. Each finding has a line number and the token to use instead.',
      inputSchema: z.object({ brand: brandParam, code: z.string().min(1).max(200_000), filename: z.string().optional() }),
      annotations: CHECK,
    },
    guarded((b, { code }) => ok(report(checkCode(b, code)))),
  );

  server.registerTool(
    'check_ad',
    {
      title: 'Check an ad',
      description:
        'Checks an ad against the slot spec. Give the creative’s facts (size, file type and weight, animation, logo, background, headline, CTA) and/or its HTML5 source. With html, the ad is rendered in a headless browser at slot size and checked for overflow, safe zone, logo size and placement, CTA, fonts, palette, contrast (axe-core) and copy.',
      inputSchema: z.object({
        brand: brandParam,
        slot: z.string().describe('Ad slot id, see get_ad_specs'),
        creative: z
          .object({
            width: z.number().int().optional(),
            height: z.number().int().optional(),
            fileType: z.string().optional(),
            fileSizeKb: z.number().optional(),
            animationSeconds: z.number().optional(),
            loops: z.number().int().optional(),
            headline: z.string().optional(),
            body: z.string().optional(),
            cta: z.string().optional(),
            logoVariant: z.string().optional(),
            logoWidthPx: z.number().optional(),
            logoPlacement: z.string().optional(),
            background: z.string().optional(),
            hasBorder: z.boolean().optional(),
          })
          .default({}),
        html: z.string().max(500_000).optional().describe('HTML5 creative (inline CSS/SVG/data URLs; external requests are blocked)'),
        screenshot: z.boolean().default(false).describe('Return a PNG of the rendered ad'),
      }),
      annotations: CHECK,
    },
    guarded(async (b, { slot, creative, html, screenshot }) => {
      const s = findSlot(b, slot);
      if (!s) return fail(`${b.meta.name} does not book slot "${slot}". Booked: ${b.rules.adSlots.map(x => x.id).join(', ')}.`);
      const findings: Finding[] = checkAdSpec(b, s, creative);
      let shot: string | undefined;
      let initialLoadKb: number | undefined;
      if (html) {
        const r = await checkAdHtml(b, s, html, screenshot);
        findings.push(...r.findings);
        shot = r.screenshot;
        initialLoadKb = r.initialLoadKb;
      }
      const rep = report(dedupe(findings));
      return ok({ slot: s.id, size: `${s.width}×${s.height}`, ...(initialLoadKb !== undefined ? { initialLoadKb } : {}), ...rep }, shot ? [{ type: 'image', data: shot, mimeType: 'image/png' }] : []);
    }),
  );

  server.registerTool(
    'check_page',
    {
      title: 'Check a page or component',
      description:
        'Renders HTML (or an allow-listed https URL) in a headless browser and checks accessibility with axe-core (WCAG 2.1 A/AA), colours against the palette, fonts, text sizes, line length, tap targets, horizontal overflow and logo size. Use viewport to test mobile (e.g. 390×844).',
      inputSchema: z.object({
        brand: brandParam,
        html: z.string().max(1_000_000).optional(),
        url: z.string().optional().describe('https URL on an allow-listed host'),
        viewport: z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(4000) }).default({ width: 1280, height: 800 }),
        screenshot: z.boolean().default(false),
      }),
      annotations: CHECK,
    },
    guarded(async (b, { html, url, viewport, screenshot }) => {
      if (!html === !url) return fail('Give exactly one of html or url.');
      const r = await checkPage(b, { html, url }, viewport, screenshot);
      return ok({ ...report(r.findings), stats: r.stats }, r.screenshot ? [{ type: 'image', data: r.screenshot, mimeType: 'image/png' }] : []);
    }),
  );

  server.registerTool(
    'check_visual',
    {
      title: 'Visual check',
      description: 'Screenshots rendered HTML (or an allow-listed URL) and measures how much of it uses the brand palette, which colours dominate and whether the key brand colours appear. Returns the screenshot so you can also review the composition yourself against the imagery and layout guidelines.',
      inputSchema: z.object({
        brand: brandParam,
        html: z.string().max(1_000_000).optional(),
        url: z.string().optional(),
        viewport: z.object({ width: z.number().int().min(100).max(3840), height: z.number().int().min(50).max(4000) }).default({ width: 1280, height: 800 }),
      }),
      annotations: CHECK,
    },
    guarded(async (b, { html, url, viewport }) => {
      if (!html === !url) return fail('Give exactly one of html or url.');
      const r = await checkVisual(b, { html, url }, viewport);
      return ok({ ...report(r.findings), paletteCoverage: r.paletteCoverage, dominantColors: r.dominant, guidelines: `brand://${b.meta.id}/guidelines/imagery-and-layout` }, [{ type: 'image', data: r.screenshot, mimeType: 'image/png' }]);
    }),
  );

  registerResources(server);
  registerPrompts(server);
  return server;
}

const toCamel = (kebab: string) => kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const getAllSlotIds = () => [...new Set(BRAND_IDS.flatMap(id => getBrand(id).rules.adSlots.map(s => s.id)))];
function dedupe(f: Finding[]) {
  const seen = new Set<string>();
  return f.filter(x => {
    const k = `${x.rule}|${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── resources ─────────────────────────────────────────────────────────────────

function overviewMarkdown(b: BrandBundle) {
  const m = b.meta;
  return [
    `# ${m.name}`,
    m.summary,
    `**Personality:** ${m.personality.join(', ')}  `,
    `**Address:** ${b.rules.copy.addressForm === 'du' ? '“du”' : '“Sie”'}  `,
    `**Fonts:** ${Object.entries(m.fonts).map(([k, f]) => `${k}: ${f.family}`).join(', ')}`,
    '',
    '## Semantic colours',
    ...b.tokens.filter(t => t.type === 'color' && !isPrimitive(t)).map(t => `- \`${t.path}\` ${t.value} (\`var(${t.cssVar})\`)`),
    '',
    '## Guideline sections',
    ...b.guidelines.map(g => `- ${g.pageTitle} › ${g.heading}: brand://${m.id}/guidelines/${g.page}`),
  ].join('\n');
}

function registerResources(server: McpServer) {
  const brands = BRAND_IDS.map(getBrand);
  const read = (uri: URL, mimeType: string, text: string) => ({ contents: [{ uri: uri.href, mimeType, text }] });
  const brandOf = (v: string | string[]) => getBrand(String(v));

  server.registerResource(
    'brand-overview',
    new ResourceTemplate('brand://{brand}/overview', { list: async () => ({ resources: brands.map(b => ({ uri: `brand://${b.meta.id}/overview`, name: `${b.meta.name} overview`, mimeType: 'text/markdown' })) }) }),
    { title: 'Brand overview', description: 'One-page summary of a brand', mimeType: 'text/markdown' },
    async (uri, { brand }) => read(uri, 'text/markdown', overviewMarkdown(brandOf(brand))),
  );

  const TOKEN_FORMATS = { css: 'text/css', scss: 'text/x-scss', js: 'text/javascript', dtcg: 'application/design-tokens+json' } as const;
  server.registerResource(
    'brand-tokens',
    new ResourceTemplate('brand://{brand}/tokens/{format}', {
      list: async () => ({ resources: brands.flatMap(b => Object.entries(TOKEN_FORMATS).map(([f, mime]) => ({ uri: `brand://${b.meta.id}/tokens/${f}`, name: `${b.meta.name} tokens (${f})`, mimeType: mime }))) }),
    }),
    { title: 'Design tokens', description: 'Tokens as CSS variables, SCSS, ES module or DTCG 2025.10 JSON', mimeType: 'text/plain' },
    async (uri, { brand, format }) => {
      const b = brandOf(brand);
      const f = String(format) as keyof typeof TOKEN_FORMATS;
      if (!(f in TOKEN_FORMATS)) throw new BrandError(`Unknown token format "${f}". Use css, scss, js or dtcg.`);
      return read(uri, TOKEN_FORMATS[f], f === 'dtcg' ? JSON.stringify(b.dtcg, null, 2) : b.outputs[f]);
    },
  );

  server.registerResource(
    'brand-guidelines',
    new ResourceTemplate('brand://{brand}/guidelines/{page}', {
      list: async () => ({ resources: brands.flatMap(b => [...new Set(b.guidelines.map(g => g.page))].map(p => ({ uri: `brand://${b.meta.id}/guidelines/${p}`, name: `${b.meta.name}: ${b.guidelines.find(g => g.page === p)!.pageTitle}`, mimeType: 'text/markdown' }))) }),
    }),
    { title: 'Guideline page', description: 'One guideline page as Markdown', mimeType: 'text/markdown' },
    async (uri, { brand, page }) => {
      const b = brandOf(brand);
      const secs = b.guidelines.filter(g => g.page === String(page));
      if (!secs.length) throw new BrandError(`No guideline page "${page}".`);
      return read(uri, 'text/markdown', `# ${secs[0].pageTitle}\n\n` + secs.map(s => `## ${s.heading}\n${s.text}`).join('\n\n'));
    },
  );

  server.registerResource(
    'brand-logo',
    new ResourceTemplate('brand://{brand}/logos/{variant}', { list: async () => ({ resources: brands.flatMap(b => b.logos.map(l => ({ uri: `brand://${b.meta.id}/logos/${l.id}`, name: `${b.meta.name} logo (${l.id})`, mimeType: 'image/svg+xml' }))) }) }),
    { title: 'Logo', description: 'Logo SVG', mimeType: 'image/svg+xml' },
    async (uri, { brand, variant }) => {
      const l = brandOf(brand).logos.find(x => x.id === String(variant));
      if (!l) throw new BrandError(`No logo "${variant}".`);
      return read(uri, 'image/svg+xml', l.svg);
    },
  );

  const RULES = ['color-pairs', 'copy', 'ad-slots', 'formats'] as const;
  server.registerResource(
    'brand-rules',
    new ResourceTemplate('brand://{brand}/rules/{name}', { list: async () => ({ resources: brands.flatMap(b => RULES.map(r => ({ uri: `brand://${b.meta.id}/rules/${r}`, name: `${b.meta.name} rules: ${r}`, mimeType: 'application/json' }))) }) }),
    { title: 'Brand rules', description: 'Machine-readable rules: color-pairs, copy, ad-slots, formats', mimeType: 'application/json' },
    async (uri, { brand, name }) => {
      const b = brandOf(brand);
      const map = { 'color-pairs': b.rules.colorPairs, copy: b.rules.copy, 'ad-slots': b.rules.adSlots, formats: b.rules.formats } as Record<string, unknown>;
      if (!(String(name) in map)) throw new BrandError(`No rules "${name}". Use ${RULES.join(', ')}.`);
      return read(uri, 'application/json', JSON.stringify(map[String(name)], null, 2));
    },
  );
}

// ─── prompts ───────────────────────────────────────────────────────────────────

function registerPrompts(server: McpServer) {
  const brandArg = z.enum(BRAND_IDS).describe('Brand id');
  const msg = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });
  const OUTPUT =
    'Report as a table: severity | rule | where | what is wrong | fix. Cite the brand:// source of each rule. ' +
    'End with a verdict: “Approved”, “Approved with changes” (only warnings) or “Not approved” (any error). Do not invent rules; if a guideline does not cover something, say so.';

  server.registerPrompt(
    'review_ad',
    {
      title: 'Review an ad',
      description: 'Brand review of a display, social or DOOH ad',
      argsSchema: z.object({ brand: brandArg, slot: z.string().describe('Ad slot id'), html: z.string().optional().describe('HTML5 creative'), notes: z.string().optional().describe('Anything else about the creative: file size, animation, the headline') }),
    },
    ({ brand, slot, html, notes }) =>
      msg(
        `Review this ${getBrand(brand).meta.name} ad for the "${slot}" slot.\n\n` +
          `1. Call get_ad_specs (brand "${brand}", slot "${slot}") and search_guidelines (section "advertising").\n` +
          `2. Call check_ad with the facts you know${html ? ' and the HTML below, with screenshot true' : ''}.\n` +
          `3. Call check_copy on the headline, body and CTA separately (kind headline/body/cta).\n` +
          `4. Look at the screenshot for anything the checks cannot see: image choice, hierarchy, one key message.\n\n` +
          OUTPUT +
          (notes ? `\n\nNotes from the requester:\n${notes}` : '') +
          (html ? `\n\nHTML:\n\`\`\`html\n${html}\n\`\`\`` : ''),
      ),
  );

  server.registerPrompt(
    'review_page',
    {
      title: 'Review a page or component',
      description: 'Brand and accessibility review of a web page, landing page or UI component',
      argsSchema: z.object({ brand: brandArg, html: z.string().optional(), url: z.string().optional(), code: z.string().optional().describe('Component source (CSS/TSX) to check for token use') }),
    },
    ({ brand, html, url, code }) =>
      msg(
        `Review this ${getBrand(brand).meta.name} ${url ? `page (${url})` : 'page/component'}.\n\n` +
          `1. Call get_brand ("${brand}").\n` +
          `2. Call check_page at 1280×800 and at 390×844${html || url ? '' : ' (if you have HTML)'}, and check_visual at 1280×800.\n` +
          (code ? `3. Call check_code on the source below.\n` : '') +
          `${code ? 4 : 3}. Check the copy with check_copy.\n` +
          `${code ? 5 : 4}. Compare the screenshot with search_guidelines (page "imagery-and-layout").\n\n` +
          OUTPUT +
          (html ? `\n\nHTML:\n\`\`\`html\n${html}\n\`\`\`` : '') +
          (code ? `\n\nSource:\n\`\`\`\n${code}\n\`\`\`` : ''),
      ),
  );

  server.registerPrompt(
    'review_copy',
    {
      title: 'Review copy',
      description: 'Tone-of-voice and legal-wording review of German marketing copy',
      argsSchema: z.object({ brand: brandArg, text: z.string(), channel: z.string().optional().describe('Where it runs: ad slot id, newsletter, website, social, packaging') }),
    },
    ({ brand, text, channel }) =>
      msg(
        `Review this ${getBrand(brand).meta.name} copy${channel ? ` for ${channel}` : ''}.\n\n` +
          `1. Call check_copy (brand "${brand}"${channel && getBrand(brand).rules.adSlots.some(s => s.id === channel) ? `, slot "${channel}"` : ''}).\n` +
          `2. Call search_guidelines (page "voice-and-copy") and judge tone against it: address form, personality, words we use.\n` +
          `3. Suggest a corrected version that keeps the message.\n\n` +
          OUTPUT +
          `\n\nCopy:\n"""\n${text}\n"""`,
      ),
  );
}
