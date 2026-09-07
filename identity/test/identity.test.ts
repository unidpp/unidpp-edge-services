// Integration tests for the identity worker: real D1 through the SELF
// fetch handler (vitest-pool-workers) — the full HTTP surface, the
// role catalog's write-time enforcement, credential issuance +
// narrowing, the ES256 token and the signed-response doctrine.

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { base64urlDecode } from '../src/signing'

type KeyedJwk = JsonWebKey & { kid?: string }

interface Json {
  status: number
  body: Record<string, unknown>
  headers: Headers
}

async function call(path: string, init: RequestInit = {}): Promise<Json> {
  const response = await SELF.fetch(`https://identity.unidpp.org${path}`, init)
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body, headers: response.headers }
}

function adminJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** ES256-verify a signed response body against the JWKS. */
async function verifySignature(headers: Headers, body: Record<string, unknown>): Promise<boolean> {
  const kid = headers.get('X-UNIDPP-Kid')
  const timestamp = headers.get('X-UNIDPP-Timestamp')
  const signature = headers.get('X-UNIDPP-Signature')
  if (kid === null || timestamp === null || signature === null) return false
  const jwks = (await (await SELF.fetch('https://identity.unidpp.org/.well-known/jwks.json')).json()) as { keys: KeyedJwk[] }
  const jwk = jwks.keys.find((k) => k.kid === kid)
  if (jwk === undefined) return false
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const input = new TextEncoder().encode(`${timestamp}\n${JSON.stringify(body, null, 2)}`)
  const sig = base64urlDecode(signature)
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig as unknown as ArrayBuffer, input as unknown as ArrayBuffer)
}

/** ES256-verify a compact JWT against the JWKS. */
async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const jwks = (await (await SELF.fetch('https://identity.unidpp.org/.well-known/jwks.json')).json()) as { keys: KeyedJwk[] }
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0] ?? ''))) as { kid?: string }
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (jwk === undefined) return null
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64urlDecode(parts[2] ?? '') as unknown as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as unknown as ArrayBuffer,
  )
  if (!ok) return null
  return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1] ?? ''))) as Record<string, unknown>
}

describe('discovery and health', () => {
  it('serves a discovery document with endpoints and the role-catalog pointer', async () => {
    const { status, body } = await call('/')
    expect(status).toBe(200)
    expect(body['service']).toBe('unidpp-identity')
    expect((body['endpoints'] as Record<string, string>)['token']).toContain('/token')
    expect((body['endpoints'] as Record<string, string>)['jwks']).toContain('/.well-known/jwks.json')
  })

  it('serves the role catalog with EN 18239 mappings', async () => {
    const { status, body } = await call('/roles')
    expect(status).toBe(200)
    const kinds = body['kinds'] as { kind: string; roles: { key: string; en18239: { class: string; note?: string } }[] }[]
    const byKind = new Map(kinds.map((k) => [k.kind, k]))
    expect((byKind.get('economic-operator')?.roles ?? []).find((r) => r.key === 'eo:manufacturer')?.en18239.class).toBe('economic-operator')
    expect((byKind.get('repairer')?.roles ?? []).find((r) => r.key === 'repairer:authorized')?.en18239.class).toBe('professional-repairer')
    // honest mapping: the EN has no installer/marketplace role — the note states it
    expect((byKind.get('installer')?.roles ?? [])[0]?.en18239.note).toBeTruthy()
    expect((byKind.get('marketplace')?.roles ?? [])[0]?.en18239.note).toBeTruthy()
  })

  it('answers healthz', async () => {
    const response = await SELF.fetch('https://identity.unidpp.org/healthz')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })
})

describe('actor registry', () => {
  it('registers an EO with catalog-checked roles and maps the EN 18239 class', async () => {
    const { status, body } = await call(
      '/actors',
      adminJson({
        id: 'eo-test-acme',
        kind: 'economic-operator',
        name: 'Test EO',
        jurisdiction: 'DE',
        roles: ['eo:manufacturer', 'eo:dealer'],
      }),
    )
    expect(status).toBe(201)
    expect(body['id']).toBe('eo-test-acme')
    const en18239 = body['en18239'] as { class: string; subkind?: string }[]
    expect(en18239.map((c) => c.class)).toContain('economic-operator')
    expect(body['status']).toBe('active')
  })

  it('refuses roles outside the kind catalog', async () => {
    const { status, body } = await call(
      '/actors',
      adminJson({ id: 'bad-1', kind: 'installer', name: 'X', roles: ['eo:manufacturer'] }),
    )
    expect(status).toBe(400)
    expect(String(body['error'])).toContain('not in the installer catalog')
  })

  it('refuses a bad jurisdiction and an unknown kind', async () => {
    const badKind = await call('/actors', adminJson({ id: 'bad-2', kind: 'authority', name: 'X', roles: ['cab:test-laboratory'] }))
    expect(badKind.status).toBe(400)
    const badJur = await call('/actors', adminJson({ id: 'bad-3', kind: 'cab', name: 'X', roles: ['cab:test-laboratory'], jurisdiction: 'DEU' }))
    expect(badJur.status).toBe(400)
    expect(String(badJur.body['error'])).toContain('ISO 3166-1 alpha-2')
  })

  it('serves the public actor view signed (ES256 over timestamp+body)', async () => {
    await call('/actors', adminJson({ id: 'signed-1', kind: 'cab', name: 'Signed CAB', roles: ['cab:test-laboratory'] }))
    const response = await SELF.fetch('https://identity.unidpp.org/actors/signed-1')
    const body = (await response.json()) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(await verifySignature(response.headers, body)).toBe(true)
  })

  it('404s an unknown actor', async () => {
    const { status } = await call('/actors/nope')
    expect(status).toBe(404)
  })

  it('disables an actor (the guarded lifecycle)', async () => {
    await call('/actors', adminJson({ id: 'life-1', kind: 'repairer', name: 'Life', roles: ['repairer:authorized'] }))
    const disabled = await call('/actors/life-1/status', adminJson({ status: 'disabled' }))
    expect(disabled.status).toBe(200)
    expect(disabled.body['status']).toBe('disabled')
    const reEnabled = await call('/actors/life-1/status', adminJson({ status: 'active' }))
    expect(reEnabled.body['status']).toBe('active')
  })
})

describe('credentials and tokens', () => {
  it('issues a scoped credential, shows the secret once, and mints a verifiable ES256 token', async () => {
    await call('/actors', adminJson({ id: 'cred-1', kind: 'economic-operator', name: 'Cred EO', roles: ['eo:manufacturer'] }))
    const issued = await call(
      '/actors/cred-1/credentials',
      adminJson({ audience: 'https://issuer.unidpp.org' }),
    )
    expect(issued.status).toBe(201)
    const clientSecret = issued.body['clientSecret'] as string
    expect(clientSecret).toMatch(/^usk_[0-9a-f]{48}$/)
    expect((issued.body['clientId'] as string)).toMatch(/^uc_[0-9a-f]{16}$/)
    // defaults from the manufacturer role
    const scopes = issued.body['scopes'] as string[]
    expect(scopes).toContain('passport:issue:type')
    expect(scopes).not.toContain('event:append:ota')

    const basic = btoa(`${issued.body['clientId']}:${clientSecret}`)
    const tokenResponse = await SELF.fetch('https://identity.unidpp.org/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    })
    expect(tokenResponse.status).toBe(200)
    const tokenBody = (await tokenResponse.json()) as Record<string, unknown>
    const claims = await verifyToken(tokenBody['access_token'] as string)
    expect(claims).not.toBeNull()
    expect(claims!['iss']).toBe('https://identity.unidpp.org')
    expect(claims!['sub']).toBe('cred-1')
    expect(claims!['aud']).toBe('https://issuer.unidpp.org')
    expect(claims!['scope']).toContain('passport:issue:type')
    const en18239 = claims!['en18239'] as { class: string; subkind?: string }[]
    expect(en18239).toEqual([{ class: 'economic-operator', subkind: 'manufacturer' }])
    expect(typeof claims!['exp']).toBe('number')
    expect(tokenBody['token_type']).toBe('Bearer')
  })

  it('narrows scopes at issuance and refuses beyond-the-ceiling scopes', async () => {
    await call('/actors', adminJson({ id: 'cred-2', kind: 'cab', name: 'Cred CAB', roles: ['cab:test-laboratory'] }))
    const narrowed = await call(
      '/actors/cred-2/credentials',
      adminJson({ audience: 'urn:unidpp:service:issuer', scopes: ['read:tier-b'] }),
    )
    expect(narrowed.status).toBe(201)
    expect(narrowed.body['scopes']).toEqual(['read:tier-b'])

    const outside = await call(
      '/actors/cred-2/credentials',
      adminJson({ audience: 'urn:unidpp:service:issuer', scopes: ['passport:issue:type'] }),
    )
    expect(outside.status).toBe(400)
    expect(String(outside.body['error'])).toContain("beyond this actor's role catalog")
  })

  it('narrows at mint and refuses invalid_scope beyond the allowlist', async () => {
    await call('/actors', adminJson({ id: 'cred-3', kind: 'repairer', name: 'Cred Repairer', roles: ['repairer:authorized'] }))
    const issued = await call('/actors/cred-3/credentials', adminJson({ audience: 'https://issuer.unidpp.org' }))
    const mintId = issued.body['clientId'] as string
    const mintSecret = issued.body['clientSecret'] as string

    const narrowed = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: mintId, clientSecret: mintSecret, grant_type: 'client_credentials', scope: 'read:scoped' }),
    })
    expect(narrowed.status).toBe(200)
    const claims = await verifyToken((narrowed.body['access_token'] as string))
    expect(claims!['scope']).toBe('read:scoped')

    const outside = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: mintId, clientSecret: mintSecret, grant_type: 'client_credentials', scope: 'passport:issue:type' }),
    })
    expect(outside.status).toBe(400)
    expect(outside.body['error']).toBe('invalid_scope')
  })

  it('refuses a wrong secret and a disabled actor', async () => {
    await call('/actors', adminJson({ id: 'cred-4', kind: 'marketplace', name: 'Mkt', roles: ['marketplace:operator'] }))
    const issued = await call('/actors/cred-4/credentials', adminJson({ audience: 'https://issuer.unidpp.org' }))
    const bad = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: issued.body['clientId'], clientSecret: 'usk_wrong', grant_type: 'client_credentials' }),
    })
    expect(bad.status).toBe(401)

    await call('/actors/cred-4/status', adminJson({ status: 'disabled' }))
    const disabled = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: issued.body['clientId'], clientSecret: issued.body['clientSecret'], grant_type: 'client_credentials' }),
    })
    expect(disabled.status).toBe(403)
    // a disabled actor admits no new credentials either
    const refused = await call('/actors/cred-4/credentials', adminJson({ audience: 'https://issuer.unidpp.org' }))
    expect(refused.status).toBe(403)
  })

  it('refuses an unsupported grant type', async () => {
    const { status, body } = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'x', clientSecret: 'y', grant_type: 'authorization_code' }),
    })
    expect(status).toBe(400)
    expect(body['error']).toBe('unsupported_grant_type')
  })

  it('revokes a credential', async () => {
    await call('/actors', adminJson({ id: 'cred-5', kind: 'installer', name: 'Inst', roles: ['installer'] }))
    const issued = await call('/actors/cred-5/credentials', adminJson({ audience: 'https://issuer.unidpp.org' }))
    const revoked = await call(`/credentials/${issued.body['clientId']}/revoke`, adminJson({}))
    expect(revoked.status).toBe(200)
    expect(revoked.body['status']).toBe('revoked')
    const after = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: issued.body['clientId'], clientSecret: issued.body['clientSecret'], grant_type: 'client_credentials' }),
    })
    expect(after.status).toBe(401)
  })
})

describe('the demo seed', () => {
  it('seeds the five demo actors idempotently (the deploy script\'s fixtures)', async () => {
    const { DEMO_ACTORS } = await import('../src/seed')
    for (const actor of DEMO_ACTORS) {
      const first = await call('/actors', adminJson(actor))
      expect([201, 409]).toContain(first.status)
      const view = await call(`/actors/${actor.id}`)
      expect(view.status).toBe(200)
      expect(view.body['kind']).toBe(actor.kind)
    }
  })
})
