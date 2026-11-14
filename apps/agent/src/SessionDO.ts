import * as Cloudflare from "@alchemy.run/cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Wake } from "@earendil-works/pi-durable";
import type { SessionEvent } from "@puchero/domain";
import { Clock, Effect, Layer } from "effect";
import { ContainerWorkspace, makeR2WorkspaceStore } from "./container-workspace.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import { errorMessage, WorkspaceError } from "./ports.ts";
import { Sandbox } from "./Sandbox.ts";
import { openSessionHost, type SessionHost } from "./session-host.ts";
import { makeMemoryProjection, scriptedModels } from "./testing.ts";

/** Local milestone shell: one Pi SQLite session, sandbox and R2 namespace per named object. */
export class SessionDO extends Cloudflare.DurableObject<SessionDO>()(
  "SessionDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sandbox = yield* Sandbox;
    const bucket = yield* Cloudflare.R2.Bucket("WorkspaceBlobs");
    const blobs = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    // Alchemy separates resource declaration from per-instance initialization.
    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy requires a resource Effect returning an initializer Effect
    return Effect.gen(function* () {
      const raw = state.raw;
      const nativeBucket = yield* blobs.raw;
      const store = makeR2WorkspaceStore(nativeBucket, raw.id.toString());
      const models = scriptedModels();
      const github = makeFakeGitHub({
        source: [
          {
            path: "README.md",
            content: new TextEncoder().encode("# Local demo\n"),
            executable: false,
          },
        ],
      });
      const projection = makeMemoryProjection();
      const start = sandbox.start({ enableInternet: false }).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new WorkspaceError({ message: errorMessage(error) })),
      );
      const startContext = yield* Effect.context<Effect.Services<typeof start>>();
      const services = Layer.mergeAll(
        ContainerWorkspace.layer({
          id: `container:${raw.id.toString()}`,
          container: () => {
            if (raw.container === undefined) throw new Error("Session has no container");
            return raw.container;
          },
          start: start.pipe(Effect.provide(startContext)),
          store,
          checks: ["test -f notes.txt"],
        }).pipe(Layer.provide(github.layer)),
        github.layer,
        projection.layer,
      );
      let host: SessionHost | undefined;
      /** Pi's next wake and the session heartbeat share the object's single alarm. */
      const arm = Effect.fn("SessionDO.arm")(function* (wake: Wake) {
        const now = yield* Clock.currentTimeMillis;
        const running = host === undefined ? false : yield* host.running();
        const heartbeat = running || wake.active ? now + 30_000 : undefined;
        const at =
          heartbeat === undefined
            ? wake.at
            : wake.at === undefined
              ? heartbeat
              : Math.min(heartbeat, wake.at);
        yield* Effect.tryPromise({
          try: () => (at === undefined ? raw.storage.deleteAlarm() : raw.storage.setAlarm(at)),
          catch: errorMessage,
        });
      });
      const run = Effect.runPromiseWith(yield* Effect.context());
      let alarmWrites = Promise.resolve();
      const onWake = (wake: Wake) => {
        alarmWrites = alarmWrites
          .then(() => run(arm(wake)))
          .catch(() => raw.abort("Could not arm the session alarm"));
        raw.waitUntil(alarmWrites);
      };
      const storage = yield* Effect.tryPromise({
        try: () => openDurableObjectSqliteStorage(raw.storage),
        catch: errorMessage,
      });
      // Build once in the instance scope; providing the Layer to open alone would close its connection on return.
      const serviceContext = yield* Layer.build(services);
      host = yield* openSessionHost({
        storage,
        session: {
          sessionId: raw.id.toString(),
          repo: { owner: "acme", name: "app" },
          issue: 7,
          policy: "observe",
        },
        models: models.models,
        model: models.model,
        onWake,
        onReport: (report) => {
          if (report.kind === "storage_failed") raw.abort("Pi storage failed");
        },
      }).pipe(Effect.provide(serviceContext));
      const opened = host;
      yield* arm(opened.wake());
      return {
        deliver: (event: SessionEvent, eventId: string) =>
          opened.deliver(event, eventId).pipe(
            Effect.tap(() => arm(opened.wake())),
            Effect.orDie,
          ),
        view: () => opened.view().pipe(Effect.orDie),
        alarm: () => arm(opened.wake()).pipe(Effect.andThen(opened.resume()), Effect.orDie),
      };
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
