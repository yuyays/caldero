import { createHmac } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  InboxApi,
  InboxUnavailable,
  SessionFault,
  summarizeSession,
} from "@puchero/contracts/inbox";
import { decide, Events, initialSession, type Policy } from "@puchero/domain";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { makeFakeGitHub } from "./fake-github.ts";
import { makeInboxAuth, InboxAuth } from "./inbox-auth.ts";
import { ApplicationRoutes, InboxConfig, Sessions } from "./inbox-http.ts";
import { InboxStore } from "./inbox-store.ts";
import { GitHub, GitHubError, ProjectionError } from "./ports.ts";

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
  options: {
    hold?: Promise<void>;
    onAdmission?: () => void;
    policy?: Policy;
    failure?: "hydration" | "admission" | "audit" | "permanent";
    unavailableReason?: "temporary" | "overloaded" | "unknown";
  } = {},
) {
  let state = initialSession({
    sessionId: id,
    repo,
    issue: 7,
    policy: options.policy ?? "observe",
  });
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
      audit: () =>
        options.failure === "audit"
          ? Effect.fail(new ProjectionError({ message: "D1 unavailable" }))
          : Effect.succeed([]),
    }),
    Layer.effect(
      GitHub,
      Effect.gen(function* () {
        const github = yield* GitHub;
        return {
          ...github,
          fetchIssueContext:
            options.failure === "hydration"
              ? () => Effect.fail(new GitHubError({ message: "GitHub unavailable" }))
              : github.fetchIssueContext,
        };
      }),
    ).pipe(Layer.provide(makeFakeGitHub({ source: [] }).layer)),
    Layer.succeed(Sessions, {
      read: () =>
        options.failure === "permanent"
          ? Effect.fail(
              new SessionFault({
                code: "state_unreadable",
                message: "Stored state cannot be read; operator repair is required.",
              }),
            )
          : Effect.succeed(exists ? view() : null),
      deliver: (_sessionId, event, eventId) =>
        options.failure === "permanent"
          ? Effect.fail(
              new SessionFault({
                code: "state_unreadable",
                message: "Stored state cannot be read; operator repair is required.",
              }),
            )
          : Effect.sync(() => {
              if (!exists) return null;
              const result = seen.has(eventId) ? "duplicate" : apply(event);
              seen.add(eventId);
              return { result, view: view() };
            }),
      start: (_issue, event, deliveryId) =>
        Effect.gen(function* () {
          options.onAdmission?.();
          if (options.failure === "permanent")
            return yield* new SessionFault({
              code: "state_unreadable",
              message: "Stored state cannot be read; operator repair is required.",
            });
          if (options.failure === "admission")
            return yield* new InboxUnavailable({
              message: "Storage unavailable",
              reason: options.unavailableReason ?? "unknown",
            });
          if (options.hold !== undefined) yield* Effect.promise(() => options.hold!);
          if (!seen.has(deliveryId)) {
            starts += 1;
            exists = true;
            admissionContext = event.context;
            apply(event);
            seen.add(deliveryId);
          }
          return undefined;
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
  const signedBody = (body: string, signature?: string) => {
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
  const webhook = (data = payload, signature?: string) =>
    signedBody(JSON.stringify(data), signature);
  const propose = () => {
    apply(Events.RunAnswered.make({ runId: 1 }));
    apply(Events.Validated.make({ runId: 1, patchDigest: patch.digest, evidence: "tests passed" }));
    return state.candidate!.binding;
  };
  return {
    send,
    webhook,
    signedBody,
    propose,
    view,
    starts: () => starts,
    admissionContext: () => admissionContext,
    handler: http.handler,
  };
});

describe("Inbox HTTP", () => {
  it.effect(
    "refuses human approval and rejection for automatic sessions without recording an actor",
    () =>
      Effect.gen(function* () {
        const api = yield* setup({ policy: "auto" });
        yield* api.webhook();
        const binding = api.propose();
        for (const action of ["approve", "reject"]) {
          const response = yield* api.send(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
            method: "POST",
            headers: {
              authorization: "Bearer local-token",
              origin,
              "content-type": "application/json",
            },
            body: JSON.stringify({ binding, requestId: `auto-${action}` }),
          });
          expect(response.status).toBe(409);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            view: { state: { policy: "auto", status: "publishing", decidedBy: null } },
          });
        }
      }),
  );

  it.effect("preserves availability diagnostics in signed webhook failure responses", () =>
    Effect.gen(function* () {
      for (const reason of ["temporary", "overloaded", "unknown"] as const) {
        const api = yield* setup({ failure: "admission", unavailableReason: reason });
        const response = yield* api.webhook();
        expect(response.status).toBe(503);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "InboxUnavailable",
          reason,
        });
        expect(api.starts()).toBe(0);
      }
    }),
  );

  it.effect(
    "returns permanent faults as typed 500 responses for admission, detail and decisions",
    () =>
      Effect.gen(function* () {
        const api = yield* setup({ failure: "permanent" });
        const admission = yield* api.webhook();
        expect(admission.status).toBe(500);
        expect(yield* Effect.promise(() => admission.json())).toMatchObject({
          _tag: "SessionFault",
          code: "state_unreadable",
        });
        expect(api.starts()).toBe(0);
        const headers = {
          authorization: "Bearer local-token",
          origin,
          "content-type": "application/json",
        };
        const path = `/api/sessions/${encodeURIComponent(id)}`;
        for (const response of [
          yield* api.send(path, { headers }),
          yield* api.send(path + "/cancel", {
            method: "POST",
            headers,
            body: JSON.stringify({ requestId: "stop" }),
          }),
        ]) {
          expect(response.status).toBe(500);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            _tag: "SessionFault",
            code: "state_unreadable",
          });
        }
      }),
  );

  it.effect("keeps authoritative detail and decisions available when audit storage fails", () =>
    Effect.gen(function* () {
      const api = yield* setup({ failure: "audit" });
      yield* api.webhook();
      const binding = api.propose();
      const headers = {
        authorization: "Bearer local-token",
        origin,
        "content-type": "application/json",
      };
      const path = `/api/sessions/${encodeURIComponent(id)}`;
      const detail = yield* api.send(path, { headers });
      expect(detail.status).toBe(200);
      expect(yield* Effect.promise(() => detail.json())).toMatchObject({
        view: { state: { candidate: { binding } } },
        audit: [],
        auditUnavailable: true,
      });
      const cancel = yield* api.send(path + "/cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({ requestId: "stop-without-audit" }),
      });
      expect(cancel.status).toBe(200);
      expect(api.view().state.status).toBe("cancelled");
    }),
  );

  it.effect(
    "rejects oversized or malformed signed deliveries and reports failed admission without acknowledging it",
    () =>
      Effect.gen(function* () {
        const api = yield* setup();
        expect((yield* api.signedBody(" ".repeat(1_048_577))).status).toBe(413);
        expect((yield* api.signedBody("{broken")).status).toBe(400);
        expect((yield* api.signedBody("{}")).status).toBe(400);
        expect(api.starts()).toBe(0);
        for (const failure of ["hydration", "admission"] as const) {
          const unavailable = yield* setup({ failure });
          expect((yield* unavailable.webhook()).status).toBe(503);
          expect(unavailable.starts()).toBe(0);
        }
        expect((yield* api.send("/api/viewer")).status).toBe(401);
        const viewer = yield* api.send("/api/viewer", {
          headers: { authorization: "Bearer local-token" },
        });
        expect(viewer.status).toBe(200);
        expect(yield* Effect.promise(() => viewer.json())).toEqual({ login: "ann" });
      }),
  );

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
