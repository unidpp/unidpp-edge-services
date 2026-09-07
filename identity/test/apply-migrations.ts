import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Setup files run outside the per-test-file storage isolation and may run
// multiple times; applyD1Migrations applies only what is not yet applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
