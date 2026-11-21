import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Repo, Status } from "@caldero/domain";
import { SessionFault } from "@caldero/contracts/inbox";
import { Deferred, Effect, Result, Schema, type Scope } from "effect";
import { holdLocalLock, LocalRunnerError } from "./local-runner.ts";
import type { GitHubError } from "./ports.ts";
import type { SessionHostError } from "./session-host.ts";
import { type LocalWatchReceipt, decodeWatchReceipt } from "./local-watch-receipt.ts";

export class LocalWatchError extends Schema.TaggedError<LocalWatchError>()("LocalWatchError", {
  message: Schema.String,
}) {}

export class LocalWatchIssueError extends Schema.TaggedError<LocalWatchIssueError>()(
  "LocalWatchIssueError",
  {
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const localWatchIssueError = (
  error: GitHubError | LocalRunnerError | SessionFault | SessionHostError,
) =>
  new LocalWatchIssueError({
    message: error.message,
    retryable:
      !(error instanceof SessionFault) &&
      !(error instanceof LocalRunnerError && error.reason === "configuration"),
  });

const settledStatuses: ReadonlySet<Status> = new Set([
  "published",
  "failed",
  "cancelled",
  "rejected",
  "awaitingApproval",
]);

/** Persist scheduling receipts before work starts. The issue SQLite owns execution and publication. */
export const openLocalWatcher = Effect.fn("openLocalWatcher")(function* (options: {
  readonly repo: Repo;
  readonly stateRoot: string;
  readonly pollSeconds: number;
  readonly discover: Effect.Effect<ReadonlyArray<number>, GitHubError>;
  readonly runIssue: (
    issue: number,
    admit: boolean,
  ) => Effect.Effect<Status, LocalWatchIssueError, Scope.Scope>;
  readonly repairIssue?: (
    issue: number,
    admit: boolean,
  ) => Effect.Effect<void, LocalWatchIssueError, Scope.Scope>;
}) {
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 1)
    return yield* new LocalWatchError({
      message: "Watch poll interval must be at least one second",
    });
  yield* Effect.tryPromise({
    try: () => mkdir(options.stateRoot, { recursive: true, mode: 0o700 }),
    catch: () => new LocalWatchError({ message: "Could not create the watch state directory" }),
  });
  yield* holdLocalLock(options.stateRoot, ".watch.lock");
  const path = join(options.stateRoot, "watch.json");
  const stored = yield* Effect.tryPromise({
    try: () =>
      readFile(path, "utf8").catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }),
    catch: () => new LocalWatchError({ message: "Could not read watch receipts" }),
  });
  let state =
    stored === undefined
      ? { version: 1 as const, repo: options.repo, pending: [], settled: [] }
      : yield* decodeWatchReceipt(stored).pipe(
          Effect.mapError(
            () =>
              new LocalWatchError({
                message: "Watch receipts cannot be read; operator repair is required",
              }),
          ),
        );
  if (state.repo.owner !== options.repo.owner || state.repo.name !== options.repo.name)
    return yield* new LocalWatchError({ message: "Watch state belongs to a different repository" });
  const stopping = yield* Deferred.make<void>();
  const save = Effect.fn("LocalWatcher.save")(function* (next: typeof LocalWatchReceipt.Type) {
    const temporary = `${path}.tmp`;
    const ioError = () =>
      new LocalWatchError({
        message: "Could not save watch receipts; no further issues were started",
      });
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => open(temporary, "w", 0o600), catch: ioError }),
      (file) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => file.writeFile(JSON.stringify(next)),
            catch: ioError,
          });
          yield* Effect.tryPromise({ try: () => file.sync(), catch: ioError });
        }),
      (file) => Effect.tryPromise({ try: () => file.close(), catch: ioError }),
    );
    yield* Effect.tryPromise({ try: () => rename(temporary, path), catch: ioError });
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => open(options.stateRoot, "r"), catch: ioError }),
      (directory) => Effect.tryPromise({ try: () => directory.sync(), catch: ioError }),
      (directory) => Effect.tryPromise({ try: () => directory.close(), catch: ioError }),
    );
    state = next;
  });
  const run = Effect.gen(function* () {
    while (!(yield* Deferred.isDone(stopping))) {
      const eligible = yield* options.discover.pipe(
        Effect.map((issues) => new Set(issues)),
        Effect.catch((error) =>
          Effect.logWarning(`Issue discovery failed: ${error.message}`).pipe(Effect.as(undefined)),
        ),
      );
      const pending = [
        ...new Set([
          ...state.pending,
          ...[...(eligible ?? [])].filter((issue) => !state.settled.includes(issue)),
        ]),
      ];
      if (pending.length !== state.pending.length) yield* save({ ...state, pending });
      for (const issue of state.pending) {
        if (yield* Deferred.isDone(stopping)) return;
        const outcome = yield* Effect.scoped(
          options.runIssue(issue, eligible?.has(issue) ?? false),
        ).pipe(Effect.result);
        if (Result.isFailure(outcome)) {
          yield* Effect.logError(`Issue #${issue}: ${outcome.failure.message}`);
          if (outcome.failure.retryable) continue;
        } else {
          yield* Effect.logInfo(`Issue #${issue}: ${outcome.success}`);
          // A failed scan cannot establish whether an idle issue is still eligible.
          if (outcome.success === "idle" && eligible === undefined) continue;
          if (outcome.success !== "idle" && !settledStatuses.has(outcome.success)) continue;
        }
        yield* save({
          ...state,
          pending: state.pending.filter((number) => number !== issue),
          settled:
            Result.isSuccess(outcome) && outcome.success === "idle"
              ? state.settled
              : [...state.settled, issue],
        });
      }
      if (options.repairIssue) {
        for (const issue of state.settled) {
          if (yield* Deferred.isDone(stopping)) return;
          yield* Effect.scoped(options.repairIssue(issue, eligible?.has(issue) ?? false)).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Issue #${issue}: automatic repair could not proceed: ${error.message}`,
              ),
            ),
          );
        }
      }
      yield* Deferred.await(stopping).pipe(
        Effect.timeoutOrElse({
          duration: `${options.pollSeconds} seconds`,
          orElse: () => Effect.void,
        }),
      );
    }
  });
  return { run, stop: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid) };
});
