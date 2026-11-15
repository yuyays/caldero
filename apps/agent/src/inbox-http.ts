import { createHmac, timingSafeEqual } from "node:crypto";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  InboxApi,
  InboxForbidden,
  InboxMediaType,
  InboxNotFound,
  InboxUnavailable,
  StaleDecision,
  type SessionView,
} from "@puchero/contracts/inbox";
import { Events, type DecisionResult, type Repo, type SessionEvent } from "@puchero/domain";
import { InboxAuth } from "./inbox-auth.ts";
import { InboxStore } from "./inbox-store.ts";
import { GitHub } from "./ports.ts";

export class Sessions extends Context.Service<
  Sessions,
  {
    readonly read: (sessionId: string) => Effect.Effect<SessionView | null, InboxUnavailable>;
    readonly deliver: (
      sessionId: string,
      event: SessionEvent,
      eventId: string,
    ) => Effect.Effect<
      { readonly result: DecisionResult; readonly view: SessionView } | null,
      InboxUnavailable
    >;
    readonly start: (
      issue: number,
      event: Extract<SessionEvent, { readonly _tag: "IssueLabeled" }>,
      deliveryId: string,
    ) => Effect.Effect<void, InboxUnavailable>;
  }
>()("puchero/Sessions") {}

export class InboxConfig extends Context.Service<
  InboxConfig,
  {
    readonly origin: string;
    readonly webhookSecret: string;
    readonly repo: Repo;
    readonly installationId: number;
    readonly policy: "off" | "observe";
  }
>()("puchero/InboxConfig") {}

const viewer = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* (yield* InboxAuth).authenticate(request.headers);
});
const requireJsonOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* InboxConfig;
  if (request.headers.origin !== config.origin)
    return yield* new InboxForbidden({ message: "This action must come from the inbox origin" });
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return yield* new InboxMediaType({ message: "Actions require application/json" });
  return undefined;
});

/** Decisions always use the actor from authentication and return the authoritative view after admission. */
const act = Effect.fn("Inbox.act")(function* (
  sessionId: string,
  requestId: string,
  action: string,
  event: (actor: string) => SessionEvent,
) {
  const actor = yield* viewer;
  yield* requireJsonOrigin;
  const result = yield* (yield* Sessions).deliver(
    sessionId,
    event(actor.login),
    `inbox:${actor.login}:${action}:${requestId}`,
  );
  if (result === null) return yield* new InboxNotFound({ message: "Session not found" });
  if (result.result === "stale")
    return yield* new StaleDecision({
      message: "The session changed. Review the current candidate before deciding.",
      view: result.view,
    });
  return { result: result.result, view: result.view };
});

const SessionRoutes = HttpApiBuilder.group(InboxApi, "sessions", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        yield* viewer;
        return yield* (yield* InboxStore)
          .list()
          .pipe(
            Effect.mapError(
              () => new InboxUnavailable({ message: "Session index is unavailable" }),
            ),
          );
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        yield* viewer;
        const view = yield* (yield* Sessions).read(params.sessionId);
        if (view === null) return yield* new InboxNotFound({ message: "Session not found" });
        const audit = yield* (yield* InboxStore)
          .audit(params.sessionId)
          .pipe(
            Effect.mapError(
              () => new InboxUnavailable({ message: "Audit history is unavailable" }),
            ),
          );
        return { view, audit };
      }),
    )
    .handle("approve", ({ params, payload }) =>
      act(params.sessionId, payload.requestId, "approve", (actor) =>
        Events.Approve.make({ actor, binding: payload.binding }),
      ),
    )
    .handle("reject", ({ params, payload }) =>
      act(params.sessionId, payload.requestId, "reject", (actor) =>
        Events.Reject.make({ actor, binding: payload.binding }),
      ),
    )
    .handle("cancel", ({ params, payload }) =>
      act(params.sessionId, payload.requestId, "cancel", (actor) => Events.Cancel.make({ actor })),
    )
    .handle("input", ({ params, payload }) =>
      act(params.sessionId, payload.requestId, "input", () =>
        Events.UserInput.make({ text: payload.text }),
      ),
    ),
);
const ViewerRoutes = HttpApiBuilder.group(InboxApi, "viewer", (handlers) =>
  handlers.handle("get", () => viewer),
);
export const InboxRoutes = HttpApiBuilder.layer(InboxApi).pipe(
  Layer.provide(SessionRoutes),
  Layer.provide(ViewerRoutes),
);

const decodeWebhook = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.String,
      repository: Schema.Struct({ full_name: Schema.String }),
      installation: Schema.optionalKey(Schema.Struct({ id: Schema.Int })),
      label: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
      issue: Schema.Struct({
        number: Schema.Int,
        pull_request: Schema.optionalKey(Schema.Unknown),
      }),
      sender: Schema.Struct({ login: Schema.String }),
    }),
  ),
);

/** Authenticate raw bytes first. Hydration may retry; only the first successfully committed admission sets the base. */
const webhook = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* InboxConfig;
  const body = new Uint8Array(yield* request.arrayBuffer);
  if (body.byteLength > 1_048_576)
    return HttpServerResponse.text("Payload too large", { status: 413 });
  const signature = request.headers["x-hub-signature-256"] ?? "";
  const actual = /^sha256=[a-f\d]{64}$/i.test(signature)
    ? Buffer.from(signature.slice(7), "hex")
    : Buffer.alloc(0);
  const expected = createHmac("sha256", config.webhookSecret).update(body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return HttpServerResponse.text("Invalid webhook signature", { status: 401 });
  if (request.headers["x-github-event"] !== "issues")
    return HttpServerResponse.empty({ status: 204 });
  const decoded = yield* decodeWebhook(new TextDecoder().decode(body)).pipe(Effect.result);
  if (Result.isFailure(decoded))
    return HttpServerResponse.text("Invalid webhook payload", { status: 400 });
  const payload = decoded.success;
  if (
    config.policy === "off" ||
    payload.action !== "labeled" ||
    payload.label?.name !== "agent" ||
    payload.repository.full_name !== `${config.repo.owner}/${config.repo.name}` ||
    payload.installation?.id !== config.installationId ||
    payload.issue.number <= 0 ||
    "pull_request" in payload.issue
  )
    return HttpServerResponse.empty({ status: 204 });
  const deliveryId = request.headers["x-github-delivery"];
  if (!deliveryId || deliveryId.length > 200)
    return HttpServerResponse.text("Missing delivery ID", { status: 400 });
  const context = yield* (yield* GitHub)
    .fetchIssueContext(config.repo, payload.issue.number)
    .pipe(
      Effect.mapError(
        () => new InboxUnavailable({ message: "Could not hydrate the GitHub issue" }),
      ),
    );
  const provenance = `\n\n## Verified trigger\nDelivery: ${deliveryId}\nSender: ${payload.sender.login}\nLabel: agent\nBase at admission: ${context.baseSha}`;
  yield* (yield* Sessions).start(
    payload.issue.number,
    Events.IssueLabeled.make({ ...context, context: context.context + provenance }),
    deliveryId,
  );
  return HttpServerResponse.empty({ status: 204 });
}).pipe(
  Effect.catchTag("InboxUnavailable", () =>
    Effect.succeed(
      HttpServerResponse.text("Admission unavailable; retry this delivery", { status: 503 }),
    ),
  ),
);

export const WebhookRoutes = HttpRouter.add("POST", "/webhooks/github", webhook);
export const ApplicationRoutes = Layer.mergeAll(InboxRoutes, WebhookRoutes);
