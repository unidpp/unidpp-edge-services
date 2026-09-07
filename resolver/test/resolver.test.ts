// Integration tests for the resolver worker: real KV through the SELF
// fetch handler — per-context routing (eu-customs → EN 18222,
// jp-consumer → GB/T 33993, machine → UNTP), RFC 9264 shapes (the
// @unidpp/resolver fixture round-trip), as-of stamps and
// reconstruction, dark-identity indistinguishability, the path forms,
// and the admin surface.

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { contextKey, primarySubtag, scoreEntry } from '../src/context'
import { emitLinkset, parseLinkset } from '../src/linkset'
import { DEMO_DARK, DEMO_LINKSETS, ISO_DEMO, ISO_DEMO_LINKS } from '../src/seed'
import { entryValidAt, linkEntryFromAdmin } from '../src/store'

const BASE = 'https://resolve.unidpp.org'

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init)
}

async function post(path: string, body: unknown, method = 'POST'): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function linksOf(response: Response): Promise<Record<string, unknown>[]> {
  const document = parseLinkset(await response.text())
  return document.linkset as unknown as Record<string, unknown>[]
}

const ISO_IDENTIFIER = `iso-15459:${ISO_DEMO}`

async function seedIsoDemo(): Promise<void> {
  // PUT (replace) keeps repeated seeding within one file idempotent —
  // POST appends, and appended duplicates would defeat entry-id tests.
  const response = await post('/admin/linksets', { identifier: ISO_IDENTIFIER, links: ISO_DEMO_LINKS }, 'PUT')
  expect(response.status).toBe(200)
}

// ---------------------------------------------------------------------------
// Pure-module units (the @unidpp/resolver port's own suite, re-run)
// ---------------------------------------------------------------------------

describe('context scoring (the TS table)', () => {
  it('formats wildcards and primary subtags', () => {
    expect(contextKey({ profile: 'urn:p', language: 'ja-JP' })).toBe('profile=urn:p;role=*;lang=ja-JP;region=*')
    expect(primarySubtag('fr-CA')).toBe('fr')
  })

  it('scores exact > fallback > specific-no-pref > wildcard, mismatch kills', () => {
    const eu = { linkType: 'dpp', profile: 'urn:p:eu', role: 'consumer', languages: ['fr'], region: 'EU' }
    expect(scoreEntry(eu, { profile: 'urn:p:eu', role: 'consumer', language: 'fr', region: 'EU' }, 'dpp')).toBe(16)
    expect(scoreEntry(eu, { profile: 'urn:p:eu', role: 'consumer', language: 'fr-CA', region: 'EU' }, 'dpp')).toBe(15)
    expect(scoreEntry(eu, {}, 'dpp')).toBe(8)
    expect(scoreEntry(eu, { profile: 'urn:p:jp', role: 'consumer', language: 'fr', region: 'EU' }, 'dpp')).toBeNull()
    expect(scoreEntry({ linkType: 'dpp', languages: [] }, { language: 'ja' }, 'dpp')).toBe(4)
    expect(scoreEntry(eu, { profile: 'urn:p:eu', role: 'consumer', language: 'ja', region: 'EU' }, 'dpp')).toBeNull()
  })
})

describe('rfc 9264 linksets (the TS fixture round-trip)', () => {
  const fixture = `{
  "linkset": [
    {
      "anchor": "${ISO_DEMO}",
      "uri": "https://dpp.unidpp.org/eu/84120099012345",
      "rel": "dpp",
      "hreflang": ["en", "fr"],
      "type": "application/json",
      "unidpp:profile": "urn:unidpp:profile:eu-espr-electronics",
      "unidpp:role": "consumer",
      "unidpp:region": "EU"
    },
    {
      "anchor": "${ISO_DEMO}",
      "uri": "https://dpp-jp.meti.example.go.jp/passport/84120099012345",
      "rel": "dpp",
      "hreflang": ["ja"],
      "unidpp:profile": "urn:unidpp:profile:jp-meti-pse",
      "unidpp:role": "consumer",
      "unidpp:region": "JP"
    },
    {
      "anchor": "${ISO_DEMO}",
      "uri": "https://dpp.unidpp.org/generic/84120099012345",
      "rel": "dpp",
      "hreflang": ["*"],
      "unidpp:profile": "*",
      "unidpp:role": "*",
      "unidpp:region": "*"
    },
    {
      "anchor": "${ISO_DEMO}",
      "uri": "https://dpp.unidpp.org/recycler/84120099012345",
      "rel": "dpp",
      "hreflang": ["en"],
      "unidpp:profile": "*",
      "unidpp:role": "recycler",
      "unidpp:region": "*"
    }
  ]
}`

  it('round-trips parse(emit(x))', () => {
    const parsed = parseLinkset(fixture)
    expect(parsed.linkset).toHaveLength(4)
    expect(parseLinkset(emitLinkset(parsed.linkset)).linkset).toEqual(parsed.linkset)
  })

  it('accepts single-link and bare-array documents; rejects malformed', () => {
    expect(parseLinkset(JSON.stringify({ anchor: 'a', uri: 'https://x/', rel: 'dpp' })).linkset).toHaveLength(1)
    expect(parseLinkset('[{"anchor":"a","uri":"https://x/","rel":"dpp"}]').linkset).toHaveLength(1)
    expect(() => parseLinkset('{')).toThrow(/invalid linkset JSON/)
    expect(() => parseLinkset('{"linkset":[{"uri":"x","rel":"dpp"}]}')).toThrow(/anchor/)
  })
})

describe('admin link validation and validity', () => {
  it('validates admin link objects and injects the default as-of', () => {
    const { entry, error } = linkEntryFromAdmin({ linkType: 'dpp', href: 'https://x/', profile: '*' }, 1, '2026-01-01T00:00:00Z')
    expect(error).toBeNull()
    expect(entry!.asOf).toBe('2026-01-01T00:00:00Z')
    expect(entry!.profile).toBeUndefined()
    const bad = linkEntryFromAdmin({ href: 'https://x/' }, 1, '2026-01-01T00:00:00Z')
    expect(bad.error).toContain('linkType is required')
    const expired = linkEntryFromAdmin({ linkType: 'dpp', href: 'https://x/', asOf: '2026-01-01T00:00:00Z', expiry: '2025-12-31T23:59:59Z' }, 1, '2026-01-01T00:00:00Z')
    expect(expired.error).toContain('before asOf')
  })

  it('applies entry validity windows', () => {
    const entry = linkEntryFromAdmin({ linkType: 'dpp', href: 'https://x/', asOf: '2026-01-01T00:00:00Z', expiry: '2026-06-01T00:00:00Z' }, 1, '2026-01-01T00:00:00Z').entry!
    expect(entryValidAt(entry, Date.parse('2026-03-01T00:00:00Z'))).toBe(true)
    expect(entryValidAt(entry, Date.parse('2025-12-01T00:00:00Z'))).toBe(false)
    expect(entryValidAt(entry, Date.parse('2026-07-01T00:00:00Z'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The HTTP surface (seeded through the admin API, like production)
// ---------------------------------------------------------------------------

describe('discovery and health', () => {
  it('serves the discovery document with the demo contexts', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['service']).toBe('unidpp-resolver-edge')
    const routing = body['contextRouting'] as Record<string, unknown>
    const demos = routing['demoContexts'] as Record<string, Record<string, string>>
    expect(demos['eu-customs']!['render']).toBe('EN 18222 REST')
    expect(demos['jp-consumer']!['render']).toBe('GB/T 33993')
    expect(demos['machine']!['render']).toBe('UNTP verifiable credential')
  })

  it('answers healthz', async () => {
    const response = await get('/healthz')
    expect(await response.text()).toBe('ok')
  })
})

describe('per-context routing (the three demo contexts)', () => {
  it('routes eu-customs to the EN 18222 render', async () => {
    await seedIsoDemo()
    const response = await get(
      `/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&profile=${encodeURIComponent('urn:unidpp:profile:eu-espr-electronics')}&role=customs&region=EU&lang=en`,
    )
    expect(response.status).toBe(200)
    const links = await linksOf(response)
    expect(links[0]!['uri']).toBe('https://dpp.unidpp.org/eu/84120099012345')
    expect(links[0]!['title']).toContain('EN 18222')
    expect(response.headers.get('x-unidpp-context')).toContain('role=customs')
    expect(response.headers.get('link')).toBe('<https://dpp.unidpp.org/eu/84120099012345>; rel="dpp"')
  })

  it('routes jp-consumer to the GB/T 33993 render with language fallback', async () => {
    const response = await get(
      `/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&profile=${encodeURIComponent('urn:unidpp:profile:jp-meti-pse')}&role=consumer&lang=ja-JP&region=JP`,
    )
    const links = await linksOf(response)
    expect(links[0]!['uri']).toBe('https://dpp-jp.meti.example.go.jp/passport/84120099012345')
    expect(links[0]!['title']).toContain('GB/T 33993')
    // English speaker in the JP profile: the ja link is rejected, the wildcard wins
    const en = await get(
      `/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&profile=${encodeURIComponent('urn:unidpp:profile:jp-meti-pse')}&role=consumer&lang=en&region=JP`,
    )
    expect((await linksOf(en))[0]!['uri']).toBe('https://dpp.unidpp.org/generic/84120099012345')
  })

  it('routes machine to the UNTP render', async () => {
    const response = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&role=machine`)
    const links = await linksOf(response)
    expect(links[0]!['uri']).toBe('https://dpp.unidpp.org/untp/84120099012345')
    expect(links[0]!['title']).toContain('UNTP')
  })

  it('routes by role with no profile preference (recycler) and serves all links with no context', async () => {
    const recycler = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&role=recycler`)
    expect((await linksOf(recycler))[0]!['uri']).toContain('/recycler/')
    const plain = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}`)
    expect((await linksOf(plain)).length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Accept-header content negotiation (discovery protocol C4)
// ---------------------------------------------------------------------------

describe('accept-header negotiation (discovery protocol C4)', () => {
  it('routes three Accept headers to three distinct render destinations, each stamped x-as-of', async () => {
    await seedIsoDemo()
    const identifier = encodeURIComponent(ISO_IDENTIFIER)
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['application/untp+json', 'https://dpp.unidpp.org/untp/84120099012345', 'role=machine'],
      ['application/en18222+json', 'https://dpp.unidpp.org/eu/84120099012345', 'role=customs'],
      ['text/html', 'https://dpp-jp.meti.example.go.jp/passport/84120099012345', 'role=consumer'],
    ]
    const destinations = new Set<string>()
    for (const [accept, uri, context] of cases) {
      const response = await get(`/resolve?identifier=${identifier}`, { headers: { Accept: accept } })
      expect(response.status, accept).toBe(200)
      const links = await linksOf(response)
      expect(links[0]!['uri'], accept).toBe(uri)
      expect(response.headers.get('link'), accept).toBe(`<${uri}>; rel="dpp"`)
      expect(response.headers.get('x-unidpp-context'), accept).toBe(`profile=*;${context};lang=*;region=*`)
      expect(response.headers.get('x-as-of'), accept).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      destinations.add(uri)
    }
    expect(destinations.size).toBe(3)
  })

  it('explicit context parameters outrank the accept header', async () => {
    await seedIsoDemo()
    const identifier = encodeURIComponent(ISO_IDENTIFIER)
    const response = await get(`/resolve?identifier=${identifier}&role=recycler`, {
      headers: { Accept: 'application/untp+json' },
    })
    const links = await linksOf(response)
    expect(links[0]!['uri']).toContain('/recycler/')
    expect(response.headers.get('x-unidpp-context')).toBe('profile=*;role=recycler;lang=*;region=*')
    // An unoffered media type leaves plain no-context resolution in place.
    const plain = await get(`/resolve?identifier=${identifier}`, { headers: { Accept: 'application/xml' } })
    expect(plain.headers.get('x-unidpp-context')).toBeNull()
  })

  it('negotiates the path-form redirect too', async () => {
    const item = DEMO_LINKSETS[1]!
    await post('/admin/linksets', { identifier: item.identifier, links: item.links }, 'PUT')
    const redirect = await get('/01/06901234567892/21/AB2026111', {
      redirect: 'manual',
      headers: { Accept: 'application/untp+json' },
    })
    expect(redirect.status).toBe(303)
    expect(redirect.headers.get('location')).toBe('https://dpp.unidpp.org/untp/06901234567892')
    expect(redirect.headers.get('x-as-of')).toBeTruthy()
  })

  it('x-as-of derives from the linkset generation timestamp, not the request instant', async () => {
    await seedIsoDemo()
    const view = await get('/admin/identifiers/' + encodeURIComponent(ISO_IDENTIFIER))
    const doc = (await view.json()) as { updatedAt: string }
    expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const live = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}`)
    expect(live.headers.get('x-as-of')).toBe(doc.updatedAt)
    // Historical reconstruction still stamps the requested instant.
    const past = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&asof=2030-01-01T00:00:00Z`)
    expect(past.headers.get('x-as-of')).toBe('2030-01-01T00:00:00Z')
  })
})

describe('as-of stamps (I13)', () => {
  it('stamps every response with the effective instant', async () => {
    await seedIsoDemo()
    const response = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}`)
    expect(response.headers.get('x-as-of')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const links = await linksOf(response)
    for (const link of links) {
      expect(link['unidpp:as-of']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('reconstructs the linkset as of a past instant', async () => {
    await seedIsoDemo()
    const past = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&asof=2020-01-01T00:00:00Z`)
    expect(past.status).toBe(404)
    const future = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&asof=2030-01-01T00:00:00Z`)
    expect(future.status).toBe(200)
    const bad = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&asof=not-a-time`)
    expect(bad.status).toBe(400)
  })
})

describe('dark identities and no-information 404s (I12)', () => {
  it('returns byte-identical 404s for dark and unknown identifiers', async () => {
    const dark = await post('/admin/dark', { identifier: DEMO_DARK['identifier'], dark: true })
    expect(dark.status).toBe(200)
    const darkResponse = await get(`/resolve?identifier=${encodeURIComponent(DEMO_DARK['identifier'])}`)
    const unknownResponse = await get(`/resolve?identifier=${encodeURIComponent('iso-15459:urn:iso:std:iso-iec:15459:unidpp:inst:99999999999999')}`)
    expect(darkResponse.status).toBe(404)
    expect(unknownResponse.status).toBe(404)
    const darkBody = await darkResponse.text()
    const unknownBody = await unknownResponse.text()
    expect(darkBody).toBe('{"error":"not found"}')
    expect(darkBody).toBe(unknownBody)
    expect([...darkResponse.headers.entries()]).toEqual([...unknownResponse.headers.entries()])
  })

  it('clears the dark marking on request', async () => {
    await post('/admin/dark', { identifier: DEMO_DARK['identifier'], dark: false })
    const cleared = await get('/admin/identifiers/' + encodeURIComponent(DEMO_DARK['identifier']))
    const body = (await cleared.json()) as Record<string, unknown>
    expect(body['dark']).toBe(false)
  })
})

describe('the path forms', () => {
  it('serves the AI-path linkset document and the GDS-path redirect', async () => {
    const item = DEMO_LINKSETS[1]!
    const registered = await post('/admin/linksets', { identifier: item.identifier, links: item.links }, 'PUT')
    expect(registered.status).toBe(200)

    const doc = await get('/01/06901234567892/21/AB2026111/linkset')
    expect(doc.status).toBe(200)
    expect(doc.headers.get('content-type')).toBe('application/linkset+json')
    expect((await linksOf(doc)).length).toBe(3)

    const redirect = await get('/g/6901234567892/AB2026111', { redirect: 'manual' })
    expect(redirect.status).toBe(303)
    // No request context: the most specific published destination wins the
    // default-link rule (the scoring table's 2s beat the wildcard's 1s).
    expect(redirect.headers.get('location')).toBe('https://dpp.unidpp.org/eu/06901234567892')
    expect(redirect.headers.get('x-as-of')).toBeTruthy()
  })

  it('falls to the no-information 404 on unrecognized path shapes', async () => {
    const response = await get('/nonsense/path')
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"error":"not found"}')
  })
})

describe('the admin surface', () => {
  it('replaces a linkset (revoke + register in one act) and logs every op', async () => {
    const key = DEMO_LINKSETS[2]!
    await post('/admin/linksets', { identifier: key.identifier, links: key.links }, 'PUT')
    const replaced = await post(
      '/admin/linksets',
      { identifier: key.identifier, links: [{ linkType: 'dpp', href: 'https://dpp.unidpp.org/v2/09506000134352', title: 'v2' }] },
      'PUT',
    )
    expect(replaced.status).toBe(200)
    const view = await get('/admin/identifiers/' + encodeURIComponent(key.identifier))
    const body = (await view.json()) as { entries: { href: string }[] }
    expect(body.entries.map((e) => e.href)).toEqual(['https://dpp.unidpp.org/v2/09506000134352'])

    const log = await get('/admin/log?limit=100')
    const logBody = (await log.json()) as { log: { op: string }[] }
    const ops = logBody.log.map((r) => r.op)
    expect(ops).toContain('replace')
    expect(ops).toContain('dark')
  })

  it('revokes a single entry by id', async () => {
    await seedIsoDemo()
    const view = await get('/admin/identifiers/' + encodeURIComponent(ISO_IDENTIFIER))
    const body = (await view.json()) as { entries: { id: number; href: string }[] }
    const recyclerEntry = body.entries.find((e) => e.href.includes('/recycler/'))!
    const revoked = await post('/admin/revocations', { identifier: ISO_IDENTIFIER, entryId: recyclerEntry.id, reason: 'test revocation' })
    expect(revoked.status).toBe(200)
    // After revocation the recycler entry is gone; the wildcard default
    // legitimately serves the role (the scoring table's fallback), so the
    // assertion is the entry's absence — never a silent 404.
    const after = await get(`/resolve?identifier=${encodeURIComponent(ISO_IDENTIFIER)}&role=recycler`)
    expect(after.status).toBe(200)
    const uris = (await linksOf(after)).map((l) => String(l['uri']))
    expect(uris.some((u) => u.includes('/recycler/'))).toBe(false)
    expect(uris[0]).toBe('https://dpp.unidpp.org/generic/84120099012345')
  })

  it('refuses malformed registrations', async () => {
    const noLinks = await post('/admin/linksets', { identifier: ISO_IDENTIFIER })
    expect(noLinks.status).toBe(400)
    const badIdentifier = await post('/admin/linksets', { identifier: 'junk', links: [{ linkType: 'dpp', href: 'https://x/' }] })
    expect(badIdentifier.status).toBe(400)
    const badLink = await post('/admin/linksets', { identifier: ISO_IDENTIFIER, links: [{ href: 'https://x/' }] })
    expect(badLink.status).toBe(400)
  })
})

describe('carrier normalization (query form)', () => {
  it('resolves from a GS1 Digital Link carrier and a bare EAN', async () => {
    // Seed both the GS1 item and the GS1 model so the EAN carrier can resolve.
    await post('/admin/linksets', { identifier: DEMO_LINKSETS[1]!.identifier, links: DEMO_LINKSETS[1]!.links }, 'PUT')
    await post('/admin/linksets', { identifier: DEMO_LINKSETS[2]!.identifier, links: DEMO_LINKSETS[2]!.links }, 'PUT')
    const dl = await get(`/resolve?carrier=${encodeURIComponent('https://id.example.com/01/06901234567892/21/AB2026111')}&role=machine`)
    expect(dl.status).toBe(200)
    expect((await linksOf(dl))[0]!['uri']).toContain('/untp/')
    const ean = await get(`/resolve?carrier=${encodeURIComponent('09506000134352')}`)
    expect((await linksOf(ean))[0]!['uri']).toContain('/generic/')
    const bad = await get(`/resolve?carrier=${encodeURIComponent('09506000134353')}`)
    expect(bad.status).toBe(400)
  })
})
