// The KV linkset store: identifier → linkset entries with context
// routing dimensions, as-of/expiry validity, dark-identity marking,
// and the append-only ops log (I4 doctrine: nothing is edited in
// place — updates are appended registrations plus revocations; the
// log never leaves the admin boundary).
//
// Layout (namespace LINKSETS):
//   id:{scheme}:{value}     the entries document: { seq, dark, updatedAt, entries[] }
//   log:{seq}               one append-only record per admin operation
//   meta:log-seq            the log's high-water mark
//
// I12 enumeration resistance: dark identifiers are indistinguishable
// from unknown ones at the public surface (the Lookup type); there is
// no listing endpoint; the log is admin-only.
//
// NOTE on KV consistency: Cloudflare KV is eventually consistent
// cross-PoP; the single-operator demo posture (one writer, TTL-free
// small documents) keeps the window negligible, and every read path
// is idempotent. A multi-region writer federation would move the ops
// log to Durable Objects (the operator-model §6 seam).

import type { EntryRouting, RequestContext } from './context'
import { scoreEntry } from './context'
import { nowRfc3339, parseRfc3339 } from './time'

export interface LinkEntry {
  id: number
  linkType: string
  href: string
  title?: string
  mediaType?: string
  profile?: string
  role?: string
  languages: string[]
  region?: string
  asOf: string
  expiry?: string
}

interface EntriesDocument {
  seq: number
  dark: boolean
  updatedAt: string
  entries: LinkEntry[]
}

export type Lookup =
  | { kind: 'absent' }
  | { kind: 'dark' }
  | { kind: 'resolved'; entries: LinkEntry[]; updatedAt: string }

export interface OpRecord {
  seq: number
  at: string
  op: 'register' | 'replace' | 'revoke' | 'dark' | 'clear-dark'
  identifier: string
  detail: Record<string, unknown>
}

export interface AdminLinkInput {
  linkType?: unknown
  href?: unknown
  title?: unknown
  type?: unknown
  profile?: unknown
  role?: unknown
  language?: unknown
  region?: unknown
  asOf?: unknown
  expiry?: unknown
}

const MAX_ENTRIES = 64

/** The write-time validation of one admin link object. Pure. */
export function linkEntryFromAdmin(input: AdminLinkInput, id: number, defaultAsOf: string): { entry: LinkEntry | null; error: string | null } {
  const str = (v: unknown): string | null | undefined => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') return undefined
    const trimmed = v.trim()
    return trimmed === '' || trimmed === '*' ? null : trimmed
  }
  const linkType = str(input.linkType)
  if (linkType === undefined) return { entry: null, error: 'linkType must be a string' }
  if (linkType === null) return { entry: null, error: 'linkType is required (the RFC 9264 rel)' }
  const href = str(input.href)
  if (href === undefined) return { entry: null, error: 'href must be a string' }
  if (href === null) return { entry: null, error: 'href is required (the target URI)' }
  const languagesIn = input.language
  let languages: string[]
  if (languagesIn === undefined || languagesIn === null) {
    languages = []
  } else if (typeof languagesIn === 'string') {
    languages = languagesIn === '' || languagesIn === '*' ? [] : [languagesIn]
  } else if (Array.isArray(languagesIn) && languagesIn.every((l) => typeof l === 'string')) {
    languages = (languagesIn as string[]).filter((l) => l !== '' && l !== '*')
  } else {
    return { entry: null, error: 'language must be a string or a list of strings' }
  }
  const asOf = str(input.asOf)
  if (asOf !== null && asOf !== undefined && parseRfc3339(asOf) === null) {
    return { entry: null, error: 'asOf must be an RFC 3339 timestamp' }
  }
  const expiry = str(input.expiry)
  if (expiry === undefined) return { entry: null, error: 'expiry must be a string' }
  if (expiry !== null && parseRfc3339(expiry) === null) {
    return { entry: null, error: 'expiry must be an RFC 3339 timestamp' }
  }
  const effectiveAsOf = asOf ?? defaultAsOf
  if (expiry !== null && parseRfc3339(expiry)! < parseRfc3339(effectiveAsOf)!) {
    return { entry: null, error: `expiry ${expiry} before asOf ${effectiveAsOf}` }
  }
  const entry: LinkEntry = {
    id,
    linkType,
    href,
    ...(str(input.title) !== null && str(input.title) !== undefined ? { title: str(input.title)! } : {}),
    ...(str(input.type) !== null && str(input.type) !== undefined ? { mediaType: str(input.type)! } : {}),
    ...(str(input.profile) !== null && str(input.profile) !== undefined ? { profile: str(input.profile)! } : {}),
    ...(str(input.role) !== null && str(input.role) !== undefined ? { role: str(input.role)! } : {}),
    languages,
    ...(str(input.region) !== null && str(input.region) !== undefined ? { region: str(input.region)! } : {}),
    asOf: effectiveAsOf,
    ...(expiry !== null ? { expiry } : {}),
  }
  return { entry, error: null }
}

/** Effective at instant `t`? (Entry validity, ignoring revocations.) */
export function entryValidAt(entry: LinkEntry, tMs: number): boolean {
  const from = parseRfc3339(entry.asOf) ?? 0
  if (tMs < from) return false
  if (entry.expiry !== undefined) {
    const until = parseRfc3339(entry.expiry)
    if (until !== null && tMs > until) return false
  }
  return true
}

/** Routing view for context scoring. */
export function routingOf(entry: LinkEntry): EntryRouting {
  return {
    linkType: entry.linkType,
    ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
    ...(entry.role !== undefined ? { role: entry.role } : {}),
    languages: entry.languages,
    ...(entry.region !== undefined ? { region: entry.region } : {}),
  }
}

export interface ScoredEntry {
  entry: LinkEntry
  score: number
}

/** Select and order the destinations for a request context: exact
 *  matches outrank wildcards; language falls back to the primary
 *  subtag; descending score, ties by registration order. */
export function selectOrdered(entries: readonly LinkEntry[], ctx: RequestContext, linkType: string): ScoredEntry[] {
  const scored: ScoredEntry[] = []
  for (const entry of entries) {
    const score = scoreEntry(routingOf(entry), ctx, linkType)
    if (score !== null) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** The KV-backed linkset store (one class, one aggregate: the
 *  identifier's document + its ops log). */
export class LinkStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly prefix = '',
  ) {}

  private idKey(key: string): string {
    return `${this.prefix}id:${key}`
  }

  private logKey(seq: number): string {
    return `${this.prefix}log:${String(seq).padStart(10, '0')}`
  }

  private async readDocument(key: string): Promise<EntriesDocument | null> {
    const raw = await this.kv.get(this.idKey(key))
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as EntriesDocument
      if (!Array.isArray(parsed.entries) || typeof parsed.dark !== 'boolean') return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeDocument(key: string, doc: EntriesDocument, record: Omit<OpRecord, 'seq' | 'at'>): Promise<OpRecord> {
    const now = nowRfc3339()
    doc.updatedAt = now
    await this.kv.put(this.idKey(key), JSON.stringify(doc))
    const seq = await this.bumpSeq()
    const op: OpRecord = { seq, at: now, ...record }
    await this.kv.put(this.logKey(seq), JSON.stringify(op))
    return op
  }

  private async bumpSeq(): Promise<number> {
    const current = Number(await this.kv.get(`${this.prefix}meta:log-seq`) ?? '0')
    const next = current + 1
    await this.kv.put(`${this.prefix}meta:log-seq`, String(next))
    return next
  }

  /** The public lookup: absent, dark, or resolved with the effective
   *  entries and the document's generation timestamp (I12: dark and
   *  absent are indistinguishable downstream — the caller answers
   *  both with the byte-identical 404). */
  async lookup(key: string, atMs: number): Promise<Lookup> {
    const doc = await this.readDocument(key)
    if (doc === null) return { kind: 'absent' }
    if (doc.dark) return { kind: 'dark' }
    return { kind: 'resolved', entries: doc.entries.filter((e) => entryValidAt(e, atMs)), updatedAt: doc.updatedAt }
  }

  async register(key: string, entries: LinkEntry[]): Promise<{ doc: EntriesDocument; record: OpRecord }> {
    const doc = (await this.readDocument(key)) ?? { seq: 0, dark: false, updatedAt: nowRfc3339(), entries: [] }
    const nextId = doc.entries.reduce((max, e) => Math.max(max, e.id), 0)
    if (doc.entries.length + entries.length > MAX_ENTRIES) {
      throw new Error(`too many entries for one identifier (max ${MAX_ENTRIES})`)
    }
    doc.entries = [...doc.entries, ...entries.map((e, i) => ({ ...e, id: nextId + i + 1 }))]
    doc.seq += 1
    const record = await this.writeDocument(key, doc, { op: 'register', identifier: key, detail: { added: entries.length } })
    return { doc, record }
  }

  async replace(key: string, entries: LinkEntry[], effectiveAt: string): Promise<{ doc: EntriesDocument; record: OpRecord }> {
    const doc = (await this.readDocument(key)) ?? { seq: 0, dark: false, updatedAt: nowRfc3339(), entries: [] }
    const revoked = doc.entries.map((e) => e.id)
    doc.entries = entries.map((e, i) => ({ ...e, id: i + 1 }))
    doc.seq += 1
    const record = await this.writeDocument(key, doc, {
      op: 'replace',
      identifier: key,
      detail: { revoked, effectiveAt, registered: entries.length },
    })
    return { doc, record }
  }

  async revoke(key: string, entryId: number, effectiveAt: string, reason: string): Promise<OpRecord> {
    const doc = await this.readDocument(key)
    if (doc === null) throw new Error(`nothing registered for ${key}`)
    if (!doc.entries.some((e) => e.id === entryId)) {
      throw new Error(`entry ${entryId} is not registered for ${key}`)
    }
    doc.entries = doc.entries.filter((e) => e.id !== entryId)
    doc.seq += 1
    return this.writeDocument(key, doc, { op: 'revoke', identifier: key, detail: { entryId, effectiveAt, reason } })
  }

  async setDark(key: string, dark: boolean, effectiveAt: string): Promise<OpRecord> {
    const doc = (await this.readDocument(key)) ?? { seq: 0, dark: !dark, updatedAt: nowRfc3339(), entries: [] }
    doc.dark = dark
    doc.seq += 1
    return this.writeDocument(key, doc, {
      op: dark ? 'dark' : 'clear-dark',
      identifier: key,
      detail: { effectiveAt },
    })
  }

  /** The admin view of one identifier's document. */
  async adminView(key: string): Promise<EntriesDocument | null> {
    return this.readDocument(key)
  }

  async log(limit: number, offset: number): Promise<OpRecord[]> {
    const keys: string[] = []
    let cursor: string | undefined
    // Walk the log keys in KV lexicographic order (zero-padded seq).
    for (;;) {
      const list = await this.kv.list<{ seq: number }>({ prefix: `${this.prefix}log:`, cursor, limit: Math.min(limit + offset, 1000) })
      for (const k of list.keys) keys.push(k.name)
      if (list.list_complete) break
      cursor = list.cursor
    }
    const slice = keys.slice(Math.max(0, keys.length - offset - limit), keys.length - Math.min(offset, keys.length))
    const records: OpRecord[] = []
    for (const name of slice.reverse()) {
      const raw = await this.kv.get(name)
      if (raw === null) continue
      try {
        records.push(JSON.parse(raw) as OpRecord)
      } catch {
        // a malformed record is skipped, never fatal
      }
    }
    return records
  }
}
