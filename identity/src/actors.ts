// The actor registry repository (adapted from oimlsmart/identity's
// org-registry lifecycle): organizations and qualified persons as
// first-class registry citizens, each carrying its the UniDPP operator model
// §2.2 roles; active or disabled; never deleted (the registry's
// history is the audit chain — a disabled actor is the guarded
// retirement, the oimlsmart pattern).
//
// WORKER-SAFE: the store seam only, pure validation separated from I/O.

import { isActorKind, type ActorKind, credentialProjection, roleDefinition, rolesForKind, type CredentialProjection } from './roles'
import type { ActorsTable } from './store'
import { nowRfc3339, parseRfc3339 } from './time'

export interface ActorRecord {
  id: string
  kind: ActorKind
  name: string
  jurisdiction: string | null
  registrationRef: string | null
  status: 'active' | 'disabled'
  metadata: Record<string, unknown>
  roles: string[]
  createdAt: string
  updatedAt: string
}

interface ActorRow {
  id: string
  kind: string
  name: string
  jurisdiction: string | null
  registration_ref: string | null
  status: string
  metadata: string
  created_at: string
  updated_at: string
}

interface RoleRow {
  role: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/
const JURISDICTION_PATTERN = /^[A-Z]{2}$/

/** The write-time validation of a registration body. Answers the
 *  normalized record-to-be, or the refusal's reason (the oimlsmart
 *  validate* pattern: pure, total, honest errors). */
export function validateActorInput(input: unknown): { actor: Omit<ActorRecord, 'createdAt' | 'updatedAt'> | null; error: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { actor: null, error: 'the registration body must be an object: { id?, kind, name, roles, jurisdiction?, registrationRef?, metadata? }' }
  }
  const rec = input as Record<string, unknown>
  const str = (name: string): string | null | undefined => {
    const value = rec[name]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  const kind = rec['kind']
  if (!isActorKind(kind)) {
    return { actor: null, error: `kind must be one of: economic-operator, installer, repairer, cab, marketplace` }
  }
  const name = str('name')
  if (name === undefined) return { actor: null, error: 'name must be a string' }
  if (name === null || name === '') return { actor: null, error: 'name is required (the actor\'s legal or trade name)' }
  const idIn = str('id')
  if (idIn === undefined) return { actor: null, error: 'id must be a string' }
  let id: string
  if (idIn === null) {
    id = `act_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  } else if (!ID_PATTERN.test(idIn)) {
    return { actor: null, error: 'id must be a lowercase slug: letters, digits, hyphens; 2–63 characters' }
  } else {
    id = idIn
  }
  const jurisdiction = str('jurisdiction')
  if (jurisdiction === undefined) return { actor: null, error: 'jurisdiction must be a string' }
  if (jurisdiction !== null && !JURISDICTION_PATTERN.test(jurisdiction)) {
    return { actor: null, error: 'jurisdiction must be an ISO 3166-1 alpha-2 code (e.g. "DE")' }
  }
  const registrationRef = str('registrationRef')
  if (registrationRef === undefined) return { actor: null, error: 'registrationRef must be a string' }
  const rolesIn = rec['roles']
  if (!Array.isArray(rolesIn) || rolesIn.length === 0 || rolesIn.some((r) => typeof r !== 'string')) {
    return {
      actor: null,
      error: `roles must be a non-empty list from the kind's catalog: ${rolesForKind(kind).map((r) => r.key).join(', ')}`,
    }
  }
  const roles: string[] = []
  for (const r of rolesIn) {
    if (roleDefinition(kind, r as string) === null) {
      return { actor: null, error: `role "${String(r)}" is not in the ${kind} catalog (${rolesForKind(kind).map((x) => x.key).join(', ')})` }
    }
    if (!roles.includes(r as string)) roles.push(r as string)
  }
  const metadata = rec['metadata']
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    return { actor: null, error: 'metadata must be an object' }
  }
  return {
    actor: {
      id,
      kind,
      name,
      jurisdiction,
      registrationRef,
      status: 'active',
      metadata: (metadata as Record<string, unknown> | undefined) ?? {},
      roles,
    },
    error: null,
  }
}

function rowToActor(row: ActorRow, roles: string[]): ActorRecord | null {
  if (!isActorKind(row.kind)) return null
  let metadata: Record<string, unknown> = {}
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>
  } catch {
    metadata = {}
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    jurisdiction: row.jurisdiction,
    registrationRef: row.registration_ref,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    metadata,
    roles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The actor registry's repository (one class, one entity). */
export class ActorRepository {
  constructor(private readonly actors: ActorsTable) {}

  async create(actor: Omit<ActorRecord, 'createdAt' | 'updatedAt'>): Promise<ActorRecord | null> {
    const now = nowRfc3339()
    await this.actors
      .prepare('INSERT INTO actors (id, kind, name, jurisdiction, registration_ref, status, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(actor.id, actor.kind, actor.name, actor.jurisdiction, actor.registrationRef, actor.status, JSON.stringify(actor.metadata), now, now)
      .run()
    for (const role of actor.roles) {
      await this.actors.prepare('INSERT INTO actor_roles (actor_id, role) VALUES (?1, ?2)').bind(actor.id, role).run()
    }
    return { ...actor, createdAt: now, updatedAt: now }
  }

  async get(id: string): Promise<ActorRecord | null> {
    const row = await this.actors.prepare('SELECT * FROM actors WHERE id = ?1').bind(id).first<ActorRow>()
    if (row === null) return null
    const roles = await this.actors.prepare('SELECT role FROM actor_roles WHERE actor_id = ?1 ORDER BY role').bind(id).all<RoleRow>()
    return rowToActor(row, (roles.results ?? []).map((r) => r.role))
  }

  async list(): Promise<ActorRecord[]> {
    const rows = await this.actors.prepare('SELECT * FROM actors ORDER BY id').all<ActorRow>()
    const roleRows = await this.actors.prepare('SELECT actor_id, role FROM actor_roles ORDER BY actor_id, role').all<{ actor_id: string; role: string }>()
    const rolesByActor = new Map<string, string[]>()
    for (const r of roleRows.results ?? []) {
      const list = rolesByActor.get(r.actor_id) ?? []
      list.push(r.role)
      rolesByActor.set(r.actor_id, list)
    }
    return (rows.results ?? []).map((row) => rowToActor(row, rolesByActor.get(row.id) ?? [])).filter((a): a is ActorRecord => a !== null)
  }

  /** The guarded lifecycle transition (active ↔ disabled; a disabled
   *  actor admits no new credentials and mints no tokens). */
  async setStatus(id: string, status: 'active' | 'disabled'): Promise<ActorRecord | null> {
    const now = nowRfc3339()
    await this.actors.prepare('UPDATE actors SET status = ?2, updated_at = ?3 WHERE id = ?1').bind(id, status, now).run()
    return this.get(id)
  }
}

/** The public view of an actor (the registry statement a relying
 *  service consumes — never secrets, never internal bookkeeping). */
export function actorView(actor: ActorRecord, projection: CredentialProjection): Record<string, unknown> {
  return {
    id: actor.id,
    kind: actor.kind,
    name: actor.name,
    jurisdiction: actor.jurisdiction,
    registrationRef: actor.registrationRef,
    status: actor.status,
    roles: actor.roles,
    en18239: projection.en18239Classes,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  }
}

/** The full projection for an actor (roles → classes + scopes). */
export function projectionOf(actor: ActorRecord): CredentialProjection {
  return credentialProjection(actor.kind, actor.roles)
}

/** Is the actor minting-eligible right now (status + optional expiry of the registry row itself)? */
export function actorCanAuthenticate(actor: ActorRecord): boolean {
  return actor.status === 'active'
}

export { parseRfc3339 }
