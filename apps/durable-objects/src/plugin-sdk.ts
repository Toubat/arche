import { WorkerEntrypoint } from "cloudflare:workers";

export interface TurnContext {
  turn: number;
  input: string;
}

export interface ToolDefinition {
  name: string;
  run: (args: string) => unknown | Promise<unknown>;
}

export type TurnHook = (ctx: TurnContext) => unknown | Promise<unknown>;

/** The API a plugin uses to expose tools and lifecycle hooks. */
export interface PluginHostApi {
  addTool(tool: ToolDefinition): void;
  onBeforeTurnStart(hook: TurnHook): void;
  onBeforeTurnEnd(hook: TurnHook): void;
}

/** What a plugin's `register()` hands back to the framework. */
export interface PluginManifest {
  tools: ToolDefinition[];
  beforeTurnStart: TurnHook[];
  beforeTurnEnd: TurnHook[];
}

export type PluginSetup = (host: PluginHostApi) => void;

/**
 * Helper a plugin author uses to declare a plugin. Returns a WorkerEntrypoint
 * whose `register()` builds the manifest by running `setup` against a local
 * host builder (inside the plugin's own isolate), then returns it to the
 * framework over RPC — the tool/hook callbacks travel back as RPC stubs.
 */
export function definePlugin(setup: PluginSetup) {
  return class PluginEntrypoint extends WorkerEntrypoint {
    register(): PluginManifest {
      const tools: ToolDefinition[] = [];
      const beforeTurnStart: TurnHook[] = [];
      const beforeTurnEnd: TurnHook[] = [];
      setup({
        addTool: (tool) => tools.push(tool),
        onBeforeTurnStart: (hook) => beforeTurnStart.push(hook),
        onBeforeTurnEnd: (hook) => beforeTurnEnd.push(hook),
      });
      return { tools, beforeTurnStart, beforeTurnEnd };
    }
  };
}
