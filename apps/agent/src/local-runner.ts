import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Events, type Repo } from "@puchero/domain";
import { Effect, Layer, Schema } from "effect";
import { makeDiskWorkspaceStore } from "./disk-workspace-store.ts";
import { readLocalSession } from "./local-status.ts";
import { LocalWorkspace } from "./local-workspace.ts";
import { GitHub, Projection } from "./ports.ts";
import { openSessionHost, type SessionHostOptions } from "./session-host.ts";

export class LocalRunnerError extends Schema.TaggedError<LocalRunnerError>()("LocalRunnerError", {
  message: Schema.String,
  reason: Schema.optionalKey(Schema.Literals(["locked", "configuration"])),
}) {}

export const validateLocalChecks = Effect.fn("validateLocalChecks")(
  (checks: ReadonlyArray<string>): Effect.Effect<void, LocalRunnerError> =>
    checks.length === 0 || checks.some((check) => !check.trim())
      ? Effect.fail(
          new LocalRunnerError({
            message: "Provide at least one nonempty --check COMMAND",
          }),
        )
      : Effect.void,
);

export const validateLocalIssue = Effect.fn("validateLocalIssue")(function* (
  issue: number,
  checks: ReadonlyArray<string>,
) {
  if (!Number.isSafeInteger(issue) || issue < 1)
    return yield* new LocalRunnerError({ message: "Provide a positive --issue NUMBER" });
  return yield* validateLocalChecks(checks);
});

const lockError = (code: string) => {
  const reason =
    code === "ELOCKED"
      ? "locked"
      : ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "64", "66", "69"].includes(code)
        ? "configuration"
        : undefined;
  return new LocalRunnerError({
    message: `Could not lock the local session (${code}); another runner may own it`,
    ...(reason === undefined ? {} : { reason }),
  });
};

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";

const localIoError = (message: string, error: unknown) =>
  new LocalRunnerError({
    message,
    ...(typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM", "ENOTDIR", "EISDIR", "EROFS", "SQLITE_CANTOPEN"].includes(
      String(error.code),
    )
      ? { reason: "configuration" as const }
      : {}),
  });

/** A kernel flock has no stale timeout: pausing a runner cannot hand its workspace to another process. */
export const holdLocalLock = Effect.fn("holdLocalLock")(function* (
  stateDir: string,
  filename = ".runner.lock",
) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(
          "flock",
          [
            "--exclusive",
            "--nonblock",
            "--conflict-exit-code",
            "73",
            "--no-fork",
            join(stateDir, filename),
            process.execPath,
            "-e",
            "process.stdout.write('locked\\n'); process.stdin.resume()",
          ],
          { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
        ),
      catch: (error) => lockError(errorCode(error)),
    }),
    (value) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (value.exitCode !== null || value.signalCode !== null) return resolve();
            value.once("close", () => resolve());
            value.kill("SIGKILL");
          }),
      ),
  );
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        child.once("error", (error) => reject(lockError(errorCode(error))));
        child.once("close", (code) => reject(lockError(code === 73 ? "ELOCKED" : String(code))));
        child.stdout.once("data", (data) => {
          if (data.toString() === "locked\n") resolve();
          else reject(lockError("invalid handshake"));
        });
      }),
    catch: (error) => (error instanceof LocalRunnerError ? error : lockError("unknown")),
  });
});

/** Local commands get a small environment, but still run with this user's filesystem permissions. */
class LocalExecutionEnv extends NodeExecutionEnv {
  readonly home: string;
  constructor(cwd: string, home: string) {
    super({ cwd });
    this.home = home;
  }
  override exec(...[command, options, context]: Parameters<NodeExecutionEnv["exec"]>) {
    return super.exec(
      command,
      {
        ...options,
        inheritEnv: false,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: this.home,
          LANG: "C.UTF-8",
          ...options?.env,
        },
      },
      context,
    );
  }
}

/** The caller's scope owns this host, SQLite and lock; reopening resumes nonterminal work in the same issue. */
export const openLocalIssue = Effect.fn("openLocalIssue")(function* (options: {
  readonly repo: Repo;
  readonly issue: number;
  readonly stateDir: string;
  readonly checks: ReadonlyArray<string>;
  readonly pi: Pick<SessionHostOptions, "models" | "model" | "thinkingLevel">;
  /** Watch discovery can reopen saved work without admitting an idle, now-ineligible issue. */
  readonly admit?: boolean;
  /** Explicitly retry only an existing failed session; never admit new work. */
  readonly retry?: boolean;
}) {
  yield* validateLocalIssue(options.issue, options.checks);
  const root = join(options.stateDir, "workspace");
  const home = join(options.stateDir, "shell-home");
  const createDirectories = Effect.tryPromise({
    try: () =>
      Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(root, { recursive: true, mode: 0o700 }),
      ]),
    catch: (error) => localIoError("Could not create the local session directory", error),
  });
  if (options.retry) {
    yield* Effect.tryPromise({
      try: () => stat(join(options.stateDir, "session.sqlite")),
      catch: () =>
        new LocalRunnerError({
          message: "Retry requires an existing saved session; no state was created",
        }),
    });
  } else yield* createDirectories;
  yield* holdLocalLock(options.stateDir);
  // Inspect under the same lock before opening a Harness, which would resume tasks and initialize state.
  const retryState = options.retry
    ? yield* readLocalSession(
        join(options.stateDir, "session.sqlite"),
        options.repo,
        options.issue,
      ).pipe(Effect.mapError((error) => new LocalRunnerError({ message: error.message })))
    : undefined;
  if (options.retry) {
    if (retryState?.status !== "failed")
      return yield* new LocalRunnerError({ message: "Only failed sessions can be retried" });
    yield* createDirectories;
  }
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(join(options.stateDir, "session.sqlite")),
      catch: (error) => localIoError("Could not open local session storage", error),
    }),
    (value) => Effect.promise(() => value.close(BACKGROUND_CONTEXT)),
  );
  const github = yield* GitHub;
  const services = Layer.mergeAll(
    LocalWorkspace.layer({
      root,
      checks: options.checks,
      store: makeDiskWorkspaceStore(join(options.stateDir, "blobs")),
      env: new LocalExecutionEnv(join(root, "work"), home),
    }).pipe(Layer.provide(Layer.succeed(GitHub, github))),
    Layer.succeed(GitHub, github),
    Layer.succeed(Projection, { project: Effect.fn("LocalProjection.project")(() => Effect.void) }),
  );
  const serviceContext = yield* Layer.build(services);
  const host = yield* openSessionHost({
    storage,
    session: {
      sessionId: `${options.repo.owner}/${options.repo.name}#${options.issue}`,
      repo: options.repo,
      issue: options.issue,
    },
    ...options.pi,
  }).pipe(Effect.provide(serviceContext));
  if (retryState != null) {
    const result = yield* host.deliver(
      Events.Retry.make({ expectedRevision: retryState.revision }),
      `local-retry:${retryState.revision}`,
    );
    if (result === "stale")
      return yield* new LocalRunnerError({
        message: "The saved session changed; inspect its status before retrying",
      });
  } else if (options.admit !== false && (yield* host.view()).state.status === "idle") {
    const context = yield* github.fetchIssueContext(options.repo, options.issue);
    yield* host.deliver(Events.IssueLabeled.make(context), `local-issue:${options.issue}`);
  }
  return host;
});
