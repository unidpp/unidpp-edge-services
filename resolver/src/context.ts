// L5 context routing (ported from @unidpp/resolver contextKey.ts — the
// proven scoring table, byte-for-byte semantics):
//
// | dimension | wildcard link | specific link, no request pref | exact | fallback |
// |---|---|---|---|---|
// | profile / role / region | 1 | 2 | 4 | — (mismatch: no match) |
// | language (hreflang) | 1 | 2 | 4 | 3 (primary subtag) |
//
// Ties break by first-in-document (registration) order — deterministic.

/** Request context; undefined on a dimension = no preference (wildcard). */
export interface RequestContext {
  profile?: string
  role?: string
  language?: string
  region?: string
}

export function isContextEmpty(ctx: RequestContext): boolean {
  return ctx.profile === undefined && ctx.role === undefined && ctx.language === undefined && ctx.region === undefined
}

/** Canonical routing-key display, wildcards explicit. */
export function contextKey(ctx: RequestContext): string {
  const value = (v: string | undefined): string => v ?? '*'
  return `profile=${value(ctx.profile)};role=${value(ctx.role)};lang=${value(ctx.language)};region=${value(ctx.region)}`
}

/** Primary subtag: "fr-CA" -> "fr". */
export function primarySubtag(language: string): string {
  return language.split('-')[0] ?? language
}

function dimScore(link: string | undefined, ctx: string | undefined): number | null {
  const lp = link ?? '*'
  if (ctx === undefined || lp === '*') return lp === '*' ? 1 : 2
  if (lp === ctx) return 4
  return null
}

function languageScore(linkLangs: readonly string[], ctx: string | undefined): number | null {
  const wildcard = linkLangs.length === 0 || linkLangs.includes('*')
  if (ctx === undefined) return wildcard ? 1 : 2
  if (wildcard) return 1
  if (linkLangs.includes(ctx)) return 4
  if (linkLangs.some((l) => primarySubtag(l) === primarySubtag(ctx))) return 3
  return null
}

/** The routing dimensions a store entry carries. */
export interface EntryRouting {
  linkType: string
  profile?: string
  role?: string
  languages: readonly string[]
  region?: string
}

/** Specificity score of an entry against a request context for
 *  `linkType`; null = no match. */
export function scoreEntry(routing: EntryRouting, ctx: RequestContext, linkType: string): number | null {
  if (routing.linkType !== linkType) return null
  const profile = dimScore(routing.profile, ctx.profile)
  const role = dimScore(routing.role, ctx.role)
  const region = dimScore(routing.region, ctx.region)
  const language = languageScore(routing.languages, ctx.language)
  if (profile === null || role === null || region === null || language === null) return null
  return profile + role + region + language
}
