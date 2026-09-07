// RFC 3339 time helpers (canonical UTC seconds precision — the I13
// as-of stamp format; fixed-width UTC compares lexicographically).

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
