// Carrier normalization (S1 seam — ported from @unidpp/resolver's
// carrier.ts + gs1dl.ts + gbt33993.ts, self-contained): translate
// whatever the physical carrier encodes into a normalized L0
// identifier. The carrier retains identity; resolution is reproducible.

import { validGtin } from './gs1'

export type IdentifierScheme = 'gs1' | 'gbt-33993' | 'iso-15459'
export type Granularity = 'item' | 'batch' | 'model'

export interface ProductIdentifier {
  scheme: IdentifierScheme
  value: string
  granularity: Granularity
}

export interface ResolvedIdentifier {
  identifier: ProductIdentifier
  /** The RFC 9264 anchor the linkset carries. */
  anchor: string
  /** The store key (scheme-scoped, colon-joined). */
  key: string
}

/** Linkset anchor for an identifier. URI-valued identifiers (15459
 *  URNs, GB/T custom-code URLs) anchor to themselves; GS1 identities
 *  anchor to the canonical element string (the identifier value — an
 *  opaque token for routing purposes, matching the Rust service). */
export function anchorOf(identifier: ProductIdentifier): string {
  return identifier.value
}

export function keyOf(identifier: ProductIdentifier): string {
  return `${identifier.scheme}:${identifier.value}`
}

function resolved(identifier: ProductIdentifier): ResolvedIdentifier {
  return { identifier, anchor: anchorOf(identifier), key: keyOf(identifier) }
}

/** ISO/IEC 15459 / EN 18219 URN carriers (our neutral primary scheme). */
const ISO15459_URN = /^urn:iso:std:iso-iec:15459[:#].+$/

const GS1_ELEMENT = /^\(01\)\d{14}((\(\d{2}\)[!%-?A-Z_a-z0-9]{1,20})*)$/

/** Parse the `identifier` query parameter: `scheme:value` where gs1
 *  values are canonical element strings ((01)…(21)…), iso-15459 values
 *  are 15459 URNs, gbt-33993 values are URLs. */
export function parseIdentifierParam(param: string): ResolvedIdentifier | null {
  const trimmed = param.trim()
  // The scheme prefix may be colon- or hash-delimited; we use colon (Rust parity).
  const separator = Math.min(...[':', '#'].map((d) => {
    const idx = trimmed.indexOf(d)
    return idx >= 0 ? idx : Number.POSITIVE_INFINITY
  }))
  if (!Number.isFinite(separator) || separator <= 0) return null
  const scheme = trimmed.slice(0, separator)
  const value = trimmed.slice(separator + 1)
  if (scheme === 'gs1') {
    if (!GS1_ELEMENT.test(value)) return null
    // Skip the "(01)" prefix (4 chars) to land on the 14-digit GTIN.
    const gtin = value.slice(4, 18)
    if (!validGtin(gtin)) return null
    const granularity: Granularity = value.includes('(21)') ? 'item' : value.includes('(10)') ? 'batch' : 'model'
    return resolved({ scheme: 'gs1', value, granularity })
  }
  if (scheme === 'iso-15459') {
    if (!ISO15459_URN.test(value)) return null
    return resolved({ scheme: 'iso-15459', value, granularity: 'item' })
  }
  if (scheme === 'gbt-33993') {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!/^https?:$/.test(url.protocol)) return null
    return resolved({ scheme: 'gbt-33993', value: url.toString(), granularity: 'item' })
  }
  return null
}

/** Parse a scanned carrier (S1): GS1 Digital Link URIs, GB/T 33993
 *  URLs and bare EAN-13s, ISO 15459 URNs. */
export function parseCarrier(scanned: string): { kind: string; identifier: ProductIdentifier } | null {
  const trimmed = scanned.trim()
  if (trimmed === '') return null

  // GS1 Digital Link: /01/GTIN[/10|21/…], AIs also as query params.
  try {
    const url = new URL(trimmed)
    if (/^https?:$/.test(url.protocol)) {
      const segments = url.pathname.split('/').filter((s) => s.length > 0)
      const pathAis: Record<string, string> = {}
      for (let i = 0; i + 1 < segments.length; i += 2) {
        const ai = segments[i] ?? ''
        if (/^\d{2}$/.test(ai) && ['01', '10', '21'].includes(ai)) pathAis[ai] = decodeURIComponent(segments[i + 1] ?? '')
      }
      const gtinRaw = pathAis['01'] ?? url.searchParams.get('01') ?? undefined
      if (gtinRaw !== undefined) {
        const gtin = gtinRaw.padStart(14, '0')
        if (/^\d{14}$/.test(gtin) && validGtin(gtin)) {
          const qualifier = (v: string | undefined): string | undefined =>
            v === undefined || v.length > 20 || !/^[!%-?A-Z_a-z0-9]{1,20}$/.test(v) ? undefined : v
          const lot = qualifier(pathAis['10'] ?? url.searchParams.get('10') ?? undefined)
          const serial = qualifier(pathAis['21'] ?? url.searchParams.get('21') ?? undefined)
          const value = `(01)${gtin}${lot !== undefined ? `(10)${lot}` : ''}${serial !== undefined ? `(21)${serial}` : ''}`
          return {
            kind: 'gs1-digital-link',
            identifier: {
              scheme: 'gs1',
              value,
              granularity: serial !== undefined ? 'item' : lot !== undefined ? 'batch' : 'model',
            },
          }
        }
      }
    }
  } catch {
    // not a URI — fall through
  }

  // GB/T 33993 GDS-style path: /g/<13-digit GTIN>[/<qualifier>].
  try {
    const url = new URL(trimmed)
    if (/^https?:$/.test(url.protocol)) {
      const match = /^\/g\/(\d{13})(?:\/([\w.-]{1,20}))?$/.exec(url.pathname)
      if (match !== null) {
        const gtin14 = (match[1] ?? '').padStart(14, '0')
        if (validGtin(gtin14)) {
          const qualifier = match[2]
          const serial = qualifier !== undefined && /[A-Za-z]/.test(qualifier) ? qualifier : undefined
          const lot = qualifier !== undefined && serial === undefined ? qualifier : undefined
          return {
            kind: 'gbt-33993-gds-path',
            identifier: {
              scheme: 'gs1',
              value: `(01)${gtin14}${lot !== undefined ? `(10)${lot}` : ''}${serial !== undefined ? `(21)${serial}` : ''}`,
              granularity: serial !== undefined ? 'item' : lot !== undefined ? 'batch' : 'model',
            },
          }
        }
      }
      // Other GB/T 33993 carriers (enterprise custom codes) keep their scheme.
      return { kind: 'gbt-33993-custom-code', identifier: { scheme: 'gbt-33993', value: url.toString(), granularity: 'item' } }
    }
  } catch {
    // fall through
  }

  // Bare legacy EAN-13 / GTIN-14 (GM2D transition).
  if (/^\d{13}$|^\d{14}$/.test(trimmed)) {
    const gtin = trimmed.padStart(14, '0')
    if (validGtin(gtin)) {
      return { kind: 'legacy-ean13', identifier: { scheme: 'gs1', value: `(01)${gtin}`, granularity: 'model' } }
    }
    return null
  }

  // ISO/IEC 15459 URN.
  if (ISO15459_URN.test(trimmed)) {
    return { kind: 'iso-15459-urn', identifier: { scheme: 'iso-15459', value: trimmed, granularity: 'item' } }
  }

  return null
}
