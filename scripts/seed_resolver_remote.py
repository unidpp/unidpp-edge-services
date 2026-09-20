#!/usr/bin/env python3
"""seed_resolver_remote.py — seed the REMOTE resolver with the demo
linksets and the dark identity (the successor of the shell script;
real code, no shell). Idempotent: PUT overwrites. Run from the repo
root:  python3 scripts/seed_resolver_remote.py

Requires RESOLVER_ADMIN_TOKEN (read from ../.env.secrets) and
CLOUDFLARE_API_TOKEN in the environment (account UniDPP — never
commit it).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

BASE = "https://resolve.unidpp.org"


def admin_token() -> str:
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        sys.exit("set CLOUDFLARE_API_TOKEN (read it from "
                 "~/.config/cloudflare-tokens/unidpp-admin)")
    try:
        with open("../.env.secrets", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("RESOLVER_ADMIN_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    sys.exit("RESOLVER_ADMIN_TOKEN not found in ../.env.secrets")


def put(path: str, body: dict, token: str) -> None:
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(f"{path}: {response.status}")


def post(path: str, body: dict, token: str) -> None:
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(f"{path}: {response.status}")


def main() -> None:
    token = admin_token()

    # 1. The ISO 15459 demo instance: the full five-link cast
    #    (eu-customs -> EN 18222, jp-consumer -> GB/T 33993, machine
    #    -> UNTP, wildcard, recycler).
    put(
        "/admin/linksets",
        {
            "identifier": "iso-15459:urn:iso:std:iso:iec:15459:unidpp:inst:84120099012345",
            "links": [
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/eu/84120099012345",
                 "title": "EU customs view — EN 18222 REST render", "type": "application/json",
                 "profile": "urn:unidpp:profile:eu-espr-electronics", "role": "customs",
                 "region": "EU", "language": ["en"]},
                {"linkType": "dpp", "href": "https://dpp-jp.meti.example.go.jp/passport/84120099012345",
                 "title": "JP consumer view — GB/T 33993 render", "type": "application/xml",
                 "profile": "urn:unidpp:profile:jp-meti-pse", "role": "consumer",
                 "region": "JP", "language": ["ja"]},
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/untp/84120099012345",
                 "title": "Machine view — UNTP verifiable credential render",
                 "type": "application/ld+json", "role": "machine"},
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/generic/84120099012345",
                 "title": "Generic destination (wildcard)", "type": "application/json",
                 "language": ["*"]},
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/recycler/84120099012345",
                 "title": "Recycler-role destination", "role": "recycler", "language": ["en"]},
            ],
        },
        token,
    )

    # 2. The GS1 item (06901234567892 serial AB2026111): customs +
    #    machine + wildcard.
    put(
        "/admin/linksets",
        {
            "identifier": "gs1:(01)06901234567892(21)AB2026111",
            "links": [
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/eu/06901234567892",
                 "title": "EU customs view — EN 18222 REST render", "type": "application/json",
                 "profile": "urn:unidpp:profile:eu-espr-electronics", "role": "customs",
                 "region": "EU", "language": ["en"]},
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/untp/06901234567892",
                 "title": "Machine view — UNTP verifiable credential render",
                 "type": "application/ld+json", "role": "machine"},
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/generic/06901234567892",
                 "title": "Generic destination (wildcard)", "type": "application/json",
                 "language": ["*"]},
            ],
        },
        token,
    )

    # 3. The GS1 model (09506000134352): the wildcard default alone.
    put(
        "/admin/linksets",
        {
            "identifier": "gs1:(01)09506000134352",
            "links": [
                {"linkType": "dpp", "href": "https://dpp.unidpp.org/generic/09506000134352",
                 "title": "Generic destination (wildcard)", "type": "application/json",
                 "language": ["*"]},
            ],
        },
        token,
    )

    # 4. The dark identity (I12 demo: byte-identical 404 at the
    #    public surface).
    post(
        "/admin/dark",
        {
            "identifier": "iso-15459:urn:iso:std:iso:iec:15459:unidpp:inst:00000000000000",
            "dark": True,
        },
        token,
    )
    print("seeded.")


if __name__ == "__main__":
    main()
