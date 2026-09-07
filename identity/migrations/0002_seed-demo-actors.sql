-- Remote seed of the demo actors (TODO #13 / PLAN-OPERATORS §2.2 demo
-- cast) into the production D1. Idempotent: INSERT OR IGNORE.
-- Values mirror identity/src/seed.ts exactly (the test suite's fixtures).

INSERT OR IGNORE INTO actors (id, kind, name, jurisdiction, registration_ref, status, metadata, created_at, updated_at) VALUES
  ('eo-demo-acme', 'economic-operator', 'Acme Monomers Demo EO', 'DE', 'DE-HRB-2026-0042', 'active', '{"note":"demo economic operator for the JTC 5 plenary readiness cast","wave":"4a"}', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'),
  ('installer-demo-berlin', 'installer', 'BerlinTrade Installer Demo', 'DE', 'BT-INSTALL-2026-014', 'active', '{"note":"demo installer for R3 install/uninstall events","wave":"4a"}', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'),
  ('repairer-demo-paris', 'repairer', 'Atelier Réparation Indépendant Demo', 'FR', 'FR-RIR-2026-009', 'active', '{"note":"demo authorized + independent repairer under right-to-repair profile","wave":"4a"}', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'),
  ('cab-demo-tuv', 'cab', 'TÜV-Testlab Demonstration CAB', 'DE', 'DAkkS-PL-2026-0381', 'active', '{"note":"demo conformity assessment body / test laboratory","wave":"4a"}', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'),
  ('marketplace-demo-rebay', 'marketplace', 'ReBay Marketplace Demo', NULL, 'EU-DSA-NOTIF-2026-0X', 'active', '{"note":"demo marketplace operator — predicate-runner posture","wave":"4a"}', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z');

INSERT OR IGNORE INTO actor_roles (actor_id, role) VALUES
  ('eo-demo-acme', 'eo:manufacturer'),
  ('eo-demo-acme', 'eo:importer'),
  ('eo-demo-acme', 'eo:dealer'),
  ('installer-demo-berlin', 'installer'),
  ('repairer-demo-paris', 'repairer:authorized'),
  ('repairer-demo-paris', 'repairer:independent'),
  ('cab-demo-tuv', 'cab:test-laboratory'),
  ('marketplace-demo-rebay', 'marketplace:operator');
