import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * Capability the supervisor hands DOWN to dynamically-loaded child code so the
 * child can call BACK into the parent (child -> parent) over RPC. The child
 * only sees the methods exposed here; it never sees the implementation or any
 * secrets/props behind it.
 */
export class SupervisorApi extends WorkerEntrypoint<Env> {
  async report(message: string): Promise<string> {
    // Runs back in the parent. A real control plane would persist to the
    // supervisor's own storage or enforce policy here.
    console.log(`[supervisor] child reported: ${message}`);
    return `ack: ${message}`;
  }
}

// In production this would come from an AI agent, user upload, or the
// supervisor's own storage — not a static string.
const AGENT_CODE = `
  import { DurableObject } from "cloudflare:workers";

  export class App extends DurableObject {
    async fetch(request) {
      // Facet's OWN isolated SQLite storage (cannot see the supervisor's DB).
      let n = this.ctx.storage.kv.get("counter") || 0;
      n++;
      this.ctx.storage.kv.put("counter", n);

      // child -> parent: call the capability the supervisor injected.
      const ack = await this.env.SUPERVISOR.report("hit #" + n);

      return new Response("dynamic DO: request #" + n + " | parent " + ack + "\\n");
    }
  }
`;

/**
 * Supervisor Durable Object. Loads a Durable Object class from a runtime code
 * string via the Worker Loader, runs it as an isolated facet (its own SQLite
 * DB), injects a parent capability, and forwards requests to it.
 */
export class AppRunner extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const facet = this.ctx.facets.get("app", async () => {
      const worker = this.env.LOADER.get("agent-code-v1", async () => ({
        compatibilityDate: "2026-06-25",
        mainModule: "worker.js",
        modules: { "worker.js": AGENT_CODE },
        // Inject the parent capability as a binding the child can call.
        env: { SUPERVISOR: this.ctx.exports.SupervisorApi({}) },
        globalOutbound: null, // sandbox: block all network egress from child
      }));
      return { class: worker.getDurableObjectClass("App") };
    });

    // parent -> child: forward the HTTP request to the facet.
    return await facet.fetch(request);
  }
}
