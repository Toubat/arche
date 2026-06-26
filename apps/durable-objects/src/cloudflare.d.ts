// `ctx.exports` exposes loopback bindings for the Worker's own top-level
// exports, letting a Durable Object mint capability stubs for its
// WorkerEntrypoint classes (e.g. to hand a child a controlled callback).
// Fully-typed loopback generics require `wrangler types`; this minimal shim
// keeps the source type-checking with @cloudflare/workers-types alone.
declare global {
  interface DurableObjectState<Props = unknown> {
    readonly exports: {
      SupervisorApi(options?: { props?: unknown }): unknown;
    };
  }
}

export {};
