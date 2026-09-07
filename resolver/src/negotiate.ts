// Discovery-protocol content negotiation (PLAN-OPERATORS C4): an
// `Accept` header names the representation the client wants; the
// resolver answers with the linkset entry published for that
// representation's routing context (L5: linksets keyed by context).
//
// The mapping is a declarative table — media type → routing context
// (the role dimension) — never an if-else chain; adding a
// representation is adding a row. The table is applied only when the
// request carries no explicit context parameters (`profile` / `role`
// / `lang` / `region`): explicit parameters always outrank the Accept
// header, and the negotiated context flows through the same scoring
// machinery as an explicit one.

import type { RequestContext } from './context'

export interface AcceptContextRow {
  /** The representation media type. */
  readonly mediaType: string
  /** The routing context that selects the representation's entry. */
  readonly role: string
}

/** The Accept→context table: each row maps a representation media
 *  type to the linkset routing context that selects it. */
export const ACCEPT_CONTEXTS: readonly AcceptContextRow[] = [
  // UN Transparency Protocol verifiable credential — the
  // machine-to-machine render (`role=machine`).
  { mediaType: 'application/untp+json', role: 'machine' },
  // EN 18222 DPP API render — authority access, customs / market
  // surveillance (`role=customs`).
  { mediaType: 'application/en18222+json', role: 'customs' },
  // Human-facing browser view — the consumer destination
  // (`role=consumer`).
  { mediaType: 'text/html', role: 'consumer' },
]

interface MediaTypePreference {
  mediaType: string
  q: number
  index: number
}

/** The Accept header's media types in client-preference order:
 *  q-weight descending (client order breaking ties), `q=0`
 *  (explicitly not acceptable) dropped, media types lowercased (they
 *  are case-insensitive per RFC 9110). */
function mediaTypePreferences(accept: string): MediaTypePreference[] {
  const preferences: MediaTypePreference[] = []
  for (const [index, entry] of accept.split(',').entries()) {
    const [rawType = '', ...params] = entry.split(';')
    const mediaType = rawType.trim().toLowerCase()
    if (mediaType === '') continue
    const qParam = params.map((p) => /^q\s*=\s*(.+)$/.exec(p.trim())).find((m) => m !== null)
    const parsed = qParam === undefined ? 1 : Number(qParam[1])
    const q = Number.isFinite(parsed) ? parsed : 1
    if (q > 0) preferences.push({ mediaType, q, index })
  }
  preferences.sort((a, b) => b.q - a.q || a.index - b.index)
  return preferences
}

/** The routing context an `Accept` header selects: the client's most
 *  preferred media type that appears in the table (RFC 9110
 *  q-weights, client order breaking ties); null when nothing matches
 *  — plain no-context resolution. */
export function contextForAccept(accept: string | null): RequestContext | null {
  if (accept === null) return null
  for (const preference of mediaTypePreferences(accept)) {
    const row = ACCEPT_CONTEXTS.find((r) => r.mediaType === preference.mediaType)
    if (row !== undefined) return { role: row.role }
  }
  return null
}
