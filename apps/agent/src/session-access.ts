import { SessionFault } from "@caldero/contracts/inbox";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";
import type { SessionHostError } from "./session-host.ts";

const decodeIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({
    issue: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
);

const identityMismatch = () =>
  new SessionFault({
    code: "identity_mismatch",
    message: "Stored session identity does not match this issue; operator repair is required.",
  });

/** Owns one session's identity, activation resources and sticky instance fault. Temporary failures never latch. */
export const makeSessionAccess = Effect.fn("makeSessionAccess")(function* <A>(options: {
  readonly expectedIssue: number | undefined;
  readonly readIdentity: Effect.Effect<unknown, SessionHostError>;
  readonly writeIdentity: (issue: number) => Effect.Effect<void, SessionHostError>;
  readonly create: (
    issue: number,
  ) => Effect.Effect<A, SessionHostError | SessionFault, Scope.Scope>;
  readonly clearAlarm: Effect.Effect<void, SessionHostError>;
}) {
  const instanceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  let host: A | undefined;
  let fault: SessionFault | undefined;
  let hostScope: Scope.Closeable | undefined;
  const fail = Effect.fn("SessionAccess.fail")(function* (error: SessionFault) {
    fault ??= error;
    if (hostScope !== undefined) yield* Scope.close(hostScope, Exit.fail(error));
    yield* options.clearAlarm.pipe(
      Effect.catch(() => Effect.logError("Could not clear the faulted session alarm")),
    );
  }, Effect.uninterruptible);
  const openHost = Effect.fn("SessionAccess.open")(function* (newIssue?: number) {
    if (fault !== undefined) return yield* fault;
    const expected = options.expectedIssue;
    if (
      expected === undefined ||
      !Number.isSafeInteger(expected) ||
      expected < 1 ||
      (newIssue !== undefined && newIssue !== expected)
    )
      return yield* identityMismatch();
    if (host !== undefined) return host;
    const saved = yield* options.readIdentity;
    if (saved === undefined && newIssue === undefined) return undefined;
    const identity =
      saved === undefined
        ? newIssue
        : (yield* decodeIdentity(saved).pipe(
            Effect.mapError(
              () =>
                new SessionFault({
                  code: "state_unreadable",
                  message: "Stored session identity cannot be read; operator repair is required.",
                }),
            ),
          )).issue;
    // The native DO name fixes identity even when no caller is creating a session (reads and alarms).
    if (identity !== expected) return yield* identityMismatch();
    if (saved === undefined) yield* options.writeIdentity(expected);
    // Failed attempts close immediately. A successful host belongs to the DO instance, not an RPC request.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const attemptScope = yield* Scope.fork(instanceScope);
        const result = yield* options
          .create(identity)
          .pipe(Effect.provideService(Scope.Scope, attemptScope), restore, Effect.exit);
        if (Exit.isFailure(result)) {
          yield* Scope.close(attemptScope, result);
          return yield* Effect.failCause(result.cause);
        }
        hostScope = attemptScope;
        host = result.value;
        return host;
      }),
    );
  });
  const open = (newIssue?: number) =>
    lock.withPermits(1)(
      openHost(newIssue).pipe(
        Effect.tapError((error) => (error instanceof SessionFault ? fail(error) : Effect.void)),
      ),
    );
  return { open, fail, faulted: () => fault !== undefined };
});
