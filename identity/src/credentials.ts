// The API credential machinery (adapted from oimlsmart/identity's
// service-client class, TODO.identity-ops/07): scoped credentials bound
// to an ACTOR and an AUDIENCE — the machine caller's honest path.
//
//   - a credential carries a scope allowlist (least privilege at
//     write, narrowed per request at mint — never beyond);
//   - the secret is shown ONCE at issuance; the database keeps only
//     its SHA-256;
//   - the token is a self-contained ES256 JWT on the service's signing
//     key: the called service validates it against the JWKS — no
//     call-back, no introspection round-trip;
//   - the JWT carries the actor's EN 18239-style class mapping, so a
//     relying service enforcing EN 18239 role classes reads the class
//     straight off the token.
//
// WORKER-SAFE: WebCrypto only.

import type { ActorRecord } from './actors'
import { projectionOf } from './actors'
import type { CredentialProjection } from './roles'
import type { CredentialsTable } from './store'
import { addSecondsRfc3339, nowRfc3339, parseRfc3339 } from './time'

export interface CredentialRecord {
  /** The public client id (HTTP Basic username, JWT client_id). */
  id: string
  actorId: string
  audience: string
  scopes: string[]
  status: 'active' | 'revoked'
  issuedAt: string
  expiresAt: string | null
  lastUsedAt: string | null
}

interface CredentialRow {
  id: string
  actor_id: string
  audience: string
  scopes: string
  status: string
  issued_at: string
  expires_at: string | null
  last_used_at: string | null
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The public client id. */
export function newCredentialId(): string {
  return `uc_${randomHex(8)}`
}

/** The secret — shown exactly once, at issuance. */
export function newCredentialSecret(): string {
  return `usk_${randomHex(24)}`
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare (the digest comparison side). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const AUDIENCE_PATTERN = /^(https?:\/\/[^\s]+|urn:[^\s]+)$/

/** The write-time validation of a credential issuance body. The
 *  scopes may narrow below the actor's catalog default; never beyond
 *  the ceiling (the narrowServiceScopes doctrine). */
export function validateCredentialInput(
  actor: ActorRecord,
  input: unknown,
): { credential: { audience: string; scopes: string[]; expiresAt: string | null }; error: string | null } {
  const projection = projectionOf(actor)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { credential: null as never, error: 'the issuance body must be an object: { audience, scopes?, expiresAt? }' }
  }
  const rec = input as Record<string, unknown>
  const audience = typeof rec['audience'] === 'string' ? rec['audience'].trim() : ''
  if (!audience) return { credential: null as never, error: 'audience is required (the called service\'s identifier — the token\'s aud)' }
  if (!AUDIENCE_PATTERN.test(audience)) {
    return { credential: null as never, error: 'audience must be an https://… URL or a urn:… identifier' }
  }
  let scopes: string[]
  if (rec['scopes'] === undefined || rec['scopes'] === null) {
    scopes = projection.defaultScopes
  } else if (Array.isArray(rec['scopes']) && rec['scopes'].every((s) => typeof s === 'string')) {
    const requested = [...new Set((rec['scopes'] as string[]).map((s) => s.trim()).filter(Boolean))]
    const outside = requested.filter((s) => !projection.allowedScopes.includes(s))
    if (outside.length > 0) {
      return {
        credential: null as never,
        error: `the requested scope(s) ${outside.map((s) => `'${s}'`).join(', ')} are beyond this actor's role catalog (allowed: ${projection.allowedScopes.join(' ')})`,
      }
    }
    if (requested.length === 0) {
      return { credential: null as never, error: 'scopes is present but empty — name the scopes, or omit it for the role defaults' }
    }
    scopes = requested.sort()
  } else {
    return { credential: null as never, error: 'scopes must be a list of scope strings' }
  }
  let expiresAt: string | null = null
  if (rec['expiresAt'] !== undefined && rec['expiresAt'] !== null) {
    if (typeof rec['expiresAt'] !== 'string' || parseRfc3339(rec['expiresAt']) === null) {
      return { credential: null as never, error: 'expiresAt must be an RFC 3339 timestamp' }
    }
    if (parseRfc3339(rec['expiresAt'])! <= Date.now()) {
      return { credential: null as never, error: 'expiresAt must lie in the future' }
    }
    expiresAt = rec['expiresAt']
  }
  return { credential: { audience, scopes, expiresAt }, error: null }
}

/** The mint-time scope narrowing (RFC 6749 §4.4's `scope` parameter):
 *  absent = the credential's full allowlist; present = every requested
 *  scope must be on it, or the grant refuses (invalid_scope — never a
 *  silent drop, never a mint beyond the allowlist). */
export function narrowTokenScopes(credential: CredentialRecord, requested: string | null): { scopes: string[]; error: string | null } {
  if (requested === null) return { scopes: [...credential.scopes], error: null }
  const req = [...new Set(requested.split(/\s+/).filter(Boolean))]
  if (req.length === 0) {
    return { scopes: [], error: 'the scope parameter is present but empty — name the scopes, or omit the parameter for the credential allowlist' }
  }
  const outside = req.filter((s) => !credential.scopes.includes(s))
  if (outside.length > 0) {
    return { scopes: [], error: `the requested scope(s) ${outside.map((s) => `'${s}'`).join(', ')} are not on this credential's allowlist` }
  }
  return { scopes: req, error: null }
}

/** The access token's claim set (the ONE builder the token endpoint
 *  uses — serviceTokenClaims' shape widened with the actor's EN 18239
 *  class mapping). Pure. */
export function tokenClaims(
  clientId: string,
  actor: ActorRecord,
  credential: CredentialRecord,
  projection: CredentialProjection,
  scopes: string[],
  config: { issuer: string; accessTokenTtlSeconds: number },
): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    iss: config.issuer,
    sub: actor.id,
    aud: credential.audience,
    client_id: clientId,
    iat: nowSec,
    exp: nowSec + config.accessTokenTtlSeconds,
    actor: { id: actor.id, kind: actor.kind, name: actor.name, roles: actor.roles },
    en18239: projection.en18239Classes.map((c) => ({ class: c.class, ...(c.subkind !== undefined ? { subkind: c.subkind } : {}) })),
    scope: scopes.join(' '),
  }
}

function rowToCredential(row: CredentialRow): CredentialRecord {
  let scopes: string[] = []
  try {
    scopes = JSON.parse(row.scopes) as string[]
  } catch {
    scopes = []
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    audience: row.audience,
    scopes,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  }
}

/** Is the credential minting-eligible at `nowMs`? */
export function credentialIsActive(credential: CredentialRecord, nowMs: number): boolean {
  if (credential.status !== 'active') return false
  if (credential.expiresAt !== null && parseRfc3339(credential.expiresAt)! <= nowMs) return false
  return true
}

/** The credential repository (one class, one entity). */
export class CredentialRepository {
  constructor(private readonly credentials: CredentialsTable) {}

  async create(credential: CredentialRecord, secretHash: string): Promise<void> {
    await this.credentials
      .prepare('INSERT INTO credentials (id, actor_id, audience, scopes, secret_hash, status, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(credential.id, credential.actorId, credential.audience, JSON.stringify(credential.scopes), secretHash, credential.status, credential.issuedAt, credential.expiresAt)
      .run()
  }

  async findById(id: string): Promise<CredentialRecord | null> {
    const row = await this.credentials.prepare('SELECT * FROM credentials WHERE id = ?1').bind(id).first<CredentialRow>()
    return row === null ? null : rowToCredential(row)
  }

  async listForActor(actorId: string): Promise<CredentialRecord[]> {
    const rows = await this.credentials.prepare('SELECT * FROM credentials WHERE actor_id = ?1 ORDER BY issued_at').bind(actorId).all<CredentialRow>()
    return (rows.results ?? []).map(rowToCredential)
  }

  async markUsed(id: string): Promise<void> {
    await this.credentials.prepare('UPDATE credentials SET last_used_at = ?2 WHERE id = ?1').bind(id, nowRfc3339()).run()
  }

  async revoke(id: string): Promise<void> {
    await this.credentials.prepare('UPDATE credentials SET status = ?2 WHERE id = ?1').bind(id, 'revoked').run()
  }
}

export { addSecondsRfc3339 }
