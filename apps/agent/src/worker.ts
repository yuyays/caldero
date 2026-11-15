import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { agentEnvironment, makeAgentRuntime } from "./agent-settings.ts";
import { InboxAuth, makeInboxAuth } from "./inbox-auth.ts";
import { inboxDatabase } from "./inbox-database.ts";
import { ApplicationRoutes, InboxConfig, Sessions } from "./inbox-http.ts";
import { InboxStore, makeD1InboxStore } from "./inbox-store.ts";
import { GitHub } from "./ports.ts";
import { SessionDO, SessionDOLive } from "./SessionDO.ts";
import { makeSessionDirectory } from "./session-directory.ts";

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
        const context = yield* Effect.context<RuntimeContext>();
        const sessions = makeSessionDirectory(
          runtime.settings.repo,
          (id) => namespace.getByName(id),
          context,
        );
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
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding, SessionDOLive))),
) {}
