import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { PluginManifest, TurnContext } from "./plugin-sdk";
import { ECHO_PLUGIN_BUNDLE } from "./plugins/echo-plugin.bundle";

// Shape of the plugin's default export once loaded as a dynamic Worker.
interface PluginEntrypoint {
  register(): Promise<PluginManifest>;
}

/**
 * Loads a pre-bundled plugin via the Worker Loader, collects its manifest
 * (tools + lifecycle hooks), and runs a mock agent turn that invokes the
 * before/after hooks and a tool. Plugin code is sandboxed in its own isolate.
 */
export class PluginHost extends DurableObject<Env> {
  async runDemoTurn(input: string): Promise<string> {
    // JIT-load the pre-bundled plugin (kept warm by id).
    const worker = this.env.LOADER.get("echo-plugin@1", async () => ({
      compatibilityDate: "2026-06-25",
      mainModule: "plugin.js",
      modules: { "plugin.js": ECHO_PLUGIN_BUNDLE },
      globalOutbound: null, // sandbox: no network for this plugin
    }));

    const plugin = worker.getEntrypoint() as unknown as PluginEntrypoint;
    const manifest = await plugin.register();

    const turn = ((await this.ctx.storage.get<number>("turn")) ?? 0) + 1;
    await this.ctx.storage.put("turn", turn);
    const ctx: TurnContext = { turn, input };

    const log: string[] = [`--- agent turn #${turn} (input="${input}") ---`];

    // 1) fire beforeTurnStart hooks (each call is RPC back into the plugin)
    for (const hook of manifest.beforeTurnStart) {
      log.push(`beforeTurnStart -> ${await hook(ctx)}`);
    }

    // 2) mock "model" step: invoke a registered tool
    const tool = manifest.tools.find((t) => t.name === "shout");
    if (tool) {
      log.push(`tool "${tool.name}"("${input}") -> ${await tool.run(input)}`);
    }

    // 3) fire beforeTurnEnd hooks
    for (const hook of manifest.beforeTurnEnd) {
      log.push(`beforeTurnEnd -> ${await hook(ctx)}`);
    }

    return `${log.join("\n")}\n`;
  }
}
