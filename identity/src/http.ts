// HTTP response helpers (the signed-response doctrine rides here):
// every JSON response the service emits is ES256-signed over
// `${timestamp}\n${body}` with the kid + timestamp in headers — a
// relying service verifies against /.well-known/jwks.json and knows
// WHAT was said WHEN, with whose key.

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

export interface PreparedResponse {
  status: number
  body: string
  headers: Record<string, string>
}

export function jsonPayload(status: number, payload: unknown, headers: Record<string, string> = {}): PreparedResponse {
  return {
    status,
    body: JSON.stringify(payload, null, 2),
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...headers },
  }
}

export function errorPayload(status: number, message: string, headers: Record<string, string> = {}): PreparedResponse {
  return jsonPayload(status, { error: message }, headers)
}

export function toResponse(prepared: PreparedResponse, signatureHeaders: Record<string, string> = {}): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { ...prepared.headers, ...signatureHeaders },
  })
}
