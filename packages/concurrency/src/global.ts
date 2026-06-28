import { abortRoot, resetRoot, rootScope } from "./scope";

/**
 * Cancel every top-level coroutine (and, transitively, their descendants),
 * fire-and-forget. A fresh root is installed afterwards so newly spawned work is
 * unaffected. Use this for fast process shutdown when you don't need to wait for
 * cleanups; use {@link cancelGlobalGracefully} to await teardown.
 */
export function cancelGlobal(): void {
  abortRoot();
  resetRoot();
}

/**
 * Cancel every top-level coroutine and await each one's teardown (defers run and
 * flushed) before resolving. A fresh root is installed afterwards.
 */
export async function cancelGlobalGracefully(opts?: { timeoutMs?: number }): Promise<void> {
  const children = [...rootScope().children];
  abortRoot();
  await Promise.all(children.map((child) => child.cancelGracefully(opts)));
  resetRoot();
}
