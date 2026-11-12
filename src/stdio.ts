/** Local stdio entry point, for running the server as a child process of Claude Desktop, Cursor or VS Code. */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

void serveStdio(createServer);
console.error('brand MCP server running on stdio');
