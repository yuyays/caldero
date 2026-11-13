// PROTOTYPE, throwaway: one Durable Object per session, hosting Pi Durable on its SQLite.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { PiHost, type NativeState } from "./pi-host.ts";
import { Sandbox } from "./Sandbox.ts";

export default class Session extends Cloudflare.DurableObject<Session>()(
  "Session",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sandbox = yield* Sandbox;
    return Effect.gen(function* () {
      const raw = state.raw as unknown as NativeState;
      // Pi is a third-party Promise API; this is its adapter boundary.
      const start = sandbox.start({ enableInternet: false }).pipe(Effect.orDie);
      const run = Effect.runPromiseWith(yield* Effect.context<Effect.Services<typeof start>>());
      const startContainer = () => run(start);
      const host = yield* Effect.promise(() => PiHost.open(raw, startContainer));
      return {
        submit: (text: string, requestId: string) => Effect.promise(() => host.submit(text, requestId)),
        status: () => Effect.promise(() => host.status()),
        /** Simulates an eviction or crash: the instance resets and in-memory work is lost. */
        crash: () => Effect.sync(() => raw.abort("spike: simulated crash")),
        /** Simulates a container that slept or died: its disk is wiped. */
        resetContainer: () => sandbox.destroy().pipe(Effect.orDie),
        alarm: () => Effect.promise(() => host.alarm()),
      };
    });
  }),
) {}
