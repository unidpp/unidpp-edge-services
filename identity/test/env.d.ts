// The typed `cloudflare:workers` env for the identity tests (the same
// shape the worker's Env interface carries).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    /** The D1 migration array injected by vitest.config.ts (tests only). */
    TEST_MIGRATIONS: { name: string; queries: string[] }[]
    IDENTITY_SIGNING_KEY?: string
    IDENTITY_ADMIN_TOKEN?: string
    IDENTITY_ISSUER?: string
    ACCESS_TOKEN_TTL_SECONDS?: string
  }
}
