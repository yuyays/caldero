import { createHmac } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { InboxApi, summarizeSession } from "@puchero/contracts/inbox";
import { decide, Events, initialSession } from "@puchero/domain";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { makeFakeGitHub } from "./fake-github.ts";
import { makeInboxAuth, InboxAuth } from "./inbox-auth.ts";
import { ApplicationRoutes, InboxConfig, Sessions } from "./inbox-http.ts";
import { InboxStore } from "./inbox-store.ts";

const repo = { owner: "acme", name: "app" };
const id = "acme/app#7";
const origin = "http://localhost";
const secret = "local-webhook-secret";
const patch = {
  digest: "digest-1",
  diff: "diff --git a/notes.txt b/notes.txt\n+fixed",
  files: [{ path: "notes.txt", change: "write" as const, content: "Zml4ZWQ=", executable: false }],
};
const payload = {
  action: "labeled",
  repository: { full_name: "acme/app" },
  installation: { id: 42 },
  label: { name: "agent" },
  issue: { number: 7 },
  sender: { login: "ann" },
};
const setup = Effect.fn("setupInboxHttp")(function* (
  options: { hold?: Promise<void>; onAdmission?: () => void; policy?: "off" | "observe" } = {},
) {
  let state = initialSession({ sessionId: id, repo, issue: 7, policy: "observe" });
  let exists = false;
  let starts = 0;
  let admissionContext = "";
  const view = () => ({ state, patch: state.candidate === null ? null : patch });
  const apply = (event: Parameters<typeof decide>[1]) => {
    const result = decide(state, event, state.updatedAt + 1);
    state = result.state;
    return result.result;
  };
  const seen = new Set<string>();
  const auth = yield* makeInboxAuth({ mode: "dev", token: "local-token", login: "ann" });
  const services = Layer.mergeAll(
    Layer.succeed(InboxAuth, auth),
    Layer.succeed(InboxConfig, {
      origin,
      webhookSecret: secret,
      repo,
      installationId: 42,
      policy: options.policy ?? "observe",
    }),
    Layer.succeed(InboxStore, {
      list: () => Effect.succeed(exists ? [summarizeSession(state)] : []),
      audit: () => Effect.succeed([]),
    }),
    makeFakeGitHub({ source: [] }).layer,
    Layer.succeed(Sessions, {
      read: () => Effect.succeed(exists ? view() : null),
      deliver: (_sessionId, event, eventId) =>
        Effect.sync(() => {
          if (!exists) return null;
          const result = seen.has(eventId) ? "duplicate" : apply(event);
          seen.add(eventId);
          return { result, view: view() };
        }),
      start: (_issue, event, deliveryId) =>
        Effect.gen(function* () {
          options.onAdmission?.();
          if (options.hold !== undefined) yield* Effect.promise(() => options.hold!);
          if (!seen.has(deliveryId)) {
            starts += 1;
            exists = true;
            admissionContext = event.context;
            apply(event);
            seen.add(deliveryId);
          }
        }),
    }),
  );
  const http = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        ApplicationRoutes.pipe(
          Layer.provideMerge(services),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(() => dispose()),
  );
  const send = (path: string, init?: RequestInit) =>
    Effect.promise(() => http.handler(new Request(`${origin}${path}`, init)));
  const webhook = (data = payload, signature?: string) => {
    const body = JSON.stringify(data);
    return send("/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-hub-signature-256":
          signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
      },
    });
  };
  const propose = () => {
    apply(Events.RunAnswered.make({ runId: 1 }));
    apply(Events.Validated.make({ runId: 1, patchDigest: patch.digest, evidence: "tests passed" }));
    return state.candidate!.binding;
  };
  return {
    send,
    webhook,
    propose,
    view,
    starts: () => starts,
    admissionContext: () => admissionContext,
    handler: http.handler,
  };
});

describe("Inbox HTTP", () => {
  it.effect("acknowledges only after durable admission resolves", () =>
    Effect.gen(function* () {
      const hold = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let acknowledged = false;
      const api = yield* setup({ hold: hold.promise, onAdmission: () => started.resolve() });
      const request = yield* api.webhook().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            acknowledged = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started.promise);
      expect(acknowledged).toBe(false);
      expect(api.starts()).toBe(0);
      hold.resolve();
      expect((yield* Fiber.join(request)).status).toBe(204);
      expect(api.starts()).toBe(1);
    }),
  );

  it.effect(
    "admits a signed label once with verified provenance and ignores unrelated deliveries",
    () =>
      Effect.gen(function* () {
        const api = yield* setup();
        expect((yield* api.webhook()).status).toBe(204);
        expect((yield* api.webhook()).status).toBe(204);
        expect(api.starts()).toBe(1);
        expect(api.admissionContext()).toContain("Delivery: delivery-1\nSender: ann\nLabel: agent");
        expect((yield* api.webhook(payload, "sha256=bad")).status).toBe(401);
        for (const unrelated of [
          { ...payload, installation: { id: 99 } },
          { ...payload, repository: { full_name: "evil/repo" } },
          { ...payload, label: { name: "other" } },
          { ...payload, issue: { number: 7, pull_request: {} } },
        ]) {
          expect((yield* api.webhook(unrelated)).status).toBe(204);
        }
        expect(api.starts()).toBe(1);
        const off = yield* setup({ policy: "off" });
        expect((yield* off.webhook()).status).toBe(204);
        expect(off.starts()).toBe(0);
      }),
  );

  it.effect(
    "derives the approval actor from auth, returns stale candidates as 409, and serves the typed client",
    () =>
      Effect.gen(function* () {
        const api = yield* setup();
        yield* api.webhook();
        const binding = api.propose();
        const headers = {
          authorization: "Bearer local-token",
          origin,
          "content-type": "application/json",
        };
        const path = `/api/sessions/${encodeURIComponent(id)}/approve`;
        const stale = yield* api.send(path, {
          method: "POST",
          headers,
          body: JSON.stringify({ binding: { ...binding, patchDigest: "old" }, requestId: "stale" }),
        });
        expect(stale.status).toBe(409);
        expect(yield* Effect.promise(() => stale.json())).toMatchObject({
          view: { state: { candidate: { binding } } },
        });
        const approve = () =>
          api.send(path, {
            method: "POST",
            headers,
            body: JSON.stringify({ binding, requestId: "approve-1", actor: "eve" }),
          });
        expect((yield* approve()).status).toBe(200);
        expect((yield* approve()).status).toBe(200);
        expect(api.view().state.decidedBy).toBe("ann");
        const summaries = yield* Effect.gen(function* () {
          const client = yield* HttpApiClient.make(InboxApi, { baseUrl: origin });
          return yield* client.sessions.list({});
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
            const request = new Request(input, init);
            request.headers.set("authorization", "Bearer local-token");
            return api.handler(request);
          }),
        );
        expect(summaries[0]).toMatchObject({ sessionId: id, status: "publishing" });
        expect(summaries[0]).not.toHaveProperty("patch");
      }),
  );

  it.effect("rejects missing authentication, cross-origin decisions, and non-JSON mutations", () =>
    Effect.gen(function* () {
      const api = yield* setup();
      yield* api.webhook();
      const binding = api.propose();
      expect((yield* api.send("/api/sessions")).status).toBe(401);
      const path = `/api/sessions/${encodeURIComponent(id)}/approve`;
      const body = JSON.stringify({ binding, requestId: "one" });
      expect(
        (yield* api.send(path, {
          method: "POST",
          body,
          headers: {
            authorization: "Bearer local-token",
            origin: "https://evil.test",
            "content-type": "application/json",
          },
        })).status,
      ).toBe(403);
      expect(
        (yield* api.send(path, {
          method: "POST",
          body,
          headers: { authorization: "Bearer local-token", origin, "content-type": "text/plain" },
        })).status,
      ).toBe(415);
      expect(api.view().state.status).toBe("awaitingApproval");
      expect((yield* api.send("/s/demo/deliver", { method: "POST", body })).status).toBe(404);
    }),
  );
});
