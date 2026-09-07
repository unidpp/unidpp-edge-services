// The demo seed linksets (TODO #22): the demo identities from
// unidpp-resolver's fixtures (the TS test suite's four-link cast plus
// the integration tests' GS1 identifiers), widened with the three
// per-context render bindings this edge deployment demonstrates:
//
//   eu-customs  → EN 18222 render   (profile eu-espr, role customs, region EU)
//   jp-consumer → GB/T 33993 render (profile jp-meti-pse, role consumer, lang ja, region JP)
//   machine     → UNTP render       (role machine, any profile/region)
//
// plus the wildcard default and the recycler-role link from the
// original fixture. "Their format is our profile" — PLAN-COMPETE
// play 2: the destinations are render bindings, the resolver stays
// neutral.

export interface SeedLinkset {
  /** The store key: `scheme:value`. */
  key: string
  /** The admin-body identifier parameter (same string). */
  identifier: string
  links: Record<string, unknown>[]
}

export const EU_PROFILE = 'urn:unidpp:profile:eu-espr-electronics'
export const JP_PROFILE = 'urn:unidpp:profile:jp-meti-pse'

export const ISO_DEMO = 'urn:iso:std:iso-iec:15459:unidpp:inst:84120099012345'
export const GS1_ITEM_DEMO = 'gs1:(01)06901234567892(21)AB2026111'
export const GS1_MODEL_DEMO = 'gs1:(01)09506000134352'
export const DARK_DEMO = 'urn:iso:std:iso-iec:15459:unidpp:inst:00000000000000'

/** The full five-link demo linkset for the ISO 15459 instance. */
export const ISO_DEMO_LINKS: Record<string, unknown>[] = [
  {
    linkType: 'dpp',
    href: 'https://dpp.unidpp.org/eu/84120099012345',
    title: 'EU customs view — EN 18222 REST render',
    type: 'application/json',
    profile: EU_PROFILE,
    role: 'customs',
    region: 'EU',
    language: ['en'],
  },
  {
    linkType: 'dpp',
    href: 'https://dpp-jp.meti.example.go.jp/passport/84120099012345',
    title: 'JP consumer view — GB/T 33993 render',
    type: 'application/xml',
    profile: JP_PROFILE,
    role: 'consumer',
    region: 'JP',
    language: ['ja'],
  },
  {
    linkType: 'dpp',
    href: 'https://dpp.unidpp.org/untp/84120099012345',
    title: 'Machine view — UNTP verifiable credential render',
    type: 'application/ld+json',
    role: 'machine',
  },
  {
    linkType: 'dpp',
    href: 'https://dpp.unidpp.org/generic/84120099012345',
    title: 'Generic destination (wildcard)',
    type: 'application/json',
    language: ['*'],
  },
  {
    linkType: 'dpp',
    href: 'https://dpp.unidpp.org/recycler/84120099012345',
    title: 'Recycler-role destination',
    role: 'recycler',
    language: ['en'],
  },
]

export const DEMO_LINKSETS: SeedLinkset[] = [
  {
    key: `iso-15459:${ISO_DEMO}`,
    identifier: ISO_DEMO,
    links: ISO_DEMO_LINKS,
  },
  {
    key: GS1_ITEM_DEMO,
    identifier: GS1_ITEM_DEMO,
    links: [
      {
        linkType: 'dpp',
        href: 'https://dpp.unidpp.org/eu/06901234567892',
        title: 'EU customs view — EN 18222 REST render',
        type: 'application/json',
        profile: EU_PROFILE,
        role: 'customs',
        region: 'EU',
        language: ['en'],
      },
      {
        linkType: 'dpp',
        href: 'https://dpp.unidpp.org/untp/06901234567892',
        title: 'Machine view — UNTP verifiable credential render',
        type: 'application/ld+json',
        role: 'machine',
      },
      { linkType: 'dpp', href: 'https://dpp.unidpp.org/generic/06901234567892', title: 'Generic destination (wildcard)', type: 'application/json', language: ['*'] },
    ],
  },
  {
    key: GS1_MODEL_DEMO,
    identifier: GS1_MODEL_DEMO,
    links: [{ linkType: 'dpp', href: 'https://dpp.unidpp.org/generic/09506000134352', title: 'Generic destination (wildcard)', type: 'application/json', language: ['*'] }],
  },
]

/** The dark identity to mark after seeding (I12 demo: the 404 is
 *  byte-identical to an unknown identifier's). */
export const DEMO_DARK = { identifier: `iso-15459:${DARK_DEMO}` }
