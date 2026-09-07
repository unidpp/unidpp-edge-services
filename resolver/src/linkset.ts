// RFC 9264 linkset emit/parse (ported from @unidpp/resolver linkset.ts)
// plus the store-entry conversion. UniDPP routing uses the open link
// parameters `unidpp:profile`, `unidpp:role`, `unidpp:region`
// alongside the standard `hreflang`, and the validity stamps
// `unidpp:as-of` / `unidpp:expiry` (I13: explicit freshness on every
// link — this resolver always stamps as-of; the TS library left
// validity to the store).

export interface Link {
  anchor: string
  uri: string
  rel: string
  hreflang?: string[]
  title?: string
  type?: string
  'unidpp:profile'?: string
  'unidpp:role'?: string
  'unidpp:region'?: string
  'unidpp:as-of'?: string
  'unidpp:expiry'?: string
  [ext: string]: unknown
}

export interface Linkset {
  linkset: Link[]
}

/** Emit a linkset document (RFC 9264 JSON serialization, 2-space). */
export function emitLinkset(links: Link[]): string {
  return JSON.stringify({ linkset: links }, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLink(value: unknown): Link {
  if (!isRecord(value)) throw new Error('linkset entry must be an object')
  const anchor = value['anchor']
  const uri = value['uri']
  const rel = value['rel']
  if (typeof anchor !== 'string' || typeof uri !== 'string' || typeof rel !== 'string') {
    throw new Error('link requires string anchor, uri and rel')
  }
  return value as unknown as Link
}

/** Parse a linkset document: a full `{ "linkset": [...] }` document, a
 *  bare array, or a single link object. */
export function parseLinkset(document: string): Linkset {
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch (cause) {
    throw new Error(`invalid linkset JSON: ${String(cause)}`)
  }
  if (Array.isArray(parsed)) return { linkset: parsed.map(parseLink) }
  if (isRecord(parsed)) {
    if (Array.isArray(parsed['linkset'])) return { linkset: (parsed['linkset'] as unknown[]).map(parseLink) }
    return { linkset: [parseLink(parsed)] }
  }
  throw new Error('linkset document must be an object or array')
}
