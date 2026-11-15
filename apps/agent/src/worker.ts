import * as Cloudflare from "@alchemy.run/cloudflare";
import { InboxUnavailable } from "@puchero/contracts/inbox";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { agentEnvironment, makeAgentRuntime } from "./agent-settings.ts";
import { InboxAuth, makeInboxAuth } from "./inbox-auth.ts";
import { inboxDatabase } from "./inbox-database.ts";
import { ApplicationRoutes, InboxConfig, Sessions } from "./inbox-http.ts";
import { InboxStore, makeD1InboxStore } from "./inbox-store.ts";
import { GitHub } from "./ports.ts";
import { SessionDO } from "./SessionDO.ts";

/** Signed admission and authenticated decisions are the only public session transports. */
export default class Agent extends Cloudflare.Worker<Agent>()(
  "Agent",
  {
    main: import.meta.url,
    env: agentEnvironment,
    assets: {
      directory: "../web/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/webhooks/*"],
    },
  },
  Effect.gen(function* () {
    const namespace = yield* SessionDO;
    const database = yield* Cloudflare.D1.QueryDatabase(yield* inboxDatabase);
    const runtime = yield* makeAgentRuntime().pipe(Effect.orDie);
    const auth = yield* makeInboxAuth(runtime.settings.auth).pipe(Effect.orDie);
    return {
      fetch: Effect.gen(function* () {
        const index = makeD1InboxStore(yield* database.raw);
        const context =
          yield* Effect.context<
            Effect.Services<ReturnType<ReturnType<typeof namespace.getByName>["view"]>>
          >();
        const prefix = `${runtime.settings.repo.owner}/${runtime.settings.repo.name}#`;
        const stub = (id: string) =>
          id.startsWith(prefix) && /^[1-9]\d*$/.test(id.slice(prefix.length))
            ? namespace.getByName(id)
            : undefined;
        const sessions = Sessions.of({
          read: Effect.fn("Sessions.read")(
            function* (id) {
              const session = stub(id);
              return session === undefined ? null : yield* session.view();
            },
            Effect.provide(context),
            Effect.catchCause(() =>
              Effect.fail(new InboxUnavailable({ message: "Session is unavailable" })),
            ),
          ),
          deliver: Effect.fn("Sessions.deliver")(
            function* (id, event, eventId) {
              const session = stub(id);
              return session === undefined ? null : yield* session.deliver(event, eventId);
            },
            Effect.provide(context),
            Effect.catchCause(() =>
              Effect.fail(
                new InboxUnavailable({ message: "Decision could not be delivered; retry it" }),
              ),
            ),
          ),
          start: Effect.fn("Sessions.start")(
            function* (issue, event, deliveryId) {
              yield* namespace.getByName(`${prefix}${issue}`).start(issue, event, deliveryId);
            },
            Effect.provide(context),
            Effect.catchCause(() =>
              Effect.fail(new InboxUnavailable({ message: "Session admission is unavailable" })),
            ),
          ),
        });
        const services = Layer.mergeAll(
          Layer.succeed(Sessions, sessions),
          Layer.succeed(InboxConfig, runtime.settings),
          Layer.succeed(InboxAuth, auth),
          Layer.succeed(InboxStore, index),
          Layer.succeed(GitHub, runtime.github),
        );
        const fetch = yield* HttpRouter.toHttpEffect(
          ApplicationRoutes.pipe(
            Layer.provideMerge(services),
            Layer.provide(HttpServer.layerServices),
          ),
        );
        return yield* fetch.pipe(Effect.provide(services));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
