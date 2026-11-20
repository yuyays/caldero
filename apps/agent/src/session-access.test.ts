import { describe, expect, it } from "@effect/vitest";
import { SessionFault } from "@caldero/contracts/inbox";
import { Effect } from "effect";
import { makeSessionAccess } from "./session-access.ts";
import { SessionHostError } from "./session-host.ts";

describe("Session activation", () => {
  it.effect(
    "checks stored identity against the named issue before activation, reads or alarm can open a host",
    () =>
      Effect.gen(function* () {
        let writes = 0,
          opens = 0;
        const access = yield* makeSessionAccess({
          expectedIssue: 7,
          readIdentity: Effect.succeed({ issue: 9 }),
          writeIdentity: () =>
            Effect.sync(() => {
              writes++;
            }),
          create: () =>
            Effect.sync(() => {
              opens++;
              return {};
            }),
          clearAlarm: Effect.void,
        });
        expect(yield* access.open().pipe(Effect.flip)).toMatchObject({
          _tag: "SessionFault",
          code: "identity_mismatch",
        });
        expect(yield* access.open(9).pipe(Effect.flip)).toMatchObject({
          code: "identity_mismatch",
        });
        expect({ writes, opens }).toEqual({ writes: 0, opens: 0 });
      }),
  );
  it.effect(
    "knowing the expected issue never grants reads permission to create a missing session",
    () =>
      Effect.gen(function* () {
        let writes = 0,
          opens = 0;
        const access = yield* makeSessionAccess({
          expectedIssue: 7,
          readIdentity: Effect.succeed(undefined),
          writeIdentity: () =>
            Effect.sync(() => {
              writes++;
            }),
          create: (issue) =>
            Effect.sync(() => {
              opens++;
              return { issue };
            }),
          clearAlarm: Effect.void,
        });
        expect(yield* access.open()).toBeUndefined();
        expect({ writes, opens }).toEqual({ writes: 0, opens: 0 });
        expect(yield* access.open(7)).toEqual({ issue: 7 });
        expect({ writes, opens }).toEqual({ writes: 1, opens: 1 });
      }),
  );

  it.effect(
    "latches unreadable identity and rejects repeat start without writing or opening a host",
    () =>
      Effect.gen(function* () {
        let writes = 0,
          opens = 0,
          alarmClears = 0;
        const access = yield* makeSessionAccess({
          expectedIssue: 7,
          readIdentity: Effect.succeed({ issue: "unreadable" }),
          writeIdentity: () =>
            Effect.sync(() => {
              writes++;
            }),
          create: () =>
            Effect.sync(() => {
              opens++;
              return {};
            }),
          clearAlarm: Effect.sync(() => {
            alarmClears++;
          }),
        });
        for (const issue of [undefined, 7, 8])
          expect(yield* access.open(issue).pipe(Effect.flip)).toMatchObject({
            _tag: "SessionFault",
            code: "state_unreadable",
          });
        expect(access.faulted()).toBe(true);
        expect({ writes, opens }).toEqual({ writes: 0, opens: 0 });
        expect(alarmClears).toBe(3);
      }),
  );
  it.effect(
    "latches identity mismatch before writes and clears alarms after a permanent host-open fault",
    () =>
      Effect.gen(function* () {
        let opens = 0,
          alarmClears = 0;
        const options = {
          expectedIssue: 7,
          readIdentity: Effect.succeed({ issue: 7 }),
          writeIdentity: () => Effect.die("Unexpected identity write"),
          create: () =>
            Effect.sync(() => {
              opens++;
              return {};
            }),
          clearAlarm: Effect.sync(() => {
            alarmClears++;
          }),
        };
        const mismatch = yield* makeSessionAccess(options);
        expect(yield* mismatch.open(8).pipe(Effect.flip)).toMatchObject({
          code: "identity_mismatch",
        });
        expect(yield* mismatch.open(7).pipe(Effect.flip)).toMatchObject({
          code: "identity_mismatch",
        });
        expect(opens).toBe(0);
        expect(alarmClears).toBe(2);
        alarmClears = 0;
        const unreadable = yield* makeSessionAccess({
          ...options,
          create: () =>
            Effect.fail(
              new SessionFault({ code: "state_unreadable", message: "Cannot read stored state" }),
            ),
        });
        expect(yield* unreadable.open().pipe(Effect.flip)).toMatchObject({
          code: "state_unreadable",
        });
        expect(unreadable.faulted()).toBe(true);
        expect(alarmClears).toBe(1);
      }),
  );
  it.effect(
    "closes failed activation resources and allows a temporary open failure to recover without latching",
    () =>
      Effect.gen(function* () {
        let attempts = 0,
          released = 0,
          clears = 0;
        const access = yield* makeSessionAccess({
          expectedIssue: 7,
          readIdentity: Effect.succeed({ issue: 7 }),
          writeIdentity: () => Effect.void,
          clearAlarm: Effect.sync(() => {
            clears++;
          }),
          create: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  released++;
                }),
              );
              attempts++;
              if (attempts === 1)
                return yield* new SessionHostError({ message: "Temporary read failure" });
              return { issue: 7 };
            }),
        });
        expect(yield* access.open().pipe(Effect.flip)).toMatchObject({ _tag: "SessionHostError" });
        expect(access.faulted()).toBe(false);
        expect({ released, clears }).toEqual({ released: 1, clears: 0 });
        expect(yield* access.open()).toEqual({ issue: 7 });
        expect(yield* access.open()).toEqual({ issue: 7 });
        expect(attempts).toBe(2);
        yield* access.fail(
          new SessionFault({ code: "state_unreadable", message: "State became unreadable" }),
        );
        expect(released).toBe(2);
        expect(clears).toBe(1);
        expect(yield* access.open().pipe(Effect.flip)).toMatchObject({ code: "state_unreadable" });
      }),
  );
});
