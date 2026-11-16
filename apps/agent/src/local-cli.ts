import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Events, Repo } from "@puchero/domain";
import { Effect, Schema } from "effect";
import { GitHubApp } from "./github-app.ts";
import { openLocalPi } from "./local-pi.ts";
import {
  openLocalIssue,
  LocalRunnerError,
  validateLocalChecks,
  validateLocalIssue,
} from "./local-runner.ts";
import { GitHub } from "./ports.ts";
import { localWatchIssueError, openLocalWatcher } from "./local-watch.ts";

const decodeGitHub = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      appId: Schema.String,
      installationId: Schema.Int.check(Schema.isGreaterThan(0)),
      repo: Repo,
      privateKeyFile: Schema.String,
    }),
  ),
);

const help = `Puchero with this machine's Pi login and saved model settings.

pnpm --filter @puchero/agent local --issue NUMBER --check 'COMMAND' [--check 'COMMAND']
pnpm --filter @puchero/agent local --watch --check 'COMMAND' [--check 'COMMAND']

--github-config PATH   GitHub App config (default ~/.config/puchero/github-app.json)
--pi-dir PATH          Pi profile directory (default Pi's configured agent directory)
--state-dir PATH       Durable state (default ~/.local/state/puchero/OWNER/REPO/ISSUE)
--watch                Poll labeled issues, one at a time; resume admitted work on restart
--label NAME           Watch label (default agent)
--poll-seconds N       Delay between watch scans (default 60)
--state-root PATH      Watch state root (default ~/.local/state/puchero/OWNER/REPO)
--check-connection     Verify Pi login and model without starting an issue
--help                Show this help

Local tools run as your user. Use this runner only with trusted repositories.
Single issue: Ctrl-C requests Stop; publication already in progress may finish.
Watch: Ctrl-C stops polling and finishes the current issue. A second Ctrl-C exits immediately.`;

/** Wait for one process signal without leaving listeners outside the owning fiber. */
const interrupt = Effect.callback<void>((resume) => {
  const listener = () => resume(Effect.void);
  process.once("SIGINT", listener);
  process.once("SIGTERM", listener);
  return Effect.sync(() => {
    process.removeListener("SIGINT", listener);
    process.removeListener("SIGTERM", listener);
  });
});

const command = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          issue: { type: "string" },
          watch: { type: "boolean" },
          label: { type: "string" },
          "poll-seconds": { type: "string" },
          "state-root": { type: "string" },
          check: { type: "string", multiple: true },
          "github-config": { type: "string" },
          "pi-dir": { type: "string" },
          "state-dir": { type: "string" },
          "check-connection": { type: "boolean" },
          help: { type: "boolean" },
        },
      }),
    catch: () => new LocalRunnerError({ message: "Invalid local runner arguments; use --help" }),
  });
  if (values.help) return yield* Effect.sync(() => console.log(help));
  const issue = Number(values.issue);
  const label = values.label ?? "agent";
  if (
    values.watch &&
    (values.issue !== undefined || values["state-dir"] !== undefined || values["check-connection"])
  )
    return yield* new LocalRunnerError({
      message: "--watch cannot be combined with --issue, --state-dir or --check-connection",
    });
  if (
    !values.watch &&
    (values.label !== undefined ||
      values["poll-seconds"] !== undefined ||
      values["state-root"] !== undefined)
  )
    return yield* new LocalRunnerError({
      message: "--label, --poll-seconds and --state-root require --watch",
    });
  const pollSeconds = Number(values["poll-seconds"] ?? 60);
  if (values.watch && (!Number.isFinite(pollSeconds) || pollSeconds < 1 || !label.trim()))
    return yield* new LocalRunnerError({
      message: "Use a nonempty --label and --poll-seconds of at least 1",
    });
  if (!values["check-connection"])
    yield* values.watch
      ? validateLocalChecks(values.check ?? [])
      : validateLocalIssue(issue, values.check ?? []);
  const pi = yield* openLocalPi({
    cwd: process.cwd(),
    ...(values["pi-dir"] ? { agentDir: resolve(values["pi-dir"]) } : {}),
  });
  yield* Effect.logInfo(
    `Pi: ${pi.model.provider}/${pi.model.modelId}, thinking ${pi.thinkingLevel}`,
  );
  if (values["check-connection"]) return yield* Effect.void;
  const configPath = resolve(
    values["github-config"] ?? join(homedir(), ".config/puchero/github-app.json"),
  );
  const configText = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: () =>
      new LocalRunnerError({ message: "Could not read the GitHub App configuration file" }),
  });
  const config = yield* decodeGitHub(configText).pipe(
    Effect.mapError(() => new LocalRunnerError({ message: "Invalid GitHub App configuration" })),
  );
  const privateKey = yield* Effect.tryPromise({
    try: () => readFile(config.privateKeyFile, "utf8"),
    catch: () => new LocalRunnerError({ message: "Could not read the GitHub App private key" }),
  });
  const github = yield* GitHubApp.make({
    ...config,
    privateKey,
    author: { name: "puchero", email: "puchero@users.noreply.github.com" },
  });
  if (values.watch) {
    const stateRoot = resolve(
      values["state-root"] ??
        join(homedir(), ".local/state/puchero", config.repo.owner, config.repo.name),
    );
    const watcher = yield* openLocalWatcher({
      repo: config.repo,
      stateRoot,
      pollSeconds,
      discover: github.listOpenLabeledIssues(label),
      runIssue: Effect.fn("LocalWatch.runIssue")(function* (number: number, admit: boolean) {
        const host = yield* openLocalIssue({
          repo: config.repo,
          issue: number,
          stateDir: join(stateRoot, String(number)),
          checks: values.check ?? [],
          pi,
          admit,
        }).pipe(Effect.provideService(GitHub, github));
        yield* host.drain();
        const { state } = yield* host.view();
        yield* Effect.logInfo(
          JSON.stringify({ issue: number, status: state.status, pullRequest: state.pullRequest }),
        );
        return state.status;
      }, Effect.mapError(localWatchIssueError)),
    });
    yield* interrupt.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          yield* watcher.stop;
          yield* Effect.logInfo(
            "Stopping watch; finishing the current issue. Press Ctrl-C again to exit immediately.",
          );
          yield* interrupt;
          return yield* Effect.sync(() => process.exit(130));
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.logInfo(
      `Watching ${config.repo.owner}/${config.repo.name}, label ${label}, every ${pollSeconds}s; state ${stateRoot}`,
    );
    return yield* watcher.run;
  }
  const stateDir = resolve(
    values["state-dir"] ??
      join(homedir(), ".local/state/puchero", config.repo.owner, config.repo.name, String(issue)),
  );
  const host = yield* openLocalIssue({
    repo: config.repo,
    issue,
    stateDir,
    checks: values.check ?? [],
    pi,
  }).pipe(Effect.provideService(GitHub, github));
  yield* interrupt.pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const exit = () => process.exit(130);
            process.once("SIGINT", exit);
            return exit;
          }),
          (exit) => Effect.sync(() => process.removeListener("SIGINT", exit)),
        );
        const result = yield* host.deliver(
          Events.Cancel.make({ actor: "local-user" }),
          "local-stop",
        );
        yield* Effect.logInfo(
          result === "stale"
            ? "Publication is already in progress; waiting for its outcome"
            : "Stopping the local session",
        );
        if (result !== "stale") process.exitCode = 130;
        return yield* Effect.never;
      }),
    ),
    Effect.catch((error) => Effect.logError(`Stop request failed: ${error.message}`)),
    Effect.forkScoped,
  );
  yield* host.drain();
  const { state } = yield* host.view();
  yield* Effect.sync(() =>
    console.log(
      JSON.stringify({
        sessionId: state.sessionId,
        status: state.status,
        pullRequest: state.pullRequest,
        stateDir,
      }),
    ),
  );
  if (state.status === "failed")
    return yield* new LocalRunnerError({
      message: "The local session failed; its durable state has been retained",
    });
  return yield* Effect.void;
});

// oxlint-disable-next-line starter/runtime-boundary -- Node CLI entrypoint owns the single Effect runtime
await Effect.runPromise(
  command.pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
