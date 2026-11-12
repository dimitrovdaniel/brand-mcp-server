/** Copy check: forbidden terms, form of address, brand-name spelling, punctuation, disclaimers, length. */
import type { AdSlot, BrandBundle } from '../types.js';
import type { Finding } from './finding.js';

export interface CopyInput {
  text: string;
  /** What the text is; drives length limits. */
  kind?: 'headline' | 'body' | 'cta' | 'any';
  /** Ad slot id, for the headline length limit. */
  slot?: string;
}

const L = '\\p{L}\\p{N}';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Term as regex: whole word(s), any whitespace (or none) around "%" and between words. */
const termRegex = (term: string, flags = 'giu', inflect = true) => {
  const body = escape(term).replace(/\\ /g, ' ').replace(/ %/g, '\\s*%').replace(/ /g, '[\\s\\u00a0-]+');
  // German adjectives and nouns inflect: "gesund" must also catch "gesunde", "gesunden" …
  const suffix = inflect && /\p{L}$/u.test(term) ? '(?:e|en|er|es|em|n|s)?' : '';
  return new RegExp(`(?<![${L}])${body}${suffix}(?![${L}])`, flags);
};

const DU_FORMS = ['du', 'dich', 'dir', 'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines', 'euch', 'euer', 'eure', 'euren', 'eurem'];
const SIE_FORMS = ['Sie', 'Ihnen', 'Ihr', 'Ihre', 'Ihren', 'Ihrem', 'Ihrer', 'Ihres'];

/** Blank out URLs and e-mail addresses (same length) so spellings inside them are not flagged. */
const maskLinks = (t: string) => t.replace(/\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\w+/g, m => ' '.repeat(m.length));

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const quote = (text: string, index: number, len: number) => `line ${lineOf(text, index)}: “${text.slice(index, index + len)}”`;

export function checkCopy(b: BrandBundle, input: CopyInput, slot?: AdSlot): Finding[] {
  const rules = b.rules.copy;
  const text = input.text;
  const masked = maskLinks(text);
  const out: Finding[] = [];
  const src = `brand://${b.meta.id}/rules/copy`;

  // forbidden terms; a match inside a longer forbidden match (Milch in Hafermilch) is reported once
  const taken: [number, number][] = [];
  const hits: [number, Finding][] = [];
  const terms = [...rules.forbidden].sort((x, y) => y.term.length - x.term.length);
  for (const f of terms) {
    for (const m of masked.matchAll(termRegex(f.term))) {
      const s = m.index!, e = s + m[0].length;
      if (taken.some(([a, z]) => s >= a && e <= z)) continue;
      taken.push([s, e]);
      hits.push([s, { rule: 'copy.forbidden-term', severity: f.severity, message: `“${m[0]}”: ${f.reason}`, where: quote(text, s, m[0].length), suggestion: f.suggestion, source: src }]);
    }
  }
  out.push(...hits.sort((x, y) => x[0] - y[0]).map(h => h[1]));

  // form of address
  if (rules.addressForm === 'sie') {
    for (const m of masked.matchAll(new RegExp(`(?<![${L}])(${DU_FORMS.join('|')})(?![${L}])`, 'giu'))) {
      out.push({ rule: 'copy.address-form', severity: 'error', message: `${b.meta.name} addresses readers with “Sie”, not “du”.`, where: quote(text, m.index!, m[0].length), suggestion: 'Rewrite with Sie / Ihnen / Ihr.', source: src });
    }
  } else {
    // capitalised Sie-forms that are not at the start of a sentence are formal address
    for (const m of masked.matchAll(new RegExp(`(?<![${L}])(${SIE_FORMS.join('|')})(?![${L}])`, 'gu'))) {
      const before = masked.slice(0, m.index!).trimEnd();
      if (before === '' || /[.!?:„“"«»\n]$/.test(before)) continue;
      out.push({ rule: 'copy.address-form', severity: 'error', message: `${b.meta.name} addresses readers with “du”, not “Sie”.`, where: quote(text, m.index!, m[0].length), suggestion: 'Rewrite with du / dich / dein.', source: src });
    }
  }

  // brand name spelling (case-sensitive: "HAFERGLÜCK" is wrong in running text)
  for (const wrong of rules.brandName.wrong) {
    for (const m of masked.matchAll(termRegex(wrong, 'gu', false))) {
      if (m[0] === rules.brandName.correct) continue;
      out.push({ rule: 'copy.brand-name', severity: 'error', message: `Write the brand name as “${rules.brandName.correct}”.`, where: quote(text, m.index!, m[0].length), suggestion: rules.brandName.correct, source: src });
    }
  }

  const bangs = (text.match(/!/g) ?? []).length;
  if (bangs > rules.maxExclamationMarks) {
    out.push({ rule: 'copy.exclamation-marks', severity: 'warning', message: `${bangs} exclamation mark(s); ${b.meta.name} allows ${rules.maxExclamationMarks}.`, suggestion: 'Remove exclamation marks.', source: src });
  }

  // mandatory sentences (e.g. biocide disclaimer)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const d of rules.requiredDisclaimers) {
    const trigger = d.whenAny.find(k => norm(masked).includes(k.toLowerCase()));
    if (trigger && !norm(text).includes(norm(d.text))) {
      out.push({ rule: 'copy.required-disclaimer', severity: 'error', message: `Mentions “${trigger}”, so the text must include: “${d.text}” (${d.reason})`, suggestion: d.text, source: src });
    }
  }

  for (const p of rules.preferred) {
    for (const m of masked.matchAll(termRegex(p.avoid))) {
      out.push({ rule: 'copy.preferred-wording', severity: 'info', message: `Prefer “${p.use}” over “${m[0]}”: ${p.reason}`, where: quote(text, m.index!, m[0].length), suggestion: p.use, source: src });
    }
  }

  const len = [...text.trim()].length;
  if (input.kind === 'headline' && slot && len > slot.headlineMaxChars) {
    out.push({ rule: 'copy.length', severity: 'error', message: `Headline has ${len} characters; ${slot.name} allows ${slot.headlineMaxChars}.`, source: `brand://${b.meta.id}/rules/ad-slots` });
  }
  if (input.kind === 'cta') {
    if (len > rules.cta.maxChars) out.push({ rule: 'copy.length', severity: 'error', message: `CTA has ${len} characters; at most ${rules.cta.maxChars}.`, suggestion: rules.cta.labels.join(' / '), source: src });
    if (!rules.cta.labels.some(l => norm(l) === norm(text))) out.push({ rule: 'copy.cta-label', severity: 'info', message: `Not one of the standard CTA labels.`, suggestion: rules.cta.labels.join(' / '), source: src });
  }
  return out;
}
