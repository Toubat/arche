import type { MyDurableObject } from "./counter";
import type { PluginHost } from "./plugin-host";
import type { AppRunner } from "./supervisor";

export interface Env {
  MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
  APP_RUNNER: DurableObjectNamespace<AppRunner>;
  PLUGIN_HOST: DurableObjectNamespace<PluginHost>;
  LOADER: WorkerLoader;
}
