// RFC 3339 time helpers (worker-safe, canonical UTC seconds precision —
// the same format the resolver's I13 as-of stamps carry).

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Parse an RFC 3339 timestamp; null when malformed. */
export function parseRfc3339(value: string): number | null {
  if (!RFC3339.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

export function addSecondsRfc3339(fromMs: number, seconds: number): string {
  return toRfc3339(fromMs + seconds * 1000)
}
