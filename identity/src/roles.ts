// ═══════════════════════════════════════════════════════════════════
// The role catalog — the identity service's model core (PLAN-OPERATORS
// §2.2 adapted to TODO #13's registry scope).
//
// Every actor kind names its roles; every role carries:
//   - its PLAN-OPERATORS §2.2 anchor (the acting-rights source),
//   - the EN 18239-style class the credential maps to (the honest
//     mapping: where the EN has no role of its own, the nearest §4
//     stakeholder class is named AND the deviation is stated — never
//     a silent fit),
//   - the scope set: `defaultScopes` issued on a plain credential,
//     `allowedScopes` the ceiling a narrowed credential may carry
//     (least privilege at write, PLAN-OPERATORS §2.3's permission
//     matrices as the source of the verbs).
//
// OCP: adding a role = adding a catalog entry, never touching the
// registry or the credential machinery. Pure, worker-safe.
// ═══════════════════════════════════════════════════════════════════

/** EN 18239 §4 stakeholder classes (the credential's class vocabulary). */
export type En18239Class =
  | 'economic-operator'
  | 'customer'
  | 'professional-repairer'
  | 'independent-operator'
  | 'recycler'
  | 'market-surveillance-authority'
  | 'customs-authority'
  | 'dpp-service-provider'
  | 'espr-external-party'

/** The registry's actor kinds (the five TODO #13 names the demo cast). */
export type ActorKind = 'economic-operator' | 'installer' | 'repairer' | 'cab' | 'marketplace'

export const ACTOR_KINDS: readonly ActorKind[] = [
  'economic-operator',
  'installer',
  'repairer',
  'cab',
  'marketplace',
] as const

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === 'string' && (ACTOR_KINDS as readonly string[]).includes(value)
}

/** One role of the catalog. */
export interface RoleDefinition {
  key: string
  /** The PLAN-OPERATORS §2.2 anchor this role's acting rights come from. */
  planOperators: string
  /** The EN 18239-style class mapping (§4 stakeholder vocabulary). */
  en18239: { class: En18239Class; subkind?: string; note?: string }
  /** Scopes a plain credential for this role carries by default. */
  defaultScopes: string[]
  /** The ceiling: every scope a credential for this role may be narrowed to. */
  allowedScopes: string[]
}

/** A catalog kind: the kind plus the roles an actor of this kind may hold. */
export interface ActorKindDefinition {
  kind: ActorKind
  description: string
  roles: RoleDefinition[]
}

const EO_SCOPES: Record<'manufacturer' | 'importer' | 'distributor', { default: string[]; allowed: string[] }> = {
  manufacturer: {
    default: [
      'passport:issue:type',
      'passport:issue:instance',
      'passport:issue:batch',
      'event:append:issuance',
      'event:append:correction',
      'event:propose:recall',
      'read:own',
    ],
    allowed: ['event:append:ota'],
  },
  importer: {
    default: ['passport:issue:instance', 'event:append:issuance', 'read:own'],
    allowed: [],
  },
  distributor: {
    default: ['read:public', 'render:consumer'],
    allowed: [],
  },
}

function eoRole(subkind: string, planOperators: string, scopes: { default: string[]; allowed: string[] }): RoleDefinition {
  return {
    key: `eo:${subkind}`,
    planOperators,
    en18239: { class: 'economic-operator', subkind },
    defaultScopes: [...scopes.default],
    allowedScopes: [...new Set([...scopes.default, ...scopes.allowed])].sort(),
  }
}

export const ACTOR_KIND_CATALOG: Readonly<Record<ActorKind, ActorKindDefinition>> = {
  'economic-operator': {
    kind: 'economic-operator',
    description:
      'Economic operator (PLAN-OPERATORS §2.2-1..2): the top-level EN 18239 §4.1 role — manufacturer, authorized representative, importer, distributor, dealer, fulfilment service provider.',
    roles: [
      eoRole('manufacturer', '§2.2-1', EO_SCOPES.manufacturer),
      eoRole('authorized-representative', '§2.2-1 (mandate posture)', EO_SCOPES.distributor),
      eoRole('importer', '§2.2-2', EO_SCOPES.importer),
      eoRole('distributor', '§2.2-1 (supply chain)', EO_SCOPES.distributor),
      eoRole('dealer', '§2.2-1 (end-user sale)', EO_SCOPES.distributor),
      eoRole('fulfilment-service-provider', '§2.2-1 (no ownership)', EO_SCOPES.distributor),
    ],
  },
  installer: {
    kind: 'installer',
    description: 'Installer (PLAN-OPERATORS §2.2-9): R3 install/uninstall events with re-identification records.',
    roles: [
      {
        key: 'installer',
        planOperators: '§2.2-9',
        en18239: {
          class: 'independent-operator',
          note: 'EN 18239 §4.2 names installers only inside the independent-operator orbit (training for installers; manufacturers or distributors of repair equipment, tools or spare parts) — the EN has no installer role of its own; this registry records the nearest class and the deviation.',
        },
        defaultScopes: ['event:append:install', 'event:append:uninstall', 'read:scoped'],
        allowedScopes: ['event:append:install', 'event:append:uninstall', 'read:scoped'],
      },
    ],
  },
  repairer: {
    kind: 'repairer',
    description:
      'Repairer (PLAN-OPERATORS §2.2-10): authorized, independent, or DIY — E2/E3 repair and maintenance events under right-to-repair profile rules (the EN 18239 role analog).',
    roles: [
      {
        key: 'repairer:authorized',
        planOperators: '§2.2-10',
        en18239: { class: 'professional-repairer', subkind: 'authorized' },
        defaultScopes: ['event:append:repair', 'event:append:maintenance', 'read:scoped'],
        allowedScopes: ['event:append:repair', 'event:append:maintenance', 'read:scoped', 'read:tier-b'],
      },
      {
        key: 'repairer:independent',
        planOperators: '§2.2-10',
        en18239: { class: 'independent-operator', subkind: 'independent-repairer' },
        defaultScopes: ['event:append:repair', 'event:append:maintenance', 'read:scoped'],
        allowedScopes: ['event:append:repair', 'event:append:maintenance', 'read:scoped'],
      },
    ],
  },
  cab: {
    kind: 'cab',
    description:
      'Conformity assessment body / test laboratory (PLAN-OPERATORS §2.2-17): measurement-class events with method, GUM uncertainty and registered units.',
    roles: [
      {
        key: 'cab:test-laboratory',
        planOperators: '§2.2-17',
        en18239: {
          class: 'independent-operator',
          subkind: 'inspection-and-testing',
          note: 'EN 18239 §4.2 includes operators offering inspection and testing services among the independent operators; the notified-actor credential posture (EN 18239 §5) is how such actors access controlled data without per-EO approval.',
        },
        defaultScopes: ['event:append:measurement', 'read:tier-b'],
        allowedScopes: ['event:append:measurement', 'read:tier-b', 'event:append:test-report'],
      },
    ],
  },
  marketplace: {
    kind: 'marketplace',
    description:
      'Marketplace operator (PLAN-OPERATORS §2.2-20): runs predicates, not copies — listing gates evaluate registered predicates without holding passport data; serves consumer presentation renders.',
    roles: [
      {
        key: 'marketplace:operator',
        planOperators: '§2.2-20',
        en18239: {
          class: 'economic-operator',
          subkind: 'dealer',
          note: 'EN 18239 §4.2 includes dealers offering products for sale through distance selling — the nearest class to a marketplace operator; the predicate-runner posture (no passport copies) is UniDPP §2.2-20\'s extension, stated rather than implied.',
        },
        defaultScopes: ['predicate:evaluate', 'render:consumer', 'read:public'],
        allowedScopes: ['predicate:evaluate', 'render:consumer', 'read:public', 'report:aggregate'],
      },
    ],
  },
}

/** All roles a kind admits. */
export function rolesForKind(kind: ActorKind): RoleDefinition[] {
  return ACTOR_KIND_CATALOG[kind].roles
}

/** The write-time role validation (an actor of kind K may hold exactly
 *  the roles K's catalog names — nothing else). */
export function roleDefinition(kind: ActorKind, role: string): RoleDefinition | null {
  return ACTOR_KIND_CATALOG[kind].roles.find((r) => r.key === role) ?? null
}

/** The credential projection for an actor's held roles: the EN 18239
 *  classes (one per role — the credential names them all, the relying
 *  service reads the class it enforces) and the scope ceiling (union
 *  across roles: an actor with two roles may spend either). */
export interface CredentialProjection {
  en18239Classes: { class: En18239Class; subkind?: string; role: string; note?: string }[]
  defaultScopes: string[]
  allowedScopes: string[]
}

export function credentialProjection(kind: ActorKind, roles: string[]): CredentialProjection {
  const defs = roles.map((role) => roleDefinition(kind, role)).filter((d): d is RoleDefinition => d !== null)
  return {
    en18239Classes: defs.map((d) => ({
      class: d.en18239.class,
      ...(d.en18239.subkind !== undefined ? { subkind: d.en18239.subkind } : {}),
      role: d.key,
      ...(d.en18239.note !== undefined ? { note: d.en18239.note } : {}),
    })),
    defaultScopes: [...new Set(defs.flatMap((d) => d.defaultScopes))].sort(),
    allowedScopes: [...new Set(defs.flatMap((d) => d.allowedScopes))].sort(),
  }
}
