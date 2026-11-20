import * as Cloudflare from "@alchemy.run/cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Wake } from "@earendil-works/pi-durable";
import { SessionFault } from "@caldero/contracts/inbox";
import type { SessionEvent } from "@caldero/domain";
import { Clock, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import { makeAgentRuntime } from "./agent-settings.ts";
import { ContainerWorkspace, makeR2WorkspaceStore } from "./container-workspace.ts";
import { inboxDatabase } from "./inbox-database.ts";
import { makeD1InboxStore } from "./inbox-store.ts";
import { errorMessage, GitHub, Projection, WorkspaceError } from "./ports.ts";
import { Sandbox } from "./Sandbox.ts";
import { sessionIssue } from "./session-identity.ts";
import { makeSessionAccess } from "./session-access.ts";
import { openSessionHost, SessionHostError, type SessionHost } from "./session-host.ts";

const activationError = (error: unknown): SessionHostError =>
  new SessionHostError({ message: errorMessage(error) });

const implementation = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const sandbox = yield* Sandbox;
  const bucket = yield* Cloudflare.R2.Bucket("WorkspaceBlobs");
  const blobs = yield* Cloudflare.R2.ReadWriteBucket(bucket);
  const database = yield* Cloudflare.D1.QueryDatabase(yield* inboxDatabase);
  // Alchemy's constructor layer scope is temporary. Retain an explicit scope for the DO instance.
  // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy separates resource declaration from instance initialization
  return Effect.acquireUseRelease(
    Scope.make(),
    (instanceScope) =>
      Effect.gen(function* () {
        const raw = state.raw;
        const runtime = yield* makeAgentRuntime();
        const { settings } = runtime;
        const nativeBucket = yield* blobs.raw;
        const index = makeD1InboxStore(yield* database.raw);
        let host: SessionHost | undefined;
        let access: Effect.Success<ReturnType<typeof makeSessionAccess<SessionHost>>> | undefined;
        let alarmWrites = Promise.resolve();
        const run = Effect.runPromiseWith(yield* Effect.context());
        const alarmLock = yield* Semaphore.make(1);
        const deleteAlarm = Effect.tryPromise({
          try: () => raw.storage.deleteAlarm(),
          catch: activationError,
        });
        const clearAlarm = alarmLock.withPermits(1)(deleteAlarm);
        const arm = Effect.fn("SessionDO.arm")(
          function* (wake: Wake) {
            if (access?.faulted()) return yield* deleteAlarm;
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
              catch: activationError,
            });
            return undefined;
          },
          (effect) => alarmLock.withPermits(1)(effect),
        );
        const onWake = (wake: Wake) => {
          alarmWrites = alarmWrites
            .then(() => run(arm(wake)))
            .catch(() => raw.abort("Could not arm the session alarm"));
          raw.waitUntil(alarmWrites);
        };
        const start = sandbox.start({ enableInternet: false }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new WorkspaceError({ message: errorMessage(error) })),
        );
        const startContext = yield* Effect.context<Effect.Services<typeof start>>();
        const create = Effect.fn("SessionDO.create")(function* (issue: number) {
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
          const serviceContext = yield* Layer.build(services).pipe(
            Effect.mapError(activationError),
          );
          const storage = yield* Effect.tryPromise({
            try: () => openDurableObjectSqliteStorage(raw.storage),
            catch: activationError,
          });
          host = yield* openSessionHost({
            storage,
            session: {
              sessionId: `${settings.repo.owner}/${settings.repo.name}#${issue}`,
              repo: settings.repo,
              issue,
            },
            models: runtime.models,
            model: runtime.model,
            onWake,
            onReport: (report) => {
              if (report.kind === "storage_failed") raw.abort("Pi storage failed");
            },
          }).pipe(Effect.provide(serviceContext));
          return host;
        });
        const sessions = yield* makeSessionAccess({
          expectedIssue: sessionIssue(settings.repo, raw.id.name),
          readIdentity: Effect.tryPromise({
            try: () => raw.storage.get("identity"),
            catch: activationError,
          }),
          writeIdentity: (issue) =>
            Effect.tryPromise({
              try: () => raw.storage.put("identity", { issue }),
              catch: activationError,
            }),
          clearAlarm,
          create,
        });
        access = sessions;
        const rpc = <A, R>(effect: Effect.Effect<A, SessionHostError | SessionFault, R>) =>
          effect.pipe(
            Effect.tapError((error) =>
              error instanceof SessionFault ? sessions.fail(error) : Effect.void,
            ),
            Effect.catchTag("SessionHostError", Effect.die),
          );
        // Retain known activation faults in the instance so declared RPC methods can report them.
        // Startup is best-effort. RPC methods retry open; only known permanent faults latch.
        yield* sessions.open().pipe(
          Effect.flatMap((activated) =>
            activated === undefined ? Effect.void : arm(activated.wake()),
          ),
          Effect.catchTag("SessionFault", sessions.fail),
          Effect.catchTag("SessionHostError", () =>
            Effect.logWarning("Session activation is unavailable; the next call can retry"),
          ),
        );
        return {
          start: Effect.fn("SessionDO.start")(function* (
            issue: number,
            event: SessionEvent,
            eventId: string,
          ) {
            const current = yield* sessions.open(issue);
            if (current === undefined) return;
            yield* current.deliver(event, eventId);
            yield* arm(current.wake());
          }, rpc),
          deliver: Effect.fn("SessionDO.deliver")(function* (event: SessionEvent, eventId: string) {
            const current = yield* sessions.open();
            if (current === undefined) return null;
            const result = yield* current.deliver(event, eventId);
            yield* arm(current.wake());
            return { result, view: yield* current.view() };
          }, rpc),
          view: Effect.fn("SessionDO.view")(function* () {
            const current = yield* sessions.open();
            return current === undefined ? null : yield* current.view();
          }, rpc),
          alarm: Effect.fn("SessionDO.alarm")(
            function* () {
              const current = yield* sessions.open();
              if (current !== undefined) {
                yield* arm(current.wake());
                yield* current.resume();
              }
            },
            rpc,
            Effect.catchTag("SessionFault", () => clearAlarm),
            Effect.orDie,
          ),
        };
      }).pipe(Effect.provideService(Scope.Scope, instanceScope)),
    (instanceScope, exit) =>
      Exit.isFailure(exit) ? Scope.close(instanceScope, exit) : Effect.void,
  ).pipe(Effect.orDie);
}).pipe(
  Effect.provide(
    Layer.mergeAll(Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.D1.QueryDatabaseBinding),
  ),
);

/** One named issue owns its Pi history, sandbox and workspace store. Reads never create a session. */
export class SessionDO extends Cloudflare.DurableObject<
  SessionDO,
  Effect.Success<Effect.Success<typeof implementation>>
>()("SessionDO", { errors: [SessionFault] }) {}
export const SessionDOLive = SessionDO.make(implementation);
