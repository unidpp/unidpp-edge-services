// ═══════════════════════════════════════════════════════════════════
// The UniDPP resolver service — TODO #22 (resolver-deploy), deployed
// as resolve.unidpp.org. The Rust reference (unidpp-resolver) proven
// surface, carried to the edge:
//
//   - KV-backed RFC 9264 linksets (application/linkset+json);
//   - per-context routing: profile / role / language / region, exact
//     matches over wildcards, primary-subtag language fallback —
//     eu-customs → EN 18222 render, jp-consumer → GB/T 33993 render,
//     machine → UNTP render (the seed dataset demonstrates all three);
//   - as-of stamps on every response (I13) and as-of reconstruction
//     via the `asof` query parameter;
//   - dark identities: absent-from-KV and dark return the SAME
//     byte-identical 404 (I12 — no information, ever); no listing.
//
// Public: discovery, /resolve (query form), the GS1/GB-T path forms.
// Admin: linkset registration/replacement, revocation, dark marking,
// the append-only ops log.
// ═══════════════════════════════════════════════════════════════════

import { parseCarrier, parseIdentifierParam, type ResolvedIdentifier } from './carrier'
import { contextKey, isContextEmpty, type RequestContext } from './context'
import type { Link } from './linkset'
import { LinkStore, linkEntryFromAdmin, selectOrdered, type LinkEntry } from './store'
import { nowRfc3339, parseRfc3339 } from './time'

export interface Env {
  LINKSETS: KVNamespace
  /** The admin bearer; unset = open (development posture). */
  RESOLVER_ADMIN_TOKEN?: string
}

const SERVICE = 'unidpp-resolver-edge'
const VERSION = '0.1.0'
const NOT_FOUND_BODY = '{"error":"not found"}'

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** The no-information 404: identical bytes for unknown identifiers and
 *  dark identities alike (I12). Never vary this response. */
function notFound(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function jsonOk(payload: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function badRequest(message: string): Response {
  return jsonOk({ error: message }, { 'Cache-Control': 'no-store' }, 400)
}

function unauthorized(): Response {
  return jsonOk({ error: 'unauthorized' }, { 'Cache-Control': 'no-store' }, 401)
}

// ---------------------------------------------------------------------------
// The view over effective entries
// ---------------------------------------------------------------------------

function entryToLink(anchor: string, entry: LinkEntry): Link {
  const link: Link & Record<string, unknown> = {
    anchor,
    uri: entry.href,
    rel: entry.linkType,
    hreflang: entry.languages.length === 0 ? ['*'] : [...entry.languages],
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.mediaType !== undefined ? { type: entry.mediaType } : {}),
    'unidpp:profile': entry.profile ?? '*',
    'unidpp:role': entry.role ?? '*',
    'unidpp:region': entry.region ?? '*',
    'unidpp:as-of': entry.asOf,
    ...(entry.expiry !== undefined ? { 'unidpp:expiry': entry.expiry } : {}),
  }
  return link
}

function orderedView(entries: readonly LinkEntry[], ctx: RequestContext, linkType: string): { ordered: LinkEntry[]; defaultLink: LinkEntry | null } {
  const filtered = linkType === 'all' ? [...entries] : entries.filter((e) => e.linkType === linkType)
  const ordered = isContextEmpty(ctx) ? filtered : selectOrdered(filtered, ctx, linkType === 'all' ? 'dpp' : linkType).map((s) => s.entry)
  const defaultRel = linkType === 'all' ? 'dpp' : linkType
  const best = selectOrdered(entries, ctx, defaultRel)[0] ?? null
  return { ordered, defaultLink: best === null ? null : best.entry }
}

function renderLinksetResponse(anchor: string, entries: readonly LinkEntry[], ctx: RequestContext, linkType: string, asOf: string): Response {
  const { ordered, defaultLink } = orderedView(entries, ctx, linkType)
  const headers: Record<string, string> = {
    'Content-Type': 'application/linkset+json',
    'X-As-Of': asOf,
    'Cache-Control': 'public, max-age=60',
  }
  if (!isContextEmpty(ctx)) headers['X-Unidpp-Context'] = contextKey(ctx)
  if (linkType !== 'all' && defaultLink !== null) {
    headers['Link'] = `<${defaultLink.href}>; rel="${defaultLink.linkType}"`
  }
  return jsonOk({ linkset: ordered.map((e) => entryToLink(anchor, e)) }, headers)
}

function renderRedirect(entries: readonly LinkEntry[], ctx: RequestContext, linkType: string, asOf: string): Response {
  const { defaultLink } = orderedView(entries, ctx, linkType)
  if (defaultLink === null) return notFound()
  return new Response(null, {
    status: 303,
    headers: { Location: defaultLink.href, 'X-As-Of': asOf },
  })
}

// ---------------------------------------------------------------------------
// Context parsing
// ---------------------------------------------------------------------------

function contextFromParams(params: URLSearchParams): RequestContext {
  const dim = (name: string): string | undefined => {
    const value = params.get(name)?.trim()
    return value ? value : undefined
  }
  return { profile: dim('profile'), role: dim('role'), language: dim('lang'), region: dim('region') }
}

function asOfFromParams(params: URLSearchParams): { atMs: number | null; error: string | null } {
  const raw = params.get('asof')?.trim()
  if (raw === undefined || raw === '') return { atMs: null, error: null }
  const ms = parseRfc3339(raw)
  return ms === null ? { atMs: null, error: `asof must be an RFC 3339 timestamp (got '${raw}')` } : { atMs: ms, error: null }
}

function linkTypeOf(params: URLSearchParams): string {
  const value = params.get('linkType')?.trim()
  return value ? value : 'dpp'
}

// ---------------------------------------------------------------------------
// The resolution core
// ---------------------------------------------------------------------------

async function resolve(env: Env, ident: ResolvedIdentifier, ctx: RequestContext, linkType: string, atMs: number | null, redirect: boolean): Promise<Response> {
  const store = new LinkStore(env.LINKSETS)
  const tMs = atMs ?? Date.now()
  const asOf = atMs !== null ? new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : nowRfc3339()
  const lookup = await store.lookup(ident.key, tMs)
  if (lookup.kind !== 'resolved') return notFound()
  if (lookup.entries.length === 0) return notFound()
  return redirect
    ? renderRedirect(lookup.entries, ctx, linkType, asOf)
    : renderLinksetResponse(ident.anchor, lookup.entries, ctx, linkType, asOf)
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function isAdmin(env: Env, request: Request): boolean {
  const expected = env.RESOLVER_ADMIN_TOKEN
  if (expected === undefined || expected === '') return true
  const header = request.headers.get('Authorization')
  const match = header !== null ? /^Bearer (.+)$/.exec(header) : null
  return match !== null && match[1] === expected
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text()
  if (text.trim() === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function identifierFromBody(body: Record<string, unknown>): Promise<{ ident: ResolvedIdentifier | null; error: string | null }> {
  const identifier = body['identifier']
  if (typeof identifier !== 'string' || identifier.trim() === '') {
    return { ident: null, error: 'identifier is required (scheme:value — e.g. "iso-15459:urn:iso:std:iso-iec:15459:unidpp:inst:…" or "gs1:(01)…(21)…")' }
  }
  const ident = parseIdentifierParam(identifier)
  return ident === null
    ? { ident: null, error: `unrecognized identifier form: '${identifier}'` }
    : { ident, error: null }
}

async function entriesFromBody(body: Record<string, unknown>, defaultAsOf: string): Promise<{ entries: LinkEntry[] | null; error: string | null }> {
  const links = body['links']
  if (!Array.isArray(links) || links.length === 0) {
    return { entries: null, error: 'links must be a non-empty array' }
  }
  if (links.length > 64) return { entries: null, error: 'links must carry at most 64 entries' }
  const entries: LinkEntry[] = []
  for (let i = 0; i < links.length; i++) {
    const { entry, error } = linkEntryFromAdmin(links[i] as Record<string, unknown>, i + 1, defaultAsOf)
    if (entry === null || error !== null) return { entries: null, error: error ?? `links[${i}] is invalid` }
    entries.push(entry)
  }
  return { entries, error: null }
}

function effectiveAtFromBody(body: Record<string, unknown>): { at: string | null; error: string | null } {
  const value = body['effectiveAt']
  if (value === undefined || value === null) return { at: nowRfc3339(), error: null }
  if (typeof value !== 'string' || parseRfc3339(value) === null) {
    return { at: null, error: 'effectiveAt must be an RFC 3339 string' }
  }
  return { at: value, error: null }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoveryPayload(url: URL): Record<string, unknown> {
  const origin = `${url.protocol}//${url.host}`
  return {
    profile: 'https://unidpp.org/ns/resolver/1.0',
    service: SERVICE,
    version: VERSION,
    linkset: {
      mediaType: 'application/linkset+json',
      specification: 'https://www.rfc-editor.org/rfc/rfc9264',
      parameters: {
        anchor: 'identifier (15459 URN, GB/T URL, or canonical GS1 element string)',
        uri: 'target href',
        rel: 'linkType',
        hreflang: 'languages ("*" = any)',
        'unidpp:profile': 'profile context ("*" = any)',
        'unidpp:role': 'verifier role ("*" = any)',
        'unidpp:region': 'request region ("*" = any)',
        'unidpp:as-of': 'RFC 3339 validity start',
        'unidpp:expiry': 'RFC 3339 validity end (absent = open)',
      },
    },
    identifierKeys: {
      schemes: ['gs1', 'gbt-33993', 'iso-15459'],
      gs1ApplicationIdentifiers: ['01', '10', '21'],
      gs1CheckDigit: true,
      carrierSyntaxes: [
        'gs1-digital-link-uri',
        'gbt-33993-gds-path',
        'gbt-33993-custom-code',
        'legacy-ean13',
        'iso-15459-urn',
      ],
    },
    contextRouting: {
      dimensions: ['profile', 'role', 'language', 'region'],
      wildcard: '*',
      languageTags: 'BCP 47, exact match then primary-subtag fallback',
      queryParameters: { profile: 'profile', role: 'role', language: 'lang', region: 'region' },
      specificity: { exactMatch: 4, primarySubtagFallback: 3, specificLinkWithoutRequestContext: 2, wildcard: 1, tieBreak: 'first-registered wins' },
      demoContexts: {
        'eu-customs': { profile: EU_PROFILE_SEED, role: 'customs', region: 'EU', render: 'EN 18222 REST' },
        'jp-consumer': { profile: 'urn:unidpp:profile:jp-meti-pse', role: 'consumer', lang: 'ja', region: 'JP', render: 'GB/T 33993' },
        machine: { role: 'machine', render: 'UNTP verifiable credential' },
      },
    },
    endpoints: {
      resolve: `${origin}/resolve?identifier=…`,
      resolveCarrier: `${origin}/resolve?carrier=…`,
      healthz: `${origin}/healthz`,
    },
  }
}

const EU_PROFILE_SEED = 'urn:unidpp:profile:eu-espr-electronics'

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()
    const store = new LinkStore(env.LINKSETS)

    try {
      if ((method === 'GET' && path === '/') || (method === 'GET' && path === '/.well-known/unidpp-resolver')) {
        return jsonOk(discoveryPayload(url), { 'Cache-Control': 'public, max-age=300' })
      }

      if (method === 'GET' && path === '/healthz') {
        return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      }

      if (method === 'GET' && path === '/resolve') {
        const params = url.searchParams
        const carrier = params.get('carrier')
        const identifier = params.get('identifier')
        if (carrier !== null && identifier !== null) {
          return badRequest('`carrier` and `identifier` are mutually exclusive')
        }
        let ident: ResolvedIdentifier | null = null
        if (identifier !== null && identifier !== '') {
          ident = parseIdentifierParam(identifier)
          if (ident === null) return badRequest(`unrecognized identifier form: '${identifier}'`)
        } else if (carrier !== null && carrier !== '') {
          const parsed = parseCarrier(carrier)
          if (parsed === null) return badRequest('unrecognized carrier')
          // URL-encode the scheme separator so GS1 element strings whose
          // value contains ':' (none today) cannot be mis-routed through
          // the identifier path later.
          const key = `${parsed.identifier.scheme}:${encodeURIComponent(parsed.identifier.value)}`
          ident = { identifier: parsed.identifier, anchor: parsed.identifier.value, key }
        } else {
          return badRequest('one of `carrier` or `identifier` is required')
        }
        const { atMs, error: asofError } = asOfFromParams(params)
        if (asofError !== null) return badRequest(asofError)
        return resolve(env, ident, contextFromParams(params), linkTypeOf(params), atMs, false)
      }

      if (path === '/admin/linksets' && (method === 'POST' || method === 'PUT')) {
        if (!isAdmin(env, request)) return unauthorized()
        const body = await readJson(request)
        if (body === null) return badRequest('the body must be a JSON object')
        const { ident, error: identError } = await identifierFromBody(body)
        if (ident === null || identError !== null) return badRequest(identError ?? 'invalid identifier')
        const { at: effectiveAt, error: timeError } = effectiveAtFromBody(body)
        if (effectiveAt === null || timeError !== null) return badRequest(timeError ?? 'invalid effectiveAt')
        const { entries, error } = await entriesFromBody(body, method === 'PUT' ? effectiveAt : nowRfc3339())
        if (entries === null || error !== null) return badRequest(error ?? 'invalid links')
        if (method === 'POST') {
          const { doc, record } = await store.register(ident.key, entries)
          return jsonOk(
            { identifier: ident.key, registered: doc.entries.length, recordSeq: record.seq },
            { 'Cache-Control': 'no-store' },
            201,
          )
        }
        const { doc, record } = await store.replace(ident.key, entries, effectiveAt)
        return jsonOk({ identifier: ident.key, registered: doc.entries.length, recordSeq: record.seq, effectiveAt }, { 'Cache-Control': 'no-store' })
      }

      if (path === '/admin/revocations' && method === 'POST') {
        if (!isAdmin(env, request)) return unauthorized()
        const body = await readJson(request)
        if (body === null) return badRequest('the body must be a JSON object')
        const { ident, error: identError } = await identifierFromBody(body)
        if (ident === null || identError !== null) return badRequest(identError ?? 'invalid identifier')
        const entryId = body['entryId']
        if (typeof entryId !== 'number' || !Number.isInteger(entryId) || entryId <= 0) {
          return badRequest('entryId is required (the numeric entry id from the admin view)')
        }
        const { at: effectiveAt, error: timeError } = effectiveAtFromBody(body)
        if (effectiveAt === null || timeError !== null) return badRequest(timeError ?? 'invalid effectiveAt')
        const reason = typeof body['reason'] === 'string' ? body['reason'] : 'revoked'
        try {
          const record = await store.revoke(ident.key, entryId, effectiveAt, reason)
          return jsonOk({ identifier: ident.key, revoked: entryId, effectiveAt, recordSeq: record.seq }, { 'Cache-Control': 'no-store' })
        } catch (cause) {
          return badRequest(String(cause instanceof Error ? cause.message : cause))
        }
      }

      if (path === '/admin/dark' && method === 'POST') {
        if (!isAdmin(env, request)) return unauthorized()
        const body = await readJson(request)
        if (body === null) return badRequest('the body must be a JSON object')
        const { ident, error: identError } = await identifierFromBody(body)
        if (ident === null || identError !== null) return badRequest(identError ?? 'invalid identifier')
        const dark = body['dark']
        if (typeof dark !== 'boolean') return badRequest('`dark` (boolean) is required')
        const { at: effectiveAt, error: timeError } = effectiveAtFromBody(body)
        if (effectiveAt === null || timeError !== null) return badRequest(timeError ?? 'invalid effectiveAt')
        const record = await store.setDark(ident.key, dark, effectiveAt)
        return jsonOk({ identifier: ident.key, dark, effectiveAt, recordSeq: record.seq }, { 'Cache-Control': 'no-store' })
      }

      if (path === '/admin/log' && method === 'GET') {
        if (!isAdmin(env, request)) return unauthorized()
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 1000)
        const offset = Math.min(Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0), 1000)
        return jsonOk({ log: await store.log(limit, offset) }, { 'Cache-Control': 'no-store' })
      }

      const adminIdentifierMatch = /^\/admin\/identifiers\/(.+)$/.exec(path)
      if (adminIdentifierMatch !== null && method === 'GET') {
        if (!isAdmin(env, request)) return unauthorized()
        const key = decodeURIComponent(adminIdentifierMatch[1] ?? '')
        const view = await store.adminView(key)
        return view === null ? notFound() : jsonOk({ identifier: key, ...view }, { 'Cache-Control': 'no-store' })
      }

      // GS1-conventions-style path form: /<carrier-key>/linkset returns
      // the linkset document; /<carrier-key> redirects (303) to the
      // default link. AI paths (/01/…/21/…) and GDS paths (/g/…).
      if (method === 'GET' && path !== '/' && !path.startsWith('/admin')) {
        const rawPath = path.slice(1)
        const wantLinkset = rawPath.endsWith('/linkset')
        const keyPath = wantLinkset ? rawPath.slice(0, -'/linkset'.length) : rawPath
        const segments = keyPath.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s))
        const qualifiers: [string, string][] = []
        for (const [k, v] of url.searchParams.entries()) {
          if (/^\d{2}$/.test(k) && ['10', '21'].includes(k)) qualifiers.push([k, v])
        }
        const ident = pathFormIdentifier(segments, qualifiers)
        if (ident === null) return notFound()
        const { atMs, error: asofError } = asOfFromParams(url.searchParams)
        if (asofError !== null) return badRequest(asofError)
        return resolve(env, ident, contextFromParams(url.searchParams), linkTypeOf(url.searchParams), atMs, !wantLinkset)
      }

      return notFound()
    } catch (cause) {
      console.error(`${SERVICE}: unhandled error`, cause)
      return jsonOk({ error: 'internal error' }, { 'Cache-Control': 'no-store' }, 500)
    }
  },
}

/** The path-form carrier classifier (AI paths and GDS paths; anything
 *  else falls to the no-information 404). */
function pathFormIdentifier(segments: string[], qualifiers: [string, string][]): ResolvedIdentifier | null {
  if (segments.length === 0) return null
  // GDS path: /g/<13-digit>[/<qualifier>]
  if (segments[0] === 'g' && segments.length >= 2) {
    const scanned = `https://resolve.unidpp.org/g/${segments.slice(1).map((s) => encodeURIComponent(s)).join('/')}`
    const parsed = parseCarrier(scanned)
    if (parsed === null || parsed.identifier.scheme !== 'gs1') return null
    return { identifier: parsed.identifier, anchor: parsed.identifier.value, key: `gs1:${parsed.identifier.value}` }
  }
  // AI path: pairs of <AI>/<value> with AI 01 first.
  if (segments.length >= 2 && segments[0] === '01') {
    const scanned = `https://resolve.unidpp.org/${segments.map((s) => encodeURIComponent(s)).join('/')}`
    const parsed = parseCarrier(scanned)
    if (parsed === null) return null
    return { identifier: parsed.identifier, anchor: parsed.identifier.value, key: `${parsed.identifier.scheme}:${parsed.identifier.value}` }
  }
  void qualifiers
  return null
}
