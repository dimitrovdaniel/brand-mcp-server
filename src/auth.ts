/**
 * OAuth 2.1 resource-server side of the MCP authorization spec.
 *
 * The server never issues tokens. It verifies JWT access tokens from your identity provider
 * (Entra ID, Okta, Auth0, Keycloak …) against the provider's JWKS, checks issuer, audience,
 * expiry and scope, and publishes RFC 9728 Protected Resource Metadata so MCP clients can find
 * the provider. Per-brand access comes from app roles: "Brand.All" or "Brand.<brand-id>".
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

export interface AuthConfig {
  mode: 'oidc' | 'none';
  /** Public URL of the MCP endpoint, e.g. https://brand-mcp.example.com/mcp */
  resourceUrl: URL;
  issuer?: string;
  /** Accepted `aud` values. Entra ID v2 tokens carry the API's client id; v1 tokens its App ID URI. */
  audiences: string[];
  /** Scopes every token needs (Entra: the `scp` short name, e.g. "Brand.Read"). */
  requiredScopes: string[];
  /** Advertised in the metadata so clients know what to request (Entra: "api://<app-id>/Brand.Read"). */
  scopesSupported: string[];
  /** When true, tokens without any Brand.* role see no brand. When false, no roles = all brands. */
  brandRolesRequired: boolean;
  jwksUri?: string;
}

const csv = (v: string | undefined) => (v ?? '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? (env.OIDC_ISSUER ? 'oidc' : 'none')) as AuthConfig['mode'];
  const port = env.PORT ?? '3000';
  const resourceUrl = new URL(env.MCP_PUBLIC_URL ?? `http://localhost:${port}/mcp`);
  if (mode === 'none') {
    const prod = env.NODE_ENV === 'production' || !!env.VERCEL;
    if (prod && env.ALLOW_ANONYMOUS !== 'true') throw new Error('AUTH_MODE=none in production: set OIDC_ISSUER (and OIDC_AUDIENCE), or ALLOW_ANONYMOUS=true for a public read-only server.');
    return { mode, resourceUrl, audiences: [], requiredScopes: [], scopesSupported: [], brandRolesRequired: false };
  }
  if (mode !== 'oidc') throw new Error(`Unknown AUTH_MODE "${mode}"`);
  if (!env.OIDC_ISSUER) throw new Error('AUTH_MODE=oidc needs OIDC_ISSUER, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0');
  const audiences = csv(env.OIDC_AUDIENCE);
  if (!audiences.length) throw new Error('AUTH_MODE=oidc needs OIDC_AUDIENCE (the API app id or App ID URI)');
  const requiredScopes = csv(env.OIDC_REQUIRED_SCOPES ?? 'Brand.Read');
  return {
    mode,
    resourceUrl,
    issuer: env.OIDC_ISSUER.replace(/\/$/, ''),
    audiences,
    requiredScopes,
    scopesSupported: csv(env.OIDC_SCOPES_SUPPORTED) .length ? csv(env.OIDC_SCOPES_SUPPORTED) : requiredScopes,
    brandRolesRequired: env.BRAND_ROLES_REQUIRED === 'true',
    jwksUri: env.OIDC_JWKS_URI,
  };
}

/** Fetches the provider's OpenID configuration once; it is both the AS metadata and the JWKS pointer. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OAuthMetadata & { jwks_uri: string }> {
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const doc = (await res.json()) as OAuthMetadata & { jwks_uri: string };
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error(`OIDC discovery document for ${issuer} is incomplete`);
  return doc;
}

/** Reads the brands a token may use from its roles claim. */
export function brandsFromRoles(roles: unknown, required: boolean): string[] | undefined {
  const list = Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  const brandRoles = list.filter(r => /^brand\./i.test(r));
  if (!brandRoles.length) return required ? [] : undefined;
  if (brandRoles.some(r => /^brand\.all$/i.test(r))) return ['*'];
  return brandRoles.map(r => r.slice(6).toLowerCase());
}

export function createVerifier(cfg: AuthConfig, keys: JWTVerifyGetKey): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, { issuer: cfg.issuer, audience: cfg.audiences, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'], clockTolerance: 60 }));
      } catch (e) {
        const why = e instanceof joseErrors.JWTExpired ? 'token expired' : e instanceof joseErrors.JWTClaimValidationFailed ? `claim "${e.claim}" invalid` : 'signature or format invalid';
        throw new OAuthError(OAuthErrorCode.InvalidToken, why);
      }
      if (typeof payload.exp !== 'number') throw new OAuthError(OAuthErrorCode.InvalidToken, 'token has no exp');
      // Entra ID: delegated scopes in `scp` (space separated); app-only tokens carry `roles` instead.
      const p = payload as JWTPayload & { scp?: string; scope?: string; roles?: unknown; azp?: string; appid?: string; client_id?: string };
      const scopes = [...csv(p.scp), ...csv(p.scope)];
      const appOnly = !p.scp && !p.scope && Array.isArray(p.roles);
      const brands = brandsFromRoles(p.roles, cfg.brandRolesRequired);
      return {
        token,
        clientId: p.azp ?? p.appid ?? p.client_id ?? p.sub ?? 'unknown',
        // app-only (client credentials) tokens have no delegated scopes; a Brand.* app role grants access
        scopes: appOnly && brands?.length ? [...new Set([...scopes, ...cfg.requiredScopes])] : scopes,
        expiresAt: payload.exp,
        // audience was checked against cfg.audiences above; report this server as the resource
        resource: cfg.resourceUrl,
        extra: { subject: p.sub, brands },
      };
    },
  };
}

export const remoteKeys = (jwksUri: string) => createRemoteJWKSet(new URL(jwksUri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
