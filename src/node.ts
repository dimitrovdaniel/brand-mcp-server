/** Node entry point (local, Docker, any VM): `npm start`. */
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { closeBrowser } from './checks/browser.js';
import { createApp } from './http.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
if (host === '127.0.0.1' && !process.env.ALLOWED_HOSTS) process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';

const app = await createApp();
const server = createServer(toNodeHandler({ fetch: app.fetch })).listen(port, host, () => {
  console.error(`brand MCP server on http://${host}:${port}${app.config.resourceUrl.pathname} (auth: ${app.config.mode})`);
});

async function shutdown() {
  server.close();
  await app.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
