-- UniDPP identity — schema v1 .
--
-- Doctrine (adapted from oimlsmart/identity's org registry):
--   - actors are the registry's first-class citizens: organizations and
--     qualified persons carrying roles, never merged (one legal body
--     MAY hold several actor rows);
--   - the lifecycle is active | disabled — a disabled actor admits no
--     new credentials and its credentials stop minting tokens;
--   - credentials carry an audience + a scope allowlist (least
--     privilege at write, narrowed per request at mint);
--   - the signing keys table carries the JWKS history (one ES256 pair
--     per deployment, kid'd, expand-only — no renumbering).

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  jurisdiction TEXT,
  registration_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_actors_kind ON actors(kind);

CREATE TABLE actor_roles (
  actor_id TEXT NOT NULL REFERENCES actors(id),
  role TEXT NOT NULL,
  PRIMARY KEY (actor_id, role)
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  audience TEXT NOT NULL,
  scopes TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);

CREATE INDEX idx_credentials_actor ON credentials(actor_id);

CREATE TABLE signing_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  declared INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT NOT NULL
);
