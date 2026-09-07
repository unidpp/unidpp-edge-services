#!/usr/bin/env bash
# Seed the REMOTE resolver KV with the demo linksets + dark identity
# . Idempotent: PUT overwrites. Run from the repo root:
#   scripts/seed-resolver-remote.sh
# Requires CLOUDFLARE_API_TOKEN (account UniDPP) — never commit it.
set -euo pipefail
cd "$(dirname "$0")/../resolver"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (read it from ~/.config/cloudflare-tokens/unidpp-admin)}"
ADMIN_TOKEN="$(grep '^RESOLVER_ADMIN_TOKEN=' ../.env.secrets | cut -d= -f2-)"

# 1. The ISO 15459 demo instance: the full five-link cast (eu-customs →
#    EN 18222, jp-consumer → GB/T 33993, machine → UNTP, wildcard, recycler).
cat <<'EOF' >/tmp/unidpp-seed-iso.json
{
  "identifier": "iso-15459:urn:iso:std:iso-iec:15459:unidpp:inst:84120099012345",
  "links": [
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/eu/84120099012345", "title": "EU customs view — EN 18222 REST render", "type": "application/json", "profile": "urn:unidpp:profile:eu-espr-electronics", "role": "customs", "region": "EU", "language": ["en"] },
    { "linkType": "dpp", "href": "https://dpp-jp.meti.example.go.jp/passport/84120099012345", "title": "JP consumer view — GB/T 33993 render", "type": "application/xml", "profile": "urn:unidpp:profile:jp-meti-pse", "role": "consumer", "region": "JP", "language": ["ja"] },
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/untp/84120099012345", "title": "Machine view — UNTP verifiable credential render", "type": "application/ld+json", "role": "machine" },
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/generic/84120099012345", "title": "Generic destination (wildcard)", "type": "application/json", "language": ["*"] },
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/recycler/84120099012345", "title": "Recycler-role destination", "role": "recycler", "language": ["en"] }
  ]
}
EOF
curl -sf -X PUT "https://resolve.unidpp.org/admin/linksets" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary @/tmp/unidpp-seed-iso.json
echo

# 2. The GS1 item (06901234567892 serial AB2026111): customs + machine + wildcard.
cat <<'EOF' >/tmp/unidpp-seed-gs1-item.json
{
  "identifier": "gs1:(01)06901234567892(21)AB2026111",
  "links": [
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/eu/06901234567892", "title": "EU customs view — EN 18222 REST render", "type": "application/json", "profile": "urn:unidpp:profile:eu-espr-electronics", "role": "customs", "region": "EU", "language": ["en"] },
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/untp/06901234567892", "title": "Machine view — UNTP verifiable credential render", "type": "application/ld+json", "role": "machine" },
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/generic/06901234567892", "title": "Generic destination (wildcard)", "type": "application/json", "language": ["*"] }
  ]
}
EOF
curl -sf -X PUT "https://resolve.unidpp.org/admin/linksets" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary @/tmp/unidpp-seed-gs1-item.json
echo

# 3. The GS1 model (09506000134352): the wildcard default alone.
cat <<'EOF' >/tmp/unidpp-seed-gs1-model.json
{
  "identifier": "gs1:(01)09506000134352",
  "links": [
    { "linkType": "dpp", "href": "https://dpp.unidpp.org/generic/09506000134352", "title": "Generic destination (wildcard)", "type": "application/json", "language": ["*"] }
  ]
}
EOF
curl -sf -X PUT "https://resolve.unidpp.org/admin/linksets" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary @/tmp/unidpp-seed-gs1-model.json
echo

# 4. The dark identity (I12 demo: byte-identical 404 at the public surface).
curl -sf -X POST "https://resolve.unidpp.org/admin/dark" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"identifier":"iso-15459:urn:iso:std:iso-iec:15459:unidpp:inst:00000000000000","dark":true}'
echo
echo "seeded."
