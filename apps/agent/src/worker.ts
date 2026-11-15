import * as Cloudflare from "@alchemy.run/cloudflare";
import { SessionEvent } from "@puchero/domain";
import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SessionDO } from "./SessionDO.ts";

const decodeDelivery = Schema.decodeUnknownEffect(
  Schema.Struct({ event: SessionEvent, eventId: Schema.String }),
);

/** Development transport only; GitHub verification and inbox authentication arrive in later steps. */
export default class Agent extends Cloudflare.Worker<Agent>()(
  "Agent",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* SessionDO;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, prefix, name, action] = new URL(request.url, "http://localhost").pathname.split(
          "/",
        );
        if (prefix !== "s" || !name)
          return HttpServerResponse.text("Use /s/:name/view or POST /s/:name/deliver", {
            status: 404,
          });
        const session = sessions.getByName(name);
        if (request.method === "GET" && action === "view")
          return yield* HttpServerResponse.json(yield* session.view());
        if (request.method === "POST" && action === "deliver") {
          const delivery = yield* decodeDelivery(yield* request.json);
          return yield* HttpServerResponse.json(
            yield* session.deliver(delivery.event, delivery.eventId),
          );
        }
        return HttpServerResponse.text("Unknown route", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }),
) {}
