// ═══════════════════════════════════════════════════════════════════
// The service's signing keys (adapted from oimlsmart/identity's
// auth/op/keys.ts, TODO.identity/01): one ES256 pair per deployment,
// kid'd, with the rotation history in D1.
//
// The PRIVATE key rides the IDENTITY_SIGNING_KEY secret (EC P-256 JWK
// JSON: {"kty":"EC","crv":"P-256","x","y","d","kid"?}) — never the
// repo, never the database. Its PUBLIC half is registered into the
// signing_keys table on first use, so the JWKS endpoint's answer
// survives isolates and a rotation never strands an in-flight token.
//
// IDENTITY_SIGNING_KEY UNSET: a development pair is generated per
// process with a loud console warning. Development posture only —
// tokens invalidate at every restart and sibling isolates would sign
// with DIFFERENT keys; a deployment that serves real relying services
// declares the secret.
//
// WORKER-SAFE: WebCrypto only.
// ═══════════════════════════════════════════════════════════════════

import type { SigningKeysTable } from './store'

type OpJwk = JsonWebKey & { kid?: string; alg?: string; use?: string }

export interface ServiceSigningKey {
  kid: string
  /** TRUE when the key came from the declared secret; FALSE for the generated development pair. */
  declared: boolean
  privateKey: CryptoKey
  publicJwk: OpJwk
}

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function ab2u8(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer)
}

/** A stable kid for a key that declares none: the first 16 bytes of the
 *  SHA-256 over its coordinates, base64url'd (the oimlsmart kidFor
 *  recipe — scripts deriving a replacement kid announce the same value). */
export async function kidFor(publicJwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${publicJwk.x}.${publicJwk.y}`))
  return base64url(ab2u8(digest)).slice(0, 22)
}

function assertEcJwk(jwk: JsonWebKey): void {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('IDENTITY_SIGNING_KEY must be an EC P-256 JWK (kty "EC", crv "P-256", x, y — and d for the private half)')
  }
}

async function fromJwk(jwk: JsonWebKey): Promise<{ privateKey: CryptoKey; publicJwk: OpJwk }> {
  assertEcJwk(jwk)
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'] } as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const { d: _d, key_ops: _ops, ext: _ext, ...publicHalf } = jwk
  const publicJwk: OpJwk = { ...publicHalf, alg: 'ES256', use: 'sig' }
  return { privateKey, publicJwk }
}

async function generateDevKey(): Promise<ServiceSigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const { privateKey, publicJwk } = await fromJwk(raw)
  return { kid: await kidFor(publicJwk), declared: false, privateKey, publicJwk }
}

let memoized: { raw: string | null; key: ServiceSigningKey } | null = null
let warned = false

/** The isolate's signing key: the declared secret, else the dev generation.
 *  Memoized per env value (tests reset between cases). */
export async function resolveSigningKey(env: { IDENTITY_SIGNING_KEY?: string }): Promise<ServiceSigningKey> {
  const raw = env.IDENTITY_SIGNING_KEY?.trim() ?? null
  if (memoized && memoized.raw === raw) return memoized.key
  let key: ServiceSigningKey
  if (raw === null) {
    key = await generateDevKey()
    if (!warned) {
      console.warn('[unidpp-identity] IDENTITY_SIGNING_KEY unset — generated a per-process development key. Declare the secret on any real deployment.')
      warned = true
    }
  } else {
    try {
      const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string }
      const { privateKey, publicJwk } = await fromJwk(jwk)
      const kid = typeof jwk.kid === 'string' && jwk.kid ? jwk.kid : await kidFor(publicJwk)
      key = { kid, declared: true, privateKey, publicJwk: { ...publicJwk, kid } }
    } catch {
      throw new Error('IDENTITY_SIGNING_KEY is set but is not a valid EC P-256 JWK')
    }
  }
  memoized = { raw, key }
  return key
}

/** The tests' reset hook (oimlsmart's pattern). */
export function resetSigningKeyMemo(): void {
  memoized = null
}

/** Register the public half on first use (INSERT OR IGNORE — the key
 *  history is expand-only; retirement is a deliberate admin UPDATE
 *  once the token lifetime has passed, never automatic mid-flight). */
export async function registerKey(db: SigningKeysTable, key: ServiceSigningKey, now: string): Promise<void> {
  const publicJwk = { ...key.publicJwk, kid: key.kid }
  await db
    .prepare('INSERT OR IGNORE INTO signing_keys (kid, public_jwk, declared, status, registered_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(key.kid, JSON.stringify(publicJwk), key.declared ? 1 : 0, 'active', now)
    .run()
}

/** The JWKS document: every active signing key. */
export async function jwksDocument(db: SigningKeysTable): Promise<{ keys: OpJwk[] }> {
  const result = await db.prepare('SELECT public_jwk FROM signing_keys WHERE status = ?1 ORDER BY registered_at').bind('active').all<{ public_jwk: string }>()
  return { keys: (result.results ?? []).map((row) => JSON.parse(row.public_jwk) as OpJwk) }
}

// ---------------------------------------------------------------------------
// ES256 signing: compact JWS (tokens) and detached response signatures
// ---------------------------------------------------------------------------

const text = new TextEncoder()

async function es256Raw(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data as unknown as ArrayBuffer)
  return ab2u8(signature)
}

function jwsSegment(bytes: Uint8Array): string {
  return base64url(bytes)
}

/** Mint a compact ES256 JWT on the key (header kid'd). */
export async function signJwt(claims: Record<string, unknown>, key: ServiceSigningKey): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT', kid: key.kid }
  const encodedHeader = jwsSegment(text.encode(JSON.stringify(header)))
  const encodedClaims = jwsSegment(text.encode(JSON.stringify(claims)))
  const signingInput = `${encodedHeader}.${encodedClaims}`
  const signature = await es256Raw(key.privateKey, text.encode(signingInput))
  return `${signingInput}.${base64url(signature)}`
}

/** Verify a compact ES256 JWT with a public JWK (the tests' and relying
 *  services' side — no call-back needed, the JWKS is the root). */
export async function verifyJwt(token: string, publicJwk: JsonWebKey): Promise<Record<string, unknown> | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const verifyKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    base64urlDecode(parts[2] ?? '') as unknown as ArrayBuffer,
    text.encode(`${parts[0]}.${parts[1]}`) as unknown as ArrayBuffer,
  )
  if (!ok) return null
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1] ?? ''))) as Record<string, unknown>
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

/** Sign a response body: ES256 over `${timestamp}\n${body}` — the
 *  headers (kid + timestamp + signature) are the verifiable statement
 *  of WHAT was said WHEN, checkable against the JWKS. */
export async function signResponseBody(body: string, key: ServiceSigningKey, timestamp: string): Promise<string> {
  const signature = await es256Raw(key.privateKey, text.encode(`${timestamp}\n${body}`))
  return base64url(signature)
}
