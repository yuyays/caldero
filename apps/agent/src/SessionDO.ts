import * as Cloudflare from "@alchemy.run/cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Wake } from "@earendil-works/pi-durable";
import { InboxUnavailable } from "@puchero/contracts/inbox";
import type { SessionEvent } from "@puchero/domain";
import { Clock, Effect, Layer, Schema, Scope, Semaphore } from "effect";
import { makeAgentRuntime } from "./agent-settings.ts";
import { ContainerWorkspace, makeR2WorkspaceStore } from "./container-workspace.ts";
import { inboxDatabase } from "./inbox-database.ts";
import { makeD1InboxStore } from "./inbox-store.ts";
import { errorMessage, GitHub, Projection, WorkspaceError } from "./ports.ts";
import { Sandbox } from "./Sandbox.ts";
import { openSessionHost, type SessionHost } from "./session-host.ts";

const decodeIdentity = Schema.decodeUnknownEffect(Schema.Struct({ issue: Schema.Int }));

/** One named issue owns its Pi history, sandbox and workspace store. Reads never create a session. */
export class SessionDO extends Cloudflare.DurableObject<SessionDO>()(
  "SessionDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sandbox = yield* Sandbox;
    const bucket = yield* Cloudflare.R2.Bucket("WorkspaceBlobs");
    const blobs = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    const database = yield* Cloudflare.D1.QueryDatabase(yield* inboxDatabase);
    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy separates resource declaration from instance initialization
    return Effect.gen(function* () {
      const raw = state.raw;
      const instanceScope = yield* Scope.Scope;
      const runtime = yield* makeAgentRuntime();
      const { settings } = runtime;
      const nativeBucket = yield* blobs.raw;
      const index = makeD1InboxStore(yield* database.raw);
      const initialize = yield* Semaphore.make(1);
      let host: SessionHost | undefined;
      let issue: number | undefined;
      let alarmWrites = Promise.resolve();
      const run = Effect.runPromiseWith(yield* Effect.context());
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
      const onWake = (wake: Wake) => {
        alarmWrites = alarmWrites
          .then(() => run(arm(wake)))
          .catch(() => raw.abort("Could not arm the session alarm"));
        raw.waitUntil(alarmWrites);
      };
      const getHost = Effect.fn("SessionDO.getHost")(function* (newIssue?: number) {
        if (host !== undefined) {
          if (newIssue !== undefined && newIssue !== issue)
            return yield* new InboxUnavailable({ message: "Session identity mismatch" });
          return host;
        }
        const saved = yield* Effect.tryPromise({
          try: () => raw.storage.get("identity"),
          catch: errorMessage,
        });
        if (saved === undefined && newIssue === undefined) return undefined;
        issue = saved === undefined ? newIssue : (yield* decodeIdentity(saved)).issue;
        if (issue === undefined || issue <= 0 || (newIssue !== undefined && newIssue !== issue))
          return yield* new InboxUnavailable({ message: "Session identity mismatch" });
        if (saved === undefined)
          yield* Effect.tryPromise({
            try: () => raw.storage.put("identity", { issue }),
            catch: errorMessage,
          });
        const start = sandbox.start({ enableInternet: false }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new WorkspaceError({ message: errorMessage(error) })),
        );
        const startContext = yield* Effect.context<Effect.Services<typeof start>>();
        const github = Layer.succeed(GitHub, runtime.github);
        const services = Layer.mergeAll(
          ContainerWorkspace.layer({
            id: `container:${raw.id.toString()}`,
            container: () => {
              if (raw.container === undefined) throw new Error("Session has no container");
              return raw.container;
            },
            start: start.pipe(Effect.provide(startContext)),
            store: makeR2WorkspaceStore(nativeBucket, raw.id.toString()),
            checks: settings.checks,
          }).pipe(Layer.provide(github)),
          github,
          Layer.succeed(Projection, index.projection),
        );
        const serviceContext = yield* Layer.build(services);
        const storage = yield* Effect.tryPromise({
          try: () => openDurableObjectSqliteStorage(raw.storage),
          catch: errorMessage,
        });
        host = yield* openSessionHost({
          storage,
          session: {
            sessionId: `${settings.repo.owner}/${settings.repo.name}#${issue}`,
            repo: settings.repo,
            issue,
            policy: settings.policy,
          },
          models: runtime.models,
          model: runtime.model,
          onWake,
          onReport: (report) => {
            if (report.kind === "storage_failed") raw.abort("Pi storage failed");
          },
        }).pipe(Effect.provide(serviceContext));
        yield* arm(host.wake());
        return host;
      });
      // A host opened by an RPC belongs to the DO instance, not to that request's scope.
      const open = (newIssue?: number) =>
        initialize.withPermits(1)(
          getHost(newIssue).pipe(Effect.provideService(Scope.Scope, instanceScope)),
        );
      // Resume existing state on activation; a fresh object waits for verified admission.
      yield* open();
      return {
        start: Effect.fn("SessionDO.start")(function* (
          issueNumber: number,
          event: SessionEvent,
          eventId: string,
        ) {
          if (settings.policy === "off") return;
          const current = yield* open(issueNumber);
          if (current === undefined) return;
          yield* current.deliver(event, eventId);
          yield* arm(current.wake());
        }, Effect.orDie),
        deliver: Effect.fn("SessionDO.deliver")(function* (event: SessionEvent, eventId: string) {
          const current = yield* open();
          if (current === undefined) return null;
          const result = yield* current.deliver(event, eventId);
          yield* arm(current.wake());
          return { result, view: yield* current.view() };
        }, Effect.orDie),
        view: Effect.fn("SessionDO.view")(function* () {
          const current = yield* open();
          return current === undefined ? null : yield* current.view();
        }, Effect.orDie),
        alarm: Effect.fn("SessionDO.alarm")(function* () {
          const current = yield* open();
          if (current !== undefined) {
            yield* arm(current.wake());
            yield* current.resume();
          }
        }, Effect.orDie),
      };
    }).pipe(Effect.orDie);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.D1.QueryDatabaseBinding),
    ),
  ),
) {}
