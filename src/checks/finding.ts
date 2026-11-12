export type Severity = 'error' | 'warning' | 'info';

/** One problem found by a check tool. Every check tool returns a list of these. */
export interface Finding {
  /** Stable rule id, e.g. "copy.forbidden-term". Evals and CI assert on it. */
  rule: string;
  severity: Severity;
  message: string;
  /** Where it was found: a line number, CSS selector or quoted text. */
  where?: string;
  suggestion?: string;
  /** brand:// URI of the guideline or rule this finding is based on. */
  source?: string;
}

export interface CheckReport {
  passed: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
}

export function report(findings: Finding[]): CheckReport {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const errors = findings.filter(f => f.severity === 'error').length;
  return { passed: errors === 0, errors, warnings: findings.filter(f => f.severity === 'warning').length, findings: sorted };
}
