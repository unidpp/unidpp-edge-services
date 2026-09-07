// The typed `cloudflare:workers` env for the resolver tests.
declare namespace Cloudflare {
  interface Env {
    LINKSETS: KVNamespace
    RESOLVER_ADMIN_TOKEN?: string
  }
}
