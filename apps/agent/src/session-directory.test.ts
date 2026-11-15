import { describe, expect, it } from "@effect/vitest";
import { SessionFault } from "@puchero/contracts/inbox";
import { RpcCallError, encodeRpcError, makeRpcErrorReviver } from "alchemy/Rpc";
import { Events } from "@puchero/domain";
import { Context, Effect } from "effect";
import { makeSessionDirectory, type SessionPeer } from "./session-directory.ts";

const repo = { owner: "acme", name: "app" };
const event = Events.IssueLabeled.make({ context: "Fix it", baseSha: "base", baseRef: "main" });
describe("Session directory", () => {
  it.effect(
    "preserves declared permanent faults after Alchemy RPC serialization instead of flattening them to unavailable",
    () =>
      Effect.gen(function* () {
        const wire = structuredClone(
          encodeRpcError(
            new SessionFault({
              code: "state_unreadable",
              message: "Stored state cannot be read; operator repair is required.",
            }),
          ),
        );
        const revived = makeRpcErrorReviver([SessionFault])(wire);
        if (!(revived instanceof SessionFault))
          return yield* Effect.die(new Error("RPC did not revive the declared fault"));
        const peer: SessionPeer<never> = {
          view: () => Effect.fail(revived),
          start: () => Effect.fail(revived),
          deliver: () => Effect.fail(revived),
        };
        const directory = makeSessionDirectory(repo, () => peer, Context.empty());
        for (const effect of [
          directory.read("acme/app#7"),
          directory.start(7, event, "delivery"),
          directory.deliver("acme/app#7", event, "request"),
        ])
          expect(yield* effect.pipe(Effect.flip)).toMatchObject({
            _tag: "SessionFault",
            code: "state_unreadable",
          });
        return undefined;
      }),
  );
  it.effect(
    "distinguishes transient and overloaded transport from unknown outcomes without redispatch",
    () =>
      Effect.gen(function* () {
        for (const [cause, reason] of [
          [Object.assign(new Error("native"), { retryable: true }), "temporary"],
          [Object.assign(new Error("native"), { retryable: true, overloaded: true }), "overloaded"],
          [Object.assign(new Error("native"), { remote: true }), "unknown"],
        ] as const) {
          let calls = 0;
          const failed = () =>
            Effect.suspend(() => {
              calls++;
              return Effect.fail(new RpcCallError({ method: "deliver", cause }));
            });
          const peer: SessionPeer<never> = { view: failed, deliver: failed, start: failed };
          const directory = makeSessionDirectory(repo, () => peer, Context.empty());
          expect(
            yield* directory.deliver("acme/app#7", event, "stable-request-id").pipe(Effect.flip),
          ).toMatchObject({ _tag: "InboxUnavailable", reason });
          expect(calls).toBe(1);
        }
      }),
  );

  it.effect(
    "does not access a DO for foreign or malformed identities and names admitted issues deterministically",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let admitted: { issue: number; eventId: string } | undefined;
        const directory = makeSessionDirectory(
          repo,
          (name) => {
            calls.push(name);
            return {
              view: () => Effect.succeed(null),
              deliver: () => Effect.succeed(null),
              start: (issue, _event, eventId) =>
                Effect.sync(() => {
                  admitted = { issue, eventId };
                }),
            };
          },
          Context.empty(),
        );
        for (const id of [
          "other/app#7",
          "acme/app#0",
          "acme/app#-1",
          "acme/app#07",
          "acme/app#7/trailing",
          "acme/app#9007199254740992",
        ]) {
          expect(yield* directory.read(id)).toBeNull();
          expect(yield* directory.deliver(id, event, "event")).toBeNull();
        }
        expect(calls).toEqual([]);
        yield* directory.start(7, event, "delivery");
        expect(calls).toEqual(["acme/app#7"]);
        expect(admitted).toEqual({ issue: 7, eventId: "delivery" });
        expect(yield* directory.read("acme/app#7")).toBeNull();
      }),
  );

  it.effect(
    "reports RPC defects and unavailable transport as unknown outcomes without acknowledging them",
    () =>
      Effect.gen(function* () {
        const peer: SessionPeer<never> = {
          view: () => Effect.die(new Error("broken storage")),
          deliver: () => Effect.die(new Error("response lost")),
          start: () => Effect.die(new Error("response lost after admission")),
        };
        const directory = makeSessionDirectory(repo, () => peer, Context.empty());
        for (const effect of [
          directory.read("acme/app#7"),
          directory.deliver("acme/app#7", event, "request"),
          directory.start(7, event, "delivery"),
        ]) {
          expect(yield* effect.pipe(Effect.flip)).toMatchObject({ _tag: "InboxUnavailable" });
        }
      }),
  );
});
