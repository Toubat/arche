import { definePlugin } from "../plugin-sdk";

/**
 * Example user plugin. In production this would live in its own folder with a
 * package.json (and could pull npm deps), then be pre-bundled. It exposes one
 * tool and both turn-lifecycle hooks.
 */
export default definePlugin((host) => {
  host.addTool({
    name: "shout",
    run: (text) => String(text).toUpperCase(),
  });

  host.onBeforeTurnStart((ctx) => {
    return `echo-plugin: turn #${ctx.turn} starting (input="${ctx.input}")`;
  });

  host.onBeforeTurnEnd((ctx) => {
    return `echo-plugin: turn #${ctx.turn} ending`;
  });
});
