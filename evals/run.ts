/**
 * Evaluation runner.
 *
 *   npm run eval                 deterministic tool evals (evals/cases/tools.json + evals/client-cases/*.json)
 *   npm run eval:agent           a Claude model answers evals/cases/questions.json using only the MCP tools
 *
 * Writes evals/results/<suite>.json and a JUnit XML file for CI, and a Markdown summary to
 * $GITHUB_STEP_SUMMARY when it runs in GitHub Actions. Exits 1 when the pass rate is below the
 * threshold (tools: 100 %, agent: EVAL_MIN_PASS, default 0.9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { closeBrowser } from '../src/checks/browser.js';
import { connect } from '../tests/helpers.js';
import * as fixtures from '../tests/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'results');
const suite = process.argv.includes('--agent') ? 'agent' : 'tools';
const skipBrowser = process.argv.includes('--no-browser');

interface Result {
  id: string;
  passed: boolean;
  detail: string;
  ms: number;
}

type Session = Awaited<ReturnType<typeof connect>>;

// ─── tool evals ──────────────────────────────────────────────────────────────

interface ToolCase {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  browser?: boolean;
  expect: { isError?: boolean; passed?: boolean; rules?: string[]; notRules?: string[]; equals?: Record<string, unknown>; includes?: string };
}

const get = (obj: unknown, p: string) => p.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), obj);
/** "@fixture:goodAd" in a case's args is replaced by that HTML fixture. */
const withFixtures = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('@fixture:') ? (fixtures as Record<string, string>)[v.slice(9)] : Array.isArray(v) ? v.map(withFixtures) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withFixtures(x)])) : v;

function loadToolCases(): ToolCase[] {
  const files = [path.join(HERE, 'cases', 'tools.json'), ...listJson(path.join(HERE, 'client-cases'))];
  return files.flatMap(f => (JSON.parse(fs.readFileSync(f, 'utf8')).cases as ToolCase[]).map(c => ({ ...c, id: f.includes('client-cases') ? `client/${c.id}` : c.id })));
}
const listJson = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)) : []);

async function runToolCase(s: Session, c: ToolCase): Promise<Result> {
  const t0 = Date.now();
  const r = await s.call(c.tool, withFixtures(c.args) as Record<string, unknown>);
  const text = (r.raw.content as { type: string; text?: string }[]).filter(x => x.type === 'text').map(x => x.text).join('\n');
  const problems: string[] = [];
  const e = c.expect;
  if (e.isError !== undefined && r.isError !== e.isError) problems.push(`isError ${r.isError}, expected ${e.isError}`);
  if (e.isError !== true && r.isError) problems.push(`tool error: ${text.slice(0, 200)}`);
  if (e.passed !== undefined && r.data?.passed !== e.passed) problems.push(`passed ${r.data?.passed}, expected ${e.passed}`);
  const found: string[] = (r.data?.findings ?? []).map((f: { rule: string }) => f.rule);
  for (const rule of e.rules ?? []) if (!found.includes(rule)) problems.push(`missing finding ${rule} (got ${found.join(', ') || 'none'})`);
  for (const rule of e.notRules ?? []) if (found.includes(rule)) problems.push(`unexpected finding ${rule}`);
  for (const [p, want] of Object.entries(e.equals ?? {})) {
    const got = get(r.data, p);
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${p} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (e.includes && !text.includes(e.includes)) problems.push(`result does not include “${e.includes}”`);
  return { id: c.id, passed: !problems.length, detail: problems.join('; ') || 'ok', ms: Date.now() - t0 };
}

// ─── agent evals ─────────────────────────────────────────────────────────────

interface Question {
  id: string;
  question: string;
  answer: { type: 'exact' | 'includes' | 'regex' | 'oneOf'; value: string | string[] };
}

const norm = (s: string) => s.trim().replace(/^["'„“”]+|["'„“”.]+$/g, '').trim().toLowerCase();
function grade(answer: string, want: Question['answer']): boolean {
  const a = norm(answer);
  switch (want.type) {
    case 'exact':
      return a === norm(String(want.value));
    case 'includes':
      return a.includes(norm(String(want.value)));
    case 'regex':
      return new RegExp(String(want.value), 'i').test(answer.trim());
    case 'oneOf':
      return (want.value as string[]).some(v => a === norm(v) || a.includes(norm(v)));
  }
}

const SYSTEM =
  'You answer questions about brand guidelines. Use the brand tools to look facts up; never guess. ' +
  'When you are done, reply with one final line in the form "ANSWER: <answer>" and nothing after it.';

async function runQuestion(s: Session, anthropic: Anthropic, tools: Anthropic.Tool[], q: Question, model: string): Promise<Result & { toolCalls: string[]; answer: string }> {
  const t0 = Date.now();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: q.question }];
  const toolCalls: string[] = [];
  let finalText = '';
  for (let turn = 0; turn < 10; turn++) {
    const res = await anthropic.messages.create({ model, max_tokens: 4096, system: SYSTEM, tools, messages, thinking: { type: 'adaptive' } } as Anthropic.MessageCreateParamsNonStreaming);
    messages.push({ role: 'assistant', content: res.content });
    finalText = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n');
    if (res.stop_reason !== 'tool_use') break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      toolCalls.push(block.name);
      const r = await s.client.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
      const text = (r.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
      results.push({ type: 'tool_result', tool_use_id: block.id, content: text.slice(0, 20_000), is_error: !!r.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  const answer = finalText.match(/ANSWER:\s*(.+)\s*$/im)?.[1] ?? finalText.trim().split('\n').at(-1) ?? '';
  const passed = grade(answer, q.answer);
  return { id: q.id, passed, detail: passed ? 'ok' : `answered “${answer}”, expected ${JSON.stringify(q.answer.value)}`, ms: Date.now() - t0, toolCalls, answer };
}

// ─── main ────────────────────────────────────────────────────────────────────

function junit(name: string, results: Result[]) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cases = results.map(r => `  <testcase classname="${name}" name="${esc(r.id)}" time="${(r.ms / 1000).toFixed(3)}">${r.passed ? '' : `<failure message="${esc(r.detail)}"/>`}</testcase>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${name}" tests="${results.length}" failures="${results.filter(r => !r.passed).length}">\n${cases}\n</testsuite>\n`;
}

async function main() {
  const s = await connect();
  const results: Result[] = [];
  let threshold = 1;
  try {
    if (suite === 'tools') {
      for (const c of loadToolCases()) {
        if (c.browser && skipBrowser) continue;
        results.push(await runToolCase(s, c));
      }
    } else {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY is not set; skipping the agent eval.');
        return;
      }
      threshold = Number(process.env.EVAL_MIN_PASS ?? 0.9);
      const model = process.env.EVAL_MODEL ?? 'claude-opus-5-5';
      const anthropic = new Anthropic();
      const tools = (await s.client.listTools()).tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
      const questions: Question[] = JSON.parse(fs.readFileSync(path.join(HERE, 'cases', 'questions.json'), 'utf8')).questions;
      for (const q of questions) {
        const r = await runQuestion(s, anthropic, tools, q, model);
        console.log(`${r.passed ? 'PASS' : 'FAIL'} ${q.id}  [${r.toolCalls.join(', ')}]  ${r.passed ? '' : r.detail}`);
        results.push(r);
      }
    }
  } finally {
    await s.close();
    await closeBrowser();
  }

  const passed = results.filter(r => r.passed).length;
  const rate = results.length ? passed / results.length : 1;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${suite}.json`), JSON.stringify({ suite, passed, total: results.length, rate, results }, null, 2));
  fs.writeFileSync(path.join(OUT, `${suite}.junit.xml`), junit(`eval.${suite}`, results));
  const lines = [`### Eval: ${suite} — ${passed}/${results.length} passed (${Math.round(rate * 100)} %)`, '', '| case | result | detail |', '|---|---|---|', ...results.map(r => `| ${r.id} | ${r.passed ? '✅' : '❌'} | ${r.passed ? '' : r.detail.replace(/\|/g, '\\|')} |`)];
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  for (const r of results.filter(r => !r.passed)) console.error(`FAIL ${r.id}: ${r.detail}`);
  console.log(`${suite}: ${passed}/${results.length} passed`);
  if (rate < threshold) process.exit(1);
}

await main();
