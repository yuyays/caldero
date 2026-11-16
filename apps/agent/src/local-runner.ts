import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Events, type Repo } from "@puchero/domain";
import { Effect, Layer, Schema } from "effect";
import { makeDiskWorkspaceStore } from "./disk-workspace-store.ts";
import { LocalWorkspace } from "./local-workspace.ts";
import { GitHub, Projection } from "./ports.ts";
import { openSessionHost, type SessionHostOptions } from "./session-host.ts";

export class LocalRunnerError extends Schema.TaggedError<LocalRunnerError>()("LocalRunnerError", {
  message: Schema.String,
}) {}

export const validateLocalIssue = Effect.fn("validateLocalIssue")(
  (issue: number, checks: ReadonlyArray<string>): Effect.Effect<void, LocalRunnerError> =>
    !Number.isSafeInteger(issue) ||
    issue < 1 ||
    checks.length === 0 ||
    checks.some((check) => !check.trim())
      ? Effect.fail(
          new LocalRunnerError({
            message: "Provide --issue NUMBER and at least one nonempty --check COMMAND",
          }),
        )
      : Effect.void,
);

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
}) {
  yield* validateLocalIssue(options.issue, options.checks);
  const root = join(options.stateDir, "workspace");
  const home = join(options.stateDir, "shell-home");
  yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(root, { recursive: true, mode: 0o700 }),
      ]),
    catch: () => new LocalRunnerError({ message: "Could not create the local session directory" }),
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => lockfile.lock(options.stateDir, { retries: 0 }),
      catch: (error) =>
        new LocalRunnerError({
          message: `Could not lock the local session (${typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unknown"}); another runner may own it`,
        }),
    }),
    (release) => Effect.promise(() => release()),
  );
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(join(options.stateDir, "session.sqlite")),
      catch: () => new LocalRunnerError({ message: "Could not open local session storage" }),
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
  if ((yield* host.view()).state.status === "idle") {
    const context = yield* github.fetchIssueContext(options.repo, options.issue);
    yield* host.deliver(Events.IssueLabeled.make(context), `local-issue:${options.issue}`);
  }
  return host;
});
