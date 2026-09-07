// ═══════════════════════════════════════════════════════════════════
// The UniDPP identity service —  (identity-server), deployed
// as identity.unidpp.org.
//
// The actor registry for UniDPP, adapting oimlsmart/identity's proven
// patterns to operator-model §2.2's role model:
//   - register actors (economic operators, installers, repairers,
//     CABs, marketplaces) with catalog-checked roles;
//   - issue scoped API credentials (audience + scope allowlist, the
//     secret shown once, SHA-256 at rest);
//   - mint ES256 access tokens (self-contained, JWKS-verifiable, no
//     call-back) carrying the actor's EN 18239-style role classes;
//   - sign every JSON response (kid + timestamp + ES256 signature
//     headers) — WHAT was said WHEN, with whose key.
//
// Storage: D1. No external dependencies.
// ═══════════════════════════════════════════════════════════════════

import { ActorRepository, actorView, projectionOf, validateActorInput, type ActorRecord } from './actors'
import {
  CredentialRepository,
  credentialIsActive,
  hashSecret,
  newCredentialId,
  newCredentialSecret,
  narrowTokenScopes,
  timingSafeEqual,
  tokenClaims,
  validateCredentialInput,
  type CredentialRecord,
} from './credentials'
import { errorPayload, jsonPayload, toResponse, CORS_HEADERS, type PreparedResponse } from './http'
import { ACTOR_KIND_CATALOG, ACTOR_KINDS } from './roles'
import { jwksDocument, registerKey, resolveSigningKey, signJwt, signResponseBody } from './signing'
import { d1Store } from './store'
import { nowRfc3339 } from './time'

export interface Env {
  DB: D1Database
  /** EC P-256 JWK (kty EC, crv P-256, x, y, d) — the deployment's signing key. */
  IDENTITY_SIGNING_KEY?: string
  /** The bootstrap admin bearer; unset = open (development posture). */
  IDENTITY_ADMIN_TOKEN?: string
  /** The token issuer; defaults to https://identity.unidpp.org. */
  IDENTITY_ISSUER?: string
  /** Access-token lifetime in seconds; default 3600. */
  ACCESS_TOKEN_TTL_SECONDS?: string
}

const SERVICE = 'unidpp-identity'
const VERSION = '0.1.0'
const DEFAULT_ISSUER = 'https://identity.unidpp.org'
const DEFAULT_TTL_SECONDS = 3600

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  env: Env
  actors: ActorRepository
  credentials: CredentialRepository
}

function makeCtx(env: Env): Ctx {
  const store = d1Store(env.DB)
  return {
    env,
    actors: new ActorRepository(store.actors),
    credentials: new CredentialRepository(store.credentials),
  }
}

/** The dev-open admin gate (oimlsmart's pattern: the token unset means
 *  open — a loud development posture, never a production one). */
function isAdmin(ctx: Ctx, request: Request): boolean {
  const expected = ctx.env.IDENTITY_ADMIN_TOKEN
  if (expected === undefined || expected === '') return true
  const header = request.headers.get('Authorization')
  if (header === null) return false
  const match = /^Bearer (.+)$/.exec(header)
  return match !== null && match[1] === expected
}

/** Sign a prepared response: ES256 over `${timestamp}\n${body}`. */
async function respond(ctx: Ctx, prepared: PreparedResponse): Promise<Response> {
  const key = await resolveSigningKey(ctx.env)
  await registerKey(d1Store(ctx.env.DB).signingKeys, key, nowRfc3339())
  const timestamp = nowRfc3339()
  const signature = await signResponseBody(prepared.body, key, timestamp)
  return toResponse(prepared, {
    'X-UNIDPP-Kid': key.kid,
    'X-UNIDPP-Timestamp': timestamp,
    'X-UNIDPP-Signature': signature,
  })
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function discoveryPayload(ctx: Ctx, url: URL): Record<string, unknown> {
  const origin = `${url.protocol}//${url.host}`
  return {
    service: SERVICE,
    version: VERSION,
    profile: 'https://unidpp.org/ns/identity/1.0',
    issuer: ctx.env.IDENTITY_ISSUER ?? DEFAULT_ISSUER,
    endpoints: {
      actors: `${origin}/actors`,
      actor: `${origin}/actors/{id}`,
      credentials: `${origin}/actors/{id}/credentials`,
      token: `${origin}/token`,
      jwks: `${origin}/.well-known/jwks.json`,
      roles: `${origin}/roles`,
    },
    actorKinds: ACTOR_KINDS,
    tokenGrant: {
      grant_type: 'client_credentials',
      authentication: 'HTTP Basic (client_id, client_secret) — RFC 6749 §2.3.1',
      scopeNarrowing: 'RFC 6749 §4.4 scope parameter; never beyond the credential allowlist',
      claims: ['iss', 'sub (actor id)', 'aud', 'client_id', 'iat', 'exp', 'actor {id,kind,name,roles}', 'en18239 [{class,subkind?}]', 'scope'],
    },
    signedResponses: {
      algorithm: 'ES256 (ECDSA P-256, SHA-256)',
      input: '"${timestamp}\\n${body}"',
      headers: ['X-UNIDPP-Kid', 'X-UNIDPP-Timestamp', 'X-UNIDPP-Signature'],
      verification: 'fetch /.well-known/jwks.json, verify with the matching kid',
    },
  }
}

function rolesPayload(): Record<string, unknown> {
  return {
    planOperators: 'https://unidpp.org/plan-operators §2.2 (the acting-rights source)',
    en18239: 'EN 18239:2026 §4 stakeholder classes (the credential class vocabulary)',
    kinds: ACTOR_KINDS.map((kind) => {
      const def = ACTOR_KIND_CATALOG[kind]
      return {
        kind: def.kind,
        description: def.description,
        roles: def.roles.map((role) => ({
          key: role.key,
          planOperators: role.planOperators,
          en18239: role.en18239,
          defaultScopes: role.defaultScopes,
          allowedScopes: role.allowedScopes,
        })),
      }
    }),
  }
}

function credentialView(credential: CredentialRecord): Record<string, unknown> {
  return {
    clientId: credential.id,
    audience: credential.audience,
    scopes: credential.scopes,
    status: credential.status,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateActor(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readJson(request)
  if (body === null) return respond(ctx, errorPayload(400, 'the body must be a JSON object'))
  const { actor, error } = validateActorInput(body)
  if (actor === null || error !== null) return respond(ctx, errorPayload(400, error ?? 'invalid registration'))
  const existing = await ctx.actors.get(actor.id)
  if (existing !== null) return respond(ctx, errorPayload(409, `actor '${actor.id}' is already registered`))
  const created = await ctx.actors.create(actor)
  if (created === null) return respond(ctx, errorPayload(500, 'registration failed'))
  return respond(ctx, jsonPayload(201, actorView(created, projectionOf(created)), { Location: `/actors/${created.id}` }))
}

async function handleIssueCredential(ctx: Ctx, actorId: string, request: Request): Promise<Response> {
  const actor = await ctx.actors.get(actorId)
  if (actor === null) return respond(ctx, errorPayload(404, 'actor not found'))
  if (actor.status !== 'active') return respond(ctx, errorPayload(403, 'a disabled actor admits no new credentials'))
  const body = await readJson(request)
  if (body === null) return respond(ctx, errorPayload(400, 'the body must be a JSON object'))
  const { credential, error } = validateCredentialInput(actor, body)
  if (credential === null || error !== null) return respond(ctx, errorPayload(400, error ?? 'invalid issuance request'))
  const secret = newCredentialSecret()
  const id = newCredentialId()
  const record: CredentialRecord = {
    id,
    actorId: actor.id,
    audience: credential.audience,
    scopes: credential.scopes,
    status: 'active',
    issuedAt: nowRfc3339(),
    expiresAt: credential.expiresAt,
    lastUsedAt: null,
  }
  await ctx.credentials.create(record, await hashSecret(secret))
  const projection = projectionOf(actor)
  return respond(
    ctx,
    jsonPayload(201, {
      ...credentialView(record),
      en18239: projection.en18239Classes,
      clientSecret: secret,
      secretNote: 'shown once — store it now; the database keeps only its SHA-256',
      tokenRequest: {
        method: 'POST',
        endpoint: '/token',
        note: 'HTTP Basic with clientId:clientSecret, grant_type=client_credentials',
      },
    }),
  )
}

interface ClientAuthentication {
  clientId: string | null
  clientSecret: string | null
  grantType: string | null
  scope: string | null
}

async function parseClientAuthentication(request: Request): Promise<[ClientAuthentication, string | null]> {
  const header = request.headers.get('Authorization')
  if (header !== null) {
    const basic = /^Basic (.+)$/.exec(header)
    if (basic !== null) {
      try {
        const decoded = atob(basic[1] ?? '')
        const separator = decoded.indexOf(':')
        if (separator > 0) {
          const params = await bodyParamsOnce(request.clone())
          const grantType = typeof params?.['grant_type'] === 'string' ? (params['grant_type'] as string) : null
          const scope = typeof params?.['scope'] === 'string' ? (params['scope'] as string) : null
          return [
            { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1), grantType, scope },
            null,
          ]
        }
      } catch {
        // fall through to the body
      }
    }
  }
  const text = await request.text()
  if (text.trim() === '') return [{ clientId: null, clientSecret: null, grantType: null, scope: null }, null]
  const contentType = request.headers.get('Content-Type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const str = (name: string): string | null => (typeof parsed[name] === 'string' ? (parsed[name] as string) : null)
      return [
        {
          clientId: str('clientId') ?? str('client_id'),
          clientSecret: str('clientSecret') ?? str('client_secret'),
          grantType: str('grant_type') ?? str('grantType'),
          scope: str('scope'),
        },
        text,
      ]
    } catch {
      return [{ clientId: null, clientSecret: null, grantType: null, scope: null }, null]
    }
  }
  const params = new URLSearchParams(text)
  return [
    { clientId: params.get('client_id'), clientSecret: params.get('client_secret'), grantType: params.get('grant_type'), scope: params.get('scope') },
    text,
  ]
}

/** The Basic-auth path reads the body only for the optional parameters
 *  (the credential rides the header; grant_type/scope may ride either). */
async function bodyParamsOnce(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) return null
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function handleToken(ctx: Ctx, request: Request): Promise<Response> {
  const [auth, bodyForBasic] = await parseClientAuthentication(request)
  if (auth.grantType !== null && auth.grantType !== 'client_credentials') {
    return respond(
      ctx,
      jsonPayload(400, { error: 'unsupported_grant_type', error_description: 'only grant_type=client_credentials is served (the machine-caller cone)' }),
    )
  }
  if (auth.clientId === null || auth.clientSecret === null || auth.clientId === '' || auth.clientSecret === '') {
    return respond(ctx, errorPayload(401, 'client authentication required: HTTP Basic (clientId, clientSecret)'))
  }
  void bodyForBasic
  const credential = await ctx.credentials.findById(auth.clientId)
  if (credential === null || !credentialIsActive(credential, Date.now())) {
    return respond(ctx, errorPayload(401, 'invalid client'))
  }
  const actor: ActorRecord | null = await ctx.actors.get(credential.actorId)
  if (actor === null || actor.status !== 'active') {
    return respond(ctx, errorPayload(403, 'the credential\'s actor is not active'))
  }
  const digest = await hashSecret(auth.clientSecret)
  if (!timingSafeEqual(digest, await storedSecretHash(ctx, credential.id))) {
    return respond(ctx, errorPayload(401, 'invalid client'))
  }
  const { scopes, error } = narrowTokenScopes(credential, auth.scope)
  if (error !== null) {
    return respond(ctx, jsonPayload(400, { error: 'invalid_scope', error_description: error }))
  }
  const key = await resolveSigningKey(ctx.env)
  await registerKey(d1Store(ctx.env.DB).signingKeys, key, nowRfc3339())
  const issuer = ctx.env.IDENTITY_ISSUER ?? DEFAULT_ISSUER
  const ttl = Number(ctx.env.ACCESS_TOKEN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS)
  const claims = tokenClaims(credential.id, actor, credential, projectionOf(actor), scopes, {
    issuer,
    accessTokenTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS,
  })
  const token = await signJwt(claims, key)
  await ctx.credentials.markUsed(credential.id).catch(() => undefined)
  return respond(
    ctx,
    jsonPayload(200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: claims['exp'] as number - (claims['iat'] as number),
      scope: scopes.join(' '),
    }),
  )
}

async function storedSecretHash(ctx: Ctx, credentialId: string): Promise<string> {
  const row = await d1Store(ctx.env.DB)
    .credentials.prepare('SELECT secret_hash FROM credentials WHERE id = ?1')
    .bind(credentialId)
    .first<{ secret_hash: string }>()
  return row?.secret_hash ?? ''
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx = makeCtx(env)
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      // The trust root: unsigned by construction (it IS the verification anchor).
      if (method === 'GET' && path === '/.well-known/jwks.json') {
        const jwks = await jwksDocument(d1Store(env.DB).signingKeys)
        return toResponse(jsonPayload(200, jwks, { 'Cache-Control': 'public, max-age=300' }))
      }

      if (method === 'GET' && path === '/healthz') {
        return new Response('ok', { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } })
      }

      if (method === 'GET' && path === '/') {
        return respond(ctx, jsonPayload(200, discoveryPayload(ctx, url)))
      }

      if (method === 'GET' && path === '/roles') {
        return respond(ctx, jsonPayload(200, rolesPayload()))
      }

      if (path === '/actors') {
        if (!isAdmin(ctx, request)) return respond(ctx, errorPayload(401, 'unauthorized'))
        if (method === 'POST') return handleCreateActor(ctx, request)
        if (method === 'GET') {
          const actors = await ctx.actors.list()
          return respond(ctx, jsonPayload(200, { actors: actors.map((a) => actorView(a, projectionOf(a))) }))
        }
        return respond(ctx, errorPayload(405, 'method not allowed'))
      }

      const actorMatch = /^\/actors\/([^/]+)$/.exec(path)
      if (actorMatch !== null && method === 'GET') {
        const actor = await ctx.actors.get(decodeURIComponent(actorMatch[1] ?? ''))
        if (actor === null) return respond(ctx, errorPayload(404, 'actor not found'))
        return respond(ctx, jsonPayload(200, actorView(actor, projectionOf(actor))))
      }

      const statusMatch = /^\/actors\/([^/]+)\/status$/.exec(path)
      if (statusMatch !== null && method === 'POST') {
        if (!isAdmin(ctx, request)) return respond(ctx, errorPayload(401, 'unauthorized'))
        const actor = await ctx.actors.get(decodeURIComponent(statusMatch[1] ?? ''))
        if (actor === null) return respond(ctx, errorPayload(404, 'actor not found'))
        const body = await readJson(request)
        const status = body?.['status']
        if (status !== 'active' && status !== 'disabled') {
          return respond(ctx, errorPayload(400, 'status must be "active" or "disabled"'))
        }
        const updated = await ctx.actors.setStatus(actor.id, status)
        return respond(ctx, jsonPayload(200, actorView(updated ?? actor, projectionOf(actor))))
      }

      const credentialMatch = /^\/actors\/([^/]+)\/credentials$/.exec(path)
      if (credentialMatch !== null && method === 'POST') {
        if (!isAdmin(ctx, request)) return respond(ctx, errorPayload(401, 'unauthorized'))
        return handleIssueCredential(ctx, decodeURIComponent(credentialMatch[1] ?? ''), request)
      }

      const credentialListMatch = /^\/actors\/([^/]+)\/credentials$/.exec(path)
      if (credentialListMatch !== null && method === 'GET') {
        if (!isAdmin(ctx, request)) return respond(ctx, errorPayload(401, 'unauthorized'))
        const actor = await ctx.actors.get(decodeURIComponent(credentialListMatch[1] ?? ''))
        if (actor === null) return respond(ctx, errorPayload(404, 'actor not found'))
        const list = await ctx.credentials.listForActor(actor.id)
        return respond(ctx, jsonPayload(200, { credentials: list.map(credentialView) }))
      }

      const revokeMatch = /^\/credentials\/([^/]+)\/revoke$/.exec(path)
      if (revokeMatch !== null && method === 'POST') {
        if (!isAdmin(ctx, request)) return respond(ctx, errorPayload(401, 'unauthorized'))
        const id = decodeURIComponent(revokeMatch[1] ?? '')
        const credential = await ctx.credentials.findById(id)
        if (credential === null) return respond(ctx, errorPayload(404, 'credential not found'))
        await ctx.credentials.revoke(id)
        const revoked = await ctx.credentials.findById(id)
        return respond(ctx, jsonPayload(200, credentialView(revoked ?? credential)))
      }

      if (path === '/token' && method === 'POST') {
        return handleToken(ctx, request)
      }

      return respond(ctx, errorPayload(404, 'not found'))
    } catch (cause) {
      console.error(`${SERVICE}: unhandled error`, cause)
      return respond(ctx, errorPayload(500, 'internal error'))
    }
  },
}
