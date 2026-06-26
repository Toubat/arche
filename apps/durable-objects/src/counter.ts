import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * A Durable Object backed by a private, embedded SQLite database. Demonstrates
 * both the SQL API (`sayHello`) and the key-value Storage API (`kvPing`) on the
 * same SQLite-backed instance.
 */
export class MyDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
    );
  }

  async sayHello(): Promise<string> {
    const row = this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counter (id, value) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .one();
    return `Hello, World! (call #${row.value})`;
  }

  async kvPing(): Promise<string> {
    const current = (await this.ctx.storage.get<number>("kv-counter")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("kv-counter", next);
    return `KV pong (count #${next})`;
  }
}
