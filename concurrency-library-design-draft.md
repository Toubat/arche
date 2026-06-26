## Goals

Want a light-weight concurrency library for TS (platform agnostic).

Provide concurrency primitive to run corotines, wait for it, join it, and cancel it.

Should have certain "scope" semantics so child routines lifecycle cannot outlive the parent.

Abstract away abort signal for common use cases, but still expose it for custom / advanced use cases.

Should not be "viral" in the sense that it doesn't force you to use it everywhere, like Effect.

Should provide concurrent data structures, like queue, future, semaphore, Mutex, etc.

## Fundamental Concurrent Unit: Coroutine

```ts
import { io, delay } from "@arche/concurrency";

// Coroutine is thenable, Promise-like, but not a Promise.
type Coroutine<T> = PromiseLike<T> & {
    cancel(): void;
    cancelGracefully(): Promise<void>;

    get cancelled(): boolean;
};

type coroutine<T> = (fn: (ctx: AsyncContext) => Promise<T>) => Coroutine<T>;


// async helper
type delay = (ms: number) => Coroutine<void>; //

const coro = io.coroutine<string>((ctx: AsyncContext) => {
    // delay is implemented in coroutine, but no need to pass abort signal since it is managed by framework
    await delay(1000);
    return "hello";
});

const result = await coro.await();

// cancellation works as expected
coro.cancel();

// cleanup steps

const connectToWs = (options: ...) => {
    return io.coroutine<WebSocket>((ctx: AsyncContext) => {
        ...
    });
}

// Or... in one step if you want
const connectToWs = io.function<WebSocket>((ctx: AsyncContext) => (options: ...) => {
    ...
});

const coro = io.coroutine<string>((ctx: AsyncContext) => {
    const ws = await connectToWs({ ... });
    const fut = io.future<string>();

    ctx.defer(() => {
        ws.close();
    })

    // can have multiple deferred cleanup steps
    ctx.defer(() => {
        console.log("Cleanup!");
    })

    ws.onmessage = (event) => {
        console.log(event.data);
    }

    ws.on('error', (error) => {
        fut.error(new Error("WebSocket error"));
        console.error(error);
    })

    ws.on('close', () => {
        fut.succeed("123");
        console.log("Closed!");
    })

    const coro: Coroutine<string> = fut.await();
    return await coro;
});

// Nested coroutines
const coro = io.coroutine<string>((ctx) => {

    ctx.defer(() => {
        console.log("Cleanup1");
    })

    return await coroutine((ctx) => {

        ctx.defer(() => {
            console.log("Cleanup2");
        })

        await coroutine((ctx) => {

            ctx.defer(() => {
                console.log("Cleanup3");
            })

            await delay(1000);
            return "hello";
        });
        return "world";
    });
});

coro.cancel(); // non-blocking

await coro.cancelGracefully(); // wait for cleanup to complete
// Should see "Cleanup3", "Cleanup2", "Cleanup1" in order since nested coroutines are cancelled first before the parent cleanup
```

```ts
const coro = io.coroutine<void>((ctx) => {
    const mutex = io.mutex();

    const job = () => io.coroutine<void>((ctx) => {
        await mutex.acquire();
        ctx.defer(mutex.release);

        // ...
    });

    const results = await io.all([job(), job(), job()]);
});
```

```ts
const coro = io.coroutine<void>((ctx) => {
    const chan = io.channel<number>({ maxSize: 10 });
    const wg = io.waitGroup();

    const producer = io.coroutine<void>((ctx) => {
        for (let i = 0; i < 100; i++) {
            wg.add(1);
            await chan.send(i);
        }
    });

    const makeConsumer = () => io.coroutine<void>((ctx) => {
       for(;;) {
        const value = await chan.receive();
        console.log(value);
        wg.done();
       }
    });

    io.background([producer, makeConsumer(), makeConsumer(), makeConsumer()]);

    await wg.wait();
});
```