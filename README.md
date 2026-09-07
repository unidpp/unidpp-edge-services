# unidpp-edge-services

Cloudflare Workers for the UniDPP discovery registry (PLAN-OPERATORS §1, §6):
an **identity** worker (actor registry + scoped API credentials) and a
**resolver** worker (RFC 9264 linksets with per-context routing) —
**TODO #13** and **TODO #22** of the JTC 5 plenary readiness plan, deployed
to `identity.unidpp.org` and `resolve.unidpp.org`.

The design adapts two proven reference surfaces:

- **oimlsmart/identity** (the OIDC provider patterns) — the
  organization-registry lifecycle, the service-client credential
  doctrine (id / org / audience / scope allowlist, scope narrowing,
  ES256 JWT claims), the signing-key rotation history in the database,
  the dev-vs-declared key gate.
- **unidpp-resolver** (the Rust reference, a port of `@unidpp/resolver`)
  — RFC 9264 linksets, the context-scoring table (exact > primary-subtag
  fallback > specific-no-pref > wildcard, mismatch kills), the GS1
  Digital Link and GB/T 33993 carrier grammars, dark-identity 404
  indistinguishability (I12), the as-of stamp doctrine (I13).

## Layout

```
unidpp-edge-services/
  identity/   the actor registry Worker
    src/
      index.ts        fetch router
      roles.ts        PLAN-OPERATORS §2.2 → EN 18239 mapping catalog
      actors.ts       actor registry repository (D1)
      credentials.ts  API credential issuance + scope narrowing + token claims
      signing.ts      ES256 keys, JWKS registration, signed-response doctrine
      http.ts         response helpers
      time.ts         RFC 3339
      store.ts        D1 store seam (typed accessors)
      seed.ts         the demo seed actors
    migrations/0001_init.sql
  resolver/   the linkset Worker
    src/
      index.ts        fetch router
      context.ts      the context scoring table (port of @unidpp/resolver)
      linkset.ts      RFC 9264 emit/parse
      carrier.ts      GS1 DL + GB/T + ISO 15459 carrier normalization
      gs1.ts          GS1 check-digit math
      store.ts        KV linkset store + dark marking + ops log
      seed.ts         the demo seed linksets
      time.ts         RFC 3339
```

## Develop

```sh
npm install            # workspaces: identity + resolver
npm test               # vitest-pool-workers (real D1 + KV inside workerd)
npm run typecheck      # tsc --noEmit per workspace
npm run dev:identity   # wrangler dev in identity/
npm run dev:resolver   # wrangler dev in resolver/
```

## Deploy (TODO #22 + #13 + PLAN-OPERATORS §6)

Done 2026-09-07 (account `UniDPP` `af1920686175ca6d92a677e02bdda75d`, zone
`unidpp.org` `5912805a2be5db3c5070e4063746de9e`):

- **D1** `unidpp-identity-db` `4b5adbe5-5868-420a-a39d-4a963c248fe6` —
  created, migrations 0001 (schema) + 0002 (demo actors) applied
  remotely; the five §2.2 demo actors are live in the registry.
- **KV** `LINKSETS` `b499e7779f3e47bf90e4cffb13ff420f` — created and
  seeded: the ISO 15459 demo instance (5 links: eu-customs → EN 18222,
  jp-consumer → GB/T 33993, machine → UNTP, wildcard, recycler), the
  GS1 item and model demos, the dark identity, plus the ops log + seq.
- **Secrets**: `IDENTITY_SIGNING_KEY` (EC P-256 JWK, kid
  `unidpp-identity-2026-09-07`), `IDENTITY_ADMIN_TOKEN`,
  `RESOLVER_ADMIN_TOKEN` — generated locally into `.env.secrets`
  (chmod 600, gitignored), uploaded via `wrangler secret put`.
- **Workers** `unidpp-identity` and `unidpp-resolver` — deployed, 100%
  traffic, production environment.

Re-run from scratch:

```sh
export CLOUDFLARE_API_TOKEN="$(awk -F' = ' '/^api_token/{print $2}' ~/.config/cloudflare-tokens/unidpp-admin)"
cd identity  && wrangler d1 migrations apply unidpp-identity-db --remote && wrangler deploy
cd ../resolver && wrangler deploy
scripts/seed-resolver-remote.sh   # once the routes are attached (below)
```

### The one blocked step: the custom-domain routes

`wrangler deploy` uploads and deploys fine, then fails attaching
`identity.unidpp.org` / `resolve.unidpp.org` — the deploy token
(the `unidpp-admin` API token) has **no zone-scoped permissions**:

| Operation | API | Result |
|---|---|---|
| List zone Workers routes | `GET /zones/{zone}/workers/routes` | 403 — missing **Zone → Workers Routes : Read/Edit** |
| Create custom domain | `POST /accounts/{acc}/workers/domains` | 10405 "Method not allowed for this authentication scheme" — not permitted for this token type; needs Workers Routes Edit on the zone (or a user-token dash flow) |
| DNS records | `GET/POST /zones/{zone}/dns_records` | 10000 — missing **Zone → DNS : Read/Edit** |
| workers.dev subdomain (fallback) | `POST /accounts/{acc}/workers/subdomain` | 10405 — dash-only onboarding action: https://dash.cloudflare.com/af1920686175ca6d92a677e02bdda75d/workers/onboarding |

To finish (either): (a) edit the token in the dash to add *Zone →
Workers Routes : Edit* + *Zone → DNS : Edit* for `unidpp.org`, then
re-run `wrangler deploy` in both workspaces (it attaches the custom
domains and creates the DNS records itself); or (b) once, in the dash:
Workers → onboarding (registers the workers.dev subdomain) and add the
two custom domains on the workers' Settings → Domains. Verification
after attaching: `curl https://identity.unidpp.org/healthz`,
`curl "https://resolve.unidpp.org/resolve?identifier=iso-15459%3Aurn%3Aiso%3Astd%3Aiso-iec%3A15459%3Aunidpp%3Ainst%3A84120099012345&role=machine"`
(the KV is already seeded, so the linkset comes back immediately).

The deployment token (account `UniDPP`, zone `unidpp.org`) lives at
`~/.config/cloudflare-tokens/unidpp-admin` — never commit it; the deploy
commands above read it from there. The worker secrets (signing key +
admin tokens) live in `.env.secrets` at the repo root (chmod 600,
gitignored — generated 2026-09-07; regenerate with a fresh EC P-256 JWK
if lost, but that would orphan tokens minted under the old key).

## Continuity obligations (TODO #22)

- **resolver**: continuity via KV replication + the append-only ops log
  (the ops log carries every registration, replacement, revocation,
  and dark marking — replaying it on a successor rebuilds state).
  Cross-region failover: an R2 mirror of the KV namespace is the next
  step (PLAN-OPERATORS §6).
- **identity**: continuity via D1 time-travel (Cloudflare retains 30
  days of point-in-time recovery) plus the standard backup of
  `actors`, `actor_roles`, `credentials`, and `signing_keys`.
- **both**: every JSON response is ES256-signed under the kid in the
  `X-UNIDPP-Kid` header — a relying service that fetched the JWKS at
  deploy time can still verify in-flight after the signing key rotates.

## Documentation contracts

- Identity: GET / → discovery, GET /roles → the EN 18239-mapping catalog.
- Resolver: GET / and /.well-known/unidpp-resolver → discovery (with the
  `demoContexts` table naming the three render bindings).

## Doctrine references

- PLAN-OPERATORS.md §2.2 (role catalog), §2.3 (permission matrices),
  §3 (federation charter), §6 (Cloudflare deployment map).
- UNIDPP_PLAN.md §4 (semantic layer), §5 (trust layer), §7 (resolver spec).
- oimlsmart/identity README + auth/op/keys.ts + auth/op/service-clients.ts.
- unidpp-resolver src/{linkset,context,carrier,store}.rs + tests/integration.rs.
