import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp, type AppOptions } from '../src/http.js';

/** A real MCP client talking Streamable HTTP to the real app, in-process (no port). */
export async function connect(opts: AppOptions = { env: { NODE_ENV: 'test' } }, headers: Record<string, string> = {}) {
  const app = await createApp(opts);
  const transport = new StreamableHTTPClientTransport(new URL(app.config.resourceUrl.href), {
    fetch: (url, init) => app.fetch(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } })),
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    app,
    client,
    /** Calls a tool and returns its JSON payload (the first text block, parsed when possible). */
    async call(name: string, args: Record<string, unknown>) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[]).find(c => c.type === 'text')?.text ?? '';
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* plain text */
      }
      return { isError: !!r.isError, data, raw: r };
    },
    async close() {
      await client.close();
      await app.close();
    },
  };
}

export const rules = (report: { findings: { rule: string }[] }) => report.findings.map(f => f.rule);
