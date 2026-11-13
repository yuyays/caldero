// PROTOTYPE, throwaway: routes /s/:id/{submit,status,crash,reset} to the session's Durable Object.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Session from "./Session.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* Session;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [, s, id, action] = url.pathname.split("/");
        if (s !== "s" || !id || !action) return HttpServerResponse.text("POST /s/:id/submit?text=&requestId= | GET /s/:id/status | POST /s/:id/crash | POST /s/:id/reset", { status: 404 });
        const session = sessions.getByName(id);
        if (action === "submit") {
          const text = url.searchParams.get("text") ?? "go";
          const requestId = url.searchParams.get("requestId") ?? crypto.randomUUID();
          return yield* HttpServerResponse.json(yield* session.submit(text, requestId));
        }
        if (action === "status") return yield* HttpServerResponse.json(yield* session.status());
        if (action === "crash") {
          yield* session.crash().pipe(Effect.ignore);
          return HttpServerResponse.text("crashed\n");
        }
        if (action === "reset") {
          yield* session.resetContainer();
          return HttpServerResponse.text("container destroyed\n");
        }
        return HttpServerResponse.text("unknown action", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }),
) {}
