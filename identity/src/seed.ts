// The demo actor seed (operator-model §2.2 demo cast, mapped to the
// registry's five kinds). Exposed as plain data so the deploy script
// and the test suite seed the same fixtures — single source of truth.

import type { ActorKind } from './roles'

export interface SeedActor {
  id: string
  kind: ActorKind
  name: string
  jurisdiction: string | null
  registrationRef: string | null
  roles: string[]
  metadata: Record<string, unknown>
}

export const DEMO_ACTORS: SeedActor[] = [
  {
    id: 'eo-demo-acme',
    kind: 'economic-operator',
    name: 'Acme Monomers Demo EO',
    jurisdiction: 'DE',
    registrationRef: 'DE-HRB-2026-0042',
    roles: ['eo:manufacturer', 'eo:importer', 'eo:dealer'],
    metadata: { note: 'demo economic operator for the JTC 5 plenary readiness cast', wave: '4a' },
  },
  {
    id: 'installer-demo-berlin',
    kind: 'installer',
    name: 'BerlinTrade Installer Demo',
    jurisdiction: 'DE',
    registrationRef: 'BT-INSTALL-2026-014',
    roles: ['installer'],
    metadata: { note: 'demo installer for R3 install/uninstall events', wave: '4a' },
  },
  {
    id: 'repairer-demo-paris',
    kind: 'repairer',
    name: 'Atelier Réparation Indépendant Demo',
    jurisdiction: 'FR',
    registrationRef: 'FR-RIR-2026-009',
    roles: ['repairer:authorized', 'repairer:independent'],
    metadata: { note: 'demo authorized + independent repairer under right-to-repair profile', wave: '4a' },
  },
  {
    id: 'cab-demo-tuv',
    kind: 'cab',
    name: 'TÜV-Testlab Demonstration CAB',
    jurisdiction: 'DE',
    registrationRef: 'DAkkS-PL-2026-0381',
    roles: ['cab:test-laboratory'],
    metadata: { note: 'demo conformity assessment body / test laboratory', wave: '4a' },
  },
  {
    id: 'marketplace-demo-rebay',
    kind: 'marketplace',
    name: 'ReBay Marketplace Demo',
    jurisdiction: null,
    registrationRef: 'EU-DSA-NOTIF-2026-0X',
    roles: ['marketplace:operator'],
    metadata: { note: 'demo marketplace operator — predicate-runner posture', wave: '4a' },
  },
]
