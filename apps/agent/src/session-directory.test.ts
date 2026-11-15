import { describe, expect, it } from "@effect/vitest";
import { Events } from "@puchero/domain";
import { Context, Effect } from "effect";
import { makeSessionDirectory, type SessionPeer } from "./session-directory.ts";

const repo = { owner: "acme", name: "app" };
const event = Events.IssueLabeled.make({ context: "Fix it", baseSha: "base", baseRef: "main" });
describe("Session directory", () => {
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
