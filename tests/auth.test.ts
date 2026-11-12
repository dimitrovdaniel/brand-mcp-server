/**
 * OAuth resource-server behaviour with a local identity provider: a generated RSA key, a local
 * JWKS, and Entra-ID-shaped tokens (iss, aud, scp, roles).
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandsFromRoles } from '../src/auth.js';
import { createApp, type App } from '../src/http.js';
import { connect } from './helpers.js';

const ISSUER = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
const AUDIENCE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const env = {
  NODE_ENV: 'test',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: ISSUER,
  OIDC_AUDIENCE: `${AUDIENCE},api://brand-mcp`,
  OIDC_SCOPES_SUPPORTED: 'api://brand-mcp/Brand.Read',
  MCP_PUBLIC_URL: 'https://brand-mcp.example.com/mcp',
  ALLOWED_HOSTS: 'brand-mcp.example.com',
};
const oauthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER.replace('/v2.0', '')}/oauth2/v2.0/authorize`,
  token_endpoint: `${ISSUER.replace('/v2.0', '')}/oauth2/v2.0/token`,
  response_types_supported: ['code'],
  jwks_uri: `${ISSUER.replace('/v2.0', '')}/discovery/v2.0/keys`,
};

let privateKey: CryptoKey, otherKey: CryptoKey, jwks: { keys: JWK[] };
let app: App;

const token = (claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; exp?: string } = {}) =>
  new SignJWT({ scp: 'Brand.Read', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience((claims.aud as string) ?? AUDIENCE)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  app = await createApp({ env, keys: createLocalJWKSet(jwks), oauthMetadata });
});
afterAll(async () => app.close());

const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const post = (headers: Record<string, string> = {}) =>
  app.fetch(new Request('https://brand-mcp.example.com/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) }));

describe('OAuth resource server', () => {
  it('answers 401 with a resource_metadata challenge when there is no token', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://brand-mcp.example.com/.well-known/oauth-protected-resource/mcp"');
  });

  it('publishes RFC 9728 protected resource metadata pointing at the IdP', async () => {
    const res = await app.fetch(new Request('https://brand-mcp.example.com/.well-known/oauth-protected-resource/mcp'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: 'https://brand-mcp.example.com/mcp', authorization_servers: [ISSUER], scopes_supported: ['api://brand-mcp/Brand.Read'] });
  });

  it('accepts a valid token', async () => {
    expect((await post({ authorization: `Bearer ${await token()}` })).status).toBe(200);
  });

  it('accepts the App ID URI audience too', async () => {
    expect((await post({ authorization: `Bearer ${await token({ aud: 'api://brand-mcp' })}` })).status).toBe(200);
  });

  it.each([
    ['a token for another API', async () => token({ aud: 'api://something-else' })],
    ['an expired token', async () => token({}, { exp: '-5m' })],
    ['a token signed by another key', async () => token({}, { key: otherKey })],
    ['garbage', async () => 'not.a.jwt'],
  ])('rejects %s with 401', async (_name, make) => {
    const res = await post({ authorization: `Bearer ${await make()}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('answers 403 insufficient_scope when the scope is missing', async () => {
    const res = await post({ authorization: `Bearer ${await token({ scp: 'User.Read' })}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const res = await app.fetch(new Request('https://evil.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(init) }));
    expect(res.status).toBe(403);
  });
});

describe('per-brand access from app roles', () => {
  it('maps roles to brands', () => {
    expect(brandsFromRoles(['Brand.All'], false)).toEqual(['*']);
    expect(brandsFromRoles(['Brand.Kiesel', 'Something.Else'], false)).toEqual(['kiesel']);
    expect(brandsFromRoles(undefined, false)).toBeUndefined();
    expect(brandsFromRoles(undefined, true)).toEqual([]);
  });

  it('lets a Kiesel-only user read Kiesel but not Sonnfeld', async () => {
    const t = await token({ roles: ['Brand.Kiesel'] });
    const s = await connect({ env, keys: createLocalJWKSet(jwks), oauthMetadata }, { authorization: `Bearer ${t}` });
    try {
      expect((await s.call('get_brand', { brand: 'kiesel' })).isError).toBe(false);
      const denied = await s.call('get_brand', { brand: 'sonnfeld' });
      expect(denied.isError).toBe(true);
      expect(denied.data).toContain('no access');
    } finally {
      await s.close();
    }
  });
});

describe('configuration safety', () => {
  it('refuses anonymous mode in production unless explicitly allowed', async () => {
    await expect(createApp({ env: { NODE_ENV: 'production' } })).rejects.toThrow(/AUTH_MODE=none in production/);
    await expect(createApp({ env: { NODE_ENV: 'production', ALLOW_ANONYMOUS: 'true' } })).resolves.toBeDefined();
  });
  it('needs an audience in OIDC mode', async () => {
    await expect(createApp({ env: { AUTH_MODE: 'oidc', OIDC_ISSUER: ISSUER } })).rejects.toThrow(/OIDC_AUDIENCE/);
  });
});
