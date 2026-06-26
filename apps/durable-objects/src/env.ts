import type { AppRunner } from "./supervisor";
import type { MyDurableObject } from "./counter";
import type { PluginHost } from "./plugin-host";

export interface Env {
  MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
  APP_RUNNER: DurableObjectNamespace<AppRunner>;
  PLUGIN_HOST: DurableObjectNamespace<PluginHost>;
  LOADER: WorkerLoader;
}
