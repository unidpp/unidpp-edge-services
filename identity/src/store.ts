// The D1 store seam: typed table accessors for the identity schema.
// MECE: this module owns the SQL; every domain module consumes it
// through the narrow table interfaces (D1PreparedStatement only).

import type { D1Database } from '@cloudflare/workers-types'

export interface SigningKeysTable {
  prepare(query: string): D1PreparedStatement
}

export interface ActorsTable {
  prepare(query: string): D1PreparedStatement
}

export interface CredentialsTable {
  prepare(query: string): D1PreparedStatement
}

export interface Store {
  signingKeys: SigningKeysTable
  actors: ActorsTable
  credentials: CredentialsTable
}

/** The D1 store (the only implementation; the interfaces exist so the
 *  domain modules never name D1 types). */
export function d1Store(db: D1Database): Store {
  return {
    signingKeys: db,
    actors: db,
    credentials: db,
  }
}
