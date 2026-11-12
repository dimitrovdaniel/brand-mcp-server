/**
 * Vercel entry point. vercel.json rewrites every path here; the request keeps its original URL,
 * so /mcp and /.well-known/* are routed by src/http.ts as on Node.
 * The browser-based checks need BROWSER_WS_ENDPOINT or BROWSER_CDP_ENDPOINT on Vercel.
 */
import { createApp, type App } from '../src/http.js';

let app: Promise<App> | undefined;
const handle = async (request: Request) => (await (app ??= createApp())).fetch(request);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
