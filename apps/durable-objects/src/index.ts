import type { Env } from "./env";

export { MyDurableObject } from "./counter";
export { PluginHost } from "./plugin-host";
export { AppRunner, SupervisorApi } from "./supervisor";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // /dynamic -> supervisor loads + runs a dynamic Durable Object facet.
    if (url.pathname.startsWith("/dynamic")) {
      return env.APP_RUNNER.getByName("demo").fetch(request);
    }

    // /plugin -> load a pre-bundled plugin and run a mock agent turn.
    if (url.pathname.startsWith("/plugin")) {
      const input = url.searchParams.get("input") ?? "hello";
      const out = await env.PLUGIN_HOST.getByName("demo").runDemoTurn(input);
      return new Response(out);
    }

    // Otherwise exercise the static SQLite-backed Durable Object.
    const stub = env.MY_DURABLE_OBJECT.getByName(url.searchParams.get("name") ?? "default");
    const body = url.pathname === "/kv" ? await stub.kvPing() : await stub.sayHello();
    return new Response(body);
  },
} satisfies ExportedHandler<Env>;
