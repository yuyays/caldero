import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Events, type RepairTarget, type Repo } from "@caldero/domain";
import { Effect, Layer, Schema } from "effect";
import { makeDiskWorkspaceStore } from "./disk-workspace-store.ts";
import { readLocalSession } from "./local-status.ts";
import { LocalWorkspace } from "./local-workspace.ts";
import { GitHub, type GitHubError, Projection } from "./ports.ts";
import { openSessionHost, type SessionHostOptions } from "./session-host.ts";

export class LocalRunnerError extends Schema.TaggedError<LocalRunnerError>()("LocalRunnerError", {
  message: Schema.String,
  reason: Schema.optionalKey(Schema.Literals(["locked", "configuration", "ineligible"])),
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

const pathExists = Effect.fn("LocalRunner.pathExists")((path: string) =>
  Effect.tryPromise({
    try: () =>
      stat(path).then(
        () => true,
        (error: unknown) => {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        },
      ),
    catch: (error) => localIoError("Could not inspect local session storage", error),
  }),
);

/** A second state root must never silently admit an issue with known legacy state. */
const refuseLegacyIssue = Effect.fn("refuseLegacyIssue")(function* (repo: Repo, issue: number) {
  for (const name of ["puchero", "metate"]) {
    const path = join(
      homedir(),
      ".local/state",
      name,
      repo.owner,
      repo.name,
      String(issue),
      "session.sqlite",
    );
    if (yield* pathExists(path))
      return yield* new LocalRunnerError({
        reason: "configuration",
        message: `Issue #${issue} already has pre-rename ${name} state. Use a fresh issue with Caldero.`,
      });
  }
  return yield* Effect.void;
});

/** Inspect under the runner lock before opening a host that can resume durable work. */
const prepareSavedIssue = Effect.fn("prepareSavedIssue")(function* (options: {
  readonly stateDir: string;
  readonly repo: Repo;
  readonly issue: number;
}) {
  const path = join(options.stateDir, "session.sqlite");
  if (!(yield* pathExists(path)))
    return yield* new LocalRunnerError({
      message: "This operation requires an existing saved session; no state was created",
    });
  yield* holdLocalLock(options.stateDir);
  return yield* readLocalSession(path, options.repo, options.issue).pipe(
    Effect.mapError((error) => new LocalRunnerError({ message: error.message })),
  );
});

/** The caller's scope owns this host, SQLite and lock; reopening resumes nonterminal work in the same issue. */
type LoadRepair = (
  number: number,
) => Effect.Effect<
  { readonly target: RepairTarget; readonly context: string } | undefined,
  GitHubError
>;

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
  readonly repair?: { readonly automatic?: boolean; readonly load: LoadRepair };
}) {
  yield* validateLocalIssue(options.issue, options.checks);
  yield* refuseLegacyIssue(options.repo, options.issue);
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
  const saved = options.retry || options.repair ? yield* prepareSavedIssue(options) : undefined;
  if (options.retry && saved?.status !== "failed")
    return yield* new LocalRunnerError({
      message: `Only failed sessions can be retried. Resume active work with pnpm --filter @caldero/agent local --issue ${options.issue}, using the same --state-dir and --check options.`,
    });
  if (options.retry && saved?.repair && !saved.candidate)
    return yield* new LocalRunnerError({
      message:
        "The repair stopped before a checked patch was saved. Use the PR to continue manually.",
    });
  let repair;
  if (options.repair) {
    const number = saved?.pullRequest?.number;
    const attemptedRun = number === undefined ? undefined : saved?.automaticRepairRuns?.[number];
    const resume =
      options.repair.automatic &&
      saved != null &&
      attemptedRun === saved.runId &&
      ["running", "validating", "publishing"].includes(saved.status);
    if (!resume) {
      if (
        saved?.status !== "published" ||
        number === undefined ||
        (options.repair.automatic && (options.admit === false || attemptedRun !== undefined))
      )
        return yield* new LocalRunnerError({
          message:
            "Repair requires an eligible published Caldero session with a saved pull request",
          ...(options.repair.automatic ? { reason: "ineligible" as const } : {}),
        });
      repair = yield* options.repair.load(number);
      if (repair === undefined)
        return yield* new LocalRunnerError({
          message: "No current failed GitHub Actions job with a readable log was found",
          ...(options.repair.automatic ? { reason: "ineligible" as const } : {}),
        });
    }
  }
  yield* createDirectories;
  const database = join(options.stateDir, "session.sqlite");
  if (!options.retry && !options.repair) {
    yield* holdLocalLock(options.stateDir);
    if (yield* pathExists(database))
      yield* readLocalSession(database, options.repo, options.issue).pipe(
        Effect.mapError(
          (error) => new LocalRunnerError({ reason: "configuration", message: error.message }),
        ),
      );
  }
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(database),
      catch: (error) => localIoError("Could not open local session storage", error),
    }),
    (value) =>
      // Harness.close normally closes this storage first; a repeated close is memoized. Log a failure
      // instead of turning it into a defect that hides the operation's own error.
      Effect.tryPromise({
        try: () => value.close(BACKGROUND_CONTEXT),
        catch: (error) => localIoError("Could not close local session storage", error),
      }).pipe(Effect.catch((error) => Effect.logWarning(error.message))),
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
  if (repair && saved) {
    const result = yield* host.deliver(
      Events.Repair.make({
        ...repair,
        expectedRevision: saved.revision,
        ...(options.repair?.automatic ? { automatic: true } : {}),
      }),
      `local-repair:${saved.revision}`,
    );
    if (result === "stale")
      return yield* new LocalRunnerError({
        message: "The saved PR session changed before repair could start",
      });
  } else if (options.retry && saved != null) {
    const result = yield* host.deliver(
      Events.Retry.make({ expectedRevision: saved.revision }),
      `local-retry:${saved.revision}`,
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
