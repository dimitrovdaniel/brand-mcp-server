/** Small BM25 index over guideline sections. German and English, no dependencies. */
import type { GuidelineSection } from '../types.js';

const STOP = new Set(
  'der die das und oder ein eine einer eines nicht mit für von zu im in am an auf ist sind wir ihr sie du es als auch nur bei wie the a an and or of to in on for is are be with as at by it this that what which how do does can should use'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[^a-z0-9%]+/)
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Light suffix stripping so "colours"/"colour", "Logos"/"Logo", "Anzeigen"/"Anzeige" meet. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ['ungen', 'ingen', 'ing', 'es', 'en', 'er', 'e', 's']) if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w.replace(/our$/, 'or');
}

/** German query words → the English words the guidelines use (and back), so either language finds a section. */
const SYNONYMS: Record<string, string[]> = {
  farbe: ['colour', 'color'], farben: ['colour', 'color'], schrift: ['typeface', 'font', 'type'], schriftart: ['typeface', 'font'],
  abstand: ['clear', 'space', 'spacing'], schutzraum: ['clear', 'space'], schutzzone: ['clear', 'space', 'safe', 'zone'],
  groesse: ['size'], mindestgroesse: ['minimum', 'size'], hintergrund: ['background'], bild: ['photography', 'image', 'imagery'], bilder: ['photography', 'imagery'], foto: ['photography'],
  anrede: ['address', 'du', 'sie'], ton: ['tone', 'voice'], tonalitaet: ['tone', 'voice'], sprache: ['voice', 'copy', 'words'], text: ['copy'], texte: ['copy'],
  werbung: ['advertising', 'ad', 'ads'], anzeige: ['ad', 'advertising'], anzeigen: ['ads', 'advertising'], banner: ['display', 'ad'], format: ['format', 'slot'], formate: ['formats', 'slots'],
  desinfektion: ['disinfectant', 'disinfectants', 'biocide', 'biocidal'], desinfektionsmittel: ['disinfectant', 'biocidal'], biozid: ['biocide', 'biocidal'],
  pflichttext: ['mandatory', 'sentence', 'legal', 'disclaimer'], pflichthinweis: ['mandatory', 'legal'], recht: ['legal', 'law'], rechtlich: ['legal', 'law'],
  verboten: ['never', 'not', 'allowed', 'don'], erlaubt: ['allowed'], ausrufezeichen: ['exclamation', 'marks'], platzierung: ['placement'], raster: ['grid', 'layout'],
  barrierefreiheit: ['accessibility'], kontrast: ['contrast'], animation: ['animation'], zielgruppe: ['audience'], versprechen: ['promise'], persoenlichkeit: ['personality'],
  sonnenschutz: ['sun', 'protection', 'sunscreen'], lichtschutzfaktor: ['spf'], lsf: ['spf'], milch: ['milk'], gesund: ['health', 'claim'],
};

function expand(query: string): string[] {
  const raw = query.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').split(/[^a-z0-9%]+/).filter(Boolean);
  const extra = raw.flatMap(w => SYNONYMS[w] ?? []);
  return [...new Set([...tokenize(query), ...tokenize(extra.join(' '))])];
}

export interface SearchHit {
  section: GuidelineSection;
  score: number;
}

export class GuidelineIndex {
  private docs: { section: GuidelineSection; terms: Map<string, number>; len: number }[];
  private df = new Map<string, number>();
  private avgLen: number;

  constructor(sections: GuidelineSection[]) {
    this.docs = sections.map(section => {
      // the heading and page title count three times: they say what the section is about
      const words = [...tokenize(`${section.pageTitle} ${section.heading} `.repeat(3)), ...tokenize(section.text)];
      const terms = new Map<string, number>();
      for (const w of words) terms.set(w, (terms.get(w) ?? 0) + 1);
      return { section, terms, len: words.length };
    });
    for (const d of this.docs) for (const t of d.terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, limit = 5): SearchHit[] {
    const q = expand(query);
    const N = this.docs.length, k1 = 1.4, b = 0.75;
    return this.docs
      .map(d => {
        let score = 0;
        for (const t of q) {
          const f = d.terms.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
        }
        return { section: d.section, score };
      })
      .filter(h => h.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, limit);
  }
}
