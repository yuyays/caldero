import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { ContainerConnection, type NativeContainer } from "./container-connection.ts";

class StartupFailure extends Schema.TaggedError<StartupFailure>()("StartupFailure", {
  message: Schema.String,
}) {}

const message = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

describe("ContainerConnection", () => {
  it.live("close releases startup callers and cancels a native exec once", () =>
    Effect.gen(function* () {
      const execStarted = yield* Deferred.make<void>();
      let cancelled = 0;
      let starts = 0;
      let execSignal: { readonly aborted: boolean } | undefined;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- test double implements the only native member startup uses
      const container = {
        exec: (_command: Array<string>, options?: { readonly signal?: AbortSignal }) => {
          execSignal = options?.signal;
          // Stay pending after abort: workerd still has to return the in-flight spawn RPC.
          return new Promise<never>(() => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                cancelled += 1;
              },
              { once: true },
            );
            // Signal only after the simulated native exec installed its listener.
            Deferred.doneUnsafe(execStarted, Effect.void);
          });
        },
      } as unknown as NativeContainer;
      const connection = new ContainerConnection(
        () => container,
        () => {
          starts += 1;
          return Promise.resolve();
        },
      );

      const callers = yield* Effect.forEach([1, 2, 3], () =>
        Effect.tryPromise({
          try: () => connection.info(),
          catch: (error) => new StartupFailure({ message: message(error) }),
        }).pipe(Effect.flip, Effect.forkChild),
      );
      yield* Deferred.await(execStarted);
      connection.close();

      const errors = yield* Effect.forEach(callers, (caller) => Fiber.join(caller)).pipe(
        Effect.timeout("1 second"),
      );
      expect(errors).toHaveLength(3);
      for (const error of errors) expect(message(error)).toContain("Connection closed");
      expect(starts).toBe(1);
      expect(execSignal).toBeDefined();
      expect(execSignal?.aborted).toBe(true);
      expect(cancelled).toBe(1);

      // A second close must not cancel or start anything again, and later callers stay refused.
      connection.close();
      expect(cancelled).toBe(1);
      const after = yield* Effect.tryPromise({
        try: () => connection.info(),
        catch: (error) => new StartupFailure({ message: message(error) }),
      }).pipe(Effect.flip);
      expect(message(after)).toContain("Connection closed");
      expect(starts).toBe(1);
    }),
  );
});
