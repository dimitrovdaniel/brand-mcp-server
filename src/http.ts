/**
 * The whole HTTP surface as one web-standard fetch handler, so the same code runs on Node
 * (src/node.ts), Vercel (api/index.ts) and any fetch runtime:
 *
 *   POST/GET/DELETE  /mcp                                     MCP Streamable HTTP (bearer token)
 *   GET              /.well-known/oauth-protected-resource/mcp  RFC 9728 metadata
 *   GET              /.well-known/oauth-authorization-server   mirror of the IdP metadata
 *   GET              /healthz                                   liveness + brand list
 */
import type { JWTVerifyGetKey } from 'jose';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
  type OAuthMetadata,
} from '@modelcontextprotocol/server';
import { createVerifier, discover, loadAuthConfig, remoteKeys, type AuthConfig } from './auth.js';
import { BRAND_IDS } from './data.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export interface AppOptions {
  env?: Record<string, string | undefined>;
  /** Tests inject a local key set and metadata instead of discovering a real IdP. */
  keys?: JWTVerifyGetKey;
  oauthMetadata?: OAuthMetadata;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  config: AuthConfig;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const csv = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const env = opts.env ?? process.env;
  const config = loadAuthConfig(env);
  const handler = createMcpHandler(() => createServer());
  const mcpPath = config.resourceUrl.pathname;
  const allowedHosts = csv(env.ALLOWED_HOSTS).map(h => h.toLowerCase());
  const allowedOrigins = csv(env.ALLOWED_ORIGINS);

  let gate: ((r: Request) => Promise<import('@modelcontextprotocol/server').AuthInfo | Response>) | undefined;
  let metadata: OAuthMetadata | undefined;
  if (config.mode === 'oidc') {
    const discovered = opts.oauthMetadata ?? (await discover(config.issuer!));
    metadata = discovered;
    const keys = opts.keys ?? remoteKeys(config.jwksUri ?? String(discovered.jwks_uri));
    gate = requireBearerAuth({
      verifier: createVerifier(config, keys),
      requiredScopes: config.requiredScopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
      expectedResource: config.resourceUrl,
    });
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, brands: BRAND_IDS, auth: config.mode });
    if (metadata) {
      const meta = oauthMetadataResponse(request, {
        oauthMetadata: metadata,
        resourceServerUrl: config.resourceUrl,
        scopesSupported: config.scopesSupported,
        resourceName: 'Brand MCP server',
        dangerouslyAllowInsecureIssuerUrl: env.NODE_ENV === 'test',
      });
      if (meta) return meta;
    }
    if (url.pathname === '/' && request.method === 'GET') return json({ name: SERVER_NAME, mcp: config.resourceUrl.href, auth: config.mode, docs: 'https://github.com/dimitrovdaniel/brand-mcp-server' });
    if (url.pathname !== mcpPath) return json({ error: 'not_found' }, 404);

    // DNS-rebinding guard. Fetch runtimes may not expose Host as a header; the request URL carries it then.
    if (allowedHosts.length) {
      const host = (request.headers.get('host') ?? url.host).replace(/:\d+$/, '').toLowerCase();
      if (!allowedHosts.includes(host)) return json({ error: 'forbidden', error_description: `Host ${host} is not allowed` }, 403);
    }
    const rejected = allowedOrigins.length ? originValidationResponse(request, allowedOrigins) : undefined;
    if (rejected) return rejected;
    if (!gate) return handler.fetch(request);
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
  }

  return { fetch, close: () => handler.close(), config };
}
