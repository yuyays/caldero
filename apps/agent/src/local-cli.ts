import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Events, type PublicCheck, Repo } from "@caldero/domain";
import { Effect, Schema } from "effect";
import { GitHubApp } from "./github-app.ts";
import { openLocalPi } from "./local-pi.ts";
import { readLocalRepairContext } from "./local-repair-ci.ts";
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

const help = `Caldero with this machine's Pi login and saved model settings.

pnpm --filter @caldero/agent local --issue NUMBER --check 'COMMAND' [--check 'COMMAND']
pnpm retry --issue NUMBER --check COMMAND [--check COMMAND]
pnpm repair --issue NUMBER --check COMMAND [--check COMMAND]
pnpm --filter @caldero/agent local --watch --check 'COMMAND' [--check 'COMMAND']

--github-config PATH   GitHub App config (default ~/.config/caldero/github-app.json)
--pi-dir PATH          Pi profile directory (default Pi's configured agent directory)
--state-dir PATH       Durable state (default ~/.local/state/caldero/OWNER/REPO/ISSUE)
--retry                Explicitly retry an existing failed session (pnpm retry)
--repair               Repair one failed CI job on the saved open PR (pnpm repair)
--watch                Poll labeled issues, one at a time; resume admitted work on restart
--auto-repair          With --watch, attempt one repair per saved PR on failed Actions CI
--pr-check LABEL=CMD   Run a single-issue check and publish its label and command, excluding output
--label NAME           Watch label (default agent)
--poll-seconds N       Delay between watch scans (default 60)
--state-root PATH      Watch state root (default ~/.local/state/caldero/OWNER/REPO)
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
          "auto-repair": { type: "boolean" },
          retry: { type: "boolean" },
          repair: { type: "boolean" },
          label: { type: "string" },
          "poll-seconds": { type: "string" },
          "state-root": { type: "string" },
          check: { type: "string", multiple: true },
          "pr-check": { type: "string", multiple: true },
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
  if (values["auto-repair"] && !values.watch)
    return yield* new LocalRunnerError({ message: "--auto-repair requires --watch" });
  if (
    values.watch &&
    (values.issue !== undefined ||
      values["state-dir"] !== undefined ||
      values["check-connection"] ||
      values.retry ||
      values.repair)
  )
    return yield* new LocalRunnerError({
      message:
        "--watch cannot be combined with --issue, --state-dir, --retry, --repair or --check-connection",
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
  if (values.retry && values["check-connection"])
    return yield* new LocalRunnerError({
      message: "--retry cannot be combined with --check-connection",
    });
  if (values.repair && (values.retry || values["check-connection"]))
    return yield* new LocalRunnerError({
      message: "--repair cannot be combined with --retry or --check-connection",
    });
  const pollSeconds = Number(values["poll-seconds"] ?? 60);
  if (values.watch && (!Number.isFinite(pollSeconds) || pollSeconds < 1 || !label.trim()))
    return yield* new LocalRunnerError({
      message: "Use a nonempty --label and --poll-seconds of at least 1",
    });
  const publicChecks: PublicCheck[] = [];
  if (values["pr-check"] && (values.watch || values.repair || values["check-connection"]))
    return yield* new LocalRunnerError({
      message: "--pr-check requires a single-issue run that can open a new PR",
    });
  for (const check of values["pr-check"] ?? []) {
    const separator = check.indexOf("=");
    const checkLabel = check.slice(0, separator).trim();
    const shellCommand = check.slice(separator + 1).trim();
    if (
      separator < 1 ||
      !checkLabel ||
      !shellCommand ||
      checkLabel.length > 120 ||
      shellCommand.length > 1000 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(check)
    )
      return yield* new LocalRunnerError({
        message: "Use --pr-check LABEL=COMMAND with a single-line public label and command",
      });
    publicChecks.push({ label: checkLabel, command: shellCommand });
  }
  if (publicChecks.length > 8)
    return yield* new LocalRunnerError({ message: "Use at most eight --pr-check options" });
  const checks = values.check ?? [];
  const commands = [...checks, ...publicChecks.map((check) => check.command)];
  if (!values["check-connection"])
    yield* values.watch ? validateLocalChecks(commands) : validateLocalIssue(issue, commands);
  const pi = yield* openLocalPi({
    cwd: process.cwd(),
    ...(values["pi-dir"] ? { agentDir: resolve(values["pi-dir"]) } : {}),
  });
  yield* Effect.logInfo(
    `Pi: ${pi.model.provider}/${pi.model.modelId}, thinking ${pi.thinkingLevel}`,
  );
  if (values["check-connection"]) return yield* Effect.void;
  const configPath = resolve(
    values["github-config"] ?? join(homedir(), ".config/caldero/github-app.json"),
  );
  const configText = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: () =>
      new LocalRunnerError({
        message:
          "Could not read the GitHub App configuration. Use ~/.config/caldero/github-app.json or pass --github-config PATH.",
      }),
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
    author: { name: "caldero", email: "caldero@users.noreply.github.com" },
  });
  const localIssue = {
    repo: config.repo,
    checks,
    publicChecks,
    pi,
  };
  const loadRepair = Effect.fn("LocalCLI.loadRepair")(function* (number: number) {
    const target = yield* github.readRepairTarget(number);
    const context = yield* readLocalRepairContext(config.repo, target);
    return context === undefined ? undefined : { target, context };
  });
  if (values.watch) {
    const stateRoot = resolve(
      values["state-root"] ??
        join(homedir(), ".local/state/caldero", config.repo.owner, config.repo.name),
    );
    const watcher = yield* openLocalWatcher({
      repo: config.repo,
      stateRoot,
      pollSeconds,
      discover: github.listOpenLabeledIssues(label),
      runIssue: Effect.fn("LocalWatch.runIssue")(function* (number: number, admit: boolean) {
        const host = yield* openLocalIssue({
          ...localIssue,
          issue: number,
          stateDir: join(stateRoot, String(number)),
          admit,
        }).pipe(Effect.provideService(GitHub, github));
        yield* host.drain();
        const { state } = yield* host.view();
        yield* Effect.logInfo(
          JSON.stringify({ issue: number, status: state.status, pullRequest: state.pullRequest }),
        );
        return state.status;
      }, Effect.mapError(localWatchIssueError)),
      ...(values["auto-repair"]
        ? {
            repairIssue: Effect.fn("LocalWatch.repairIssue")(
              function* (number: number, admit: boolean, admissionOpen: Effect.Effect<boolean>) {
                const host = yield* openLocalIssue({
                  ...localIssue,
                  issue: number,
                  admit,
                  stateDir: join(stateRoot, String(number)),
                  repair: { automatic: true, load: loadRepair, admissionOpen },
                }).pipe(Effect.provideService(GitHub, github));
                yield* host.drain();
                const { state } = yield* host.view();
                yield* Effect.logInfo(`Issue #${number}: automatic repair ${state.status}`);
              },
              Effect.catchIf(
                (error) => error instanceof LocalRunnerError && error.reason === "ineligible",
                () => Effect.void,
              ),
              Effect.mapError(localWatchIssueError),
            ),
          }
        : {}),
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
      `Watching ${config.repo.owner}/${config.repo.name}, label ${label}, every ${pollSeconds}s; state ${stateRoot}${values["auto-repair"] ? "; automatic CI repair on" : ""}`,
    );
    return yield* watcher.run;
  }
  const stateDir = resolve(
    values["state-dir"] ??
      join(homedir(), ".local/state/caldero", config.repo.owner, config.repo.name, String(issue)),
  );
  const host = yield* openLocalIssue({
    ...localIssue,
    issue,
    stateDir,
    retry: values.retry ?? false,
    ...(values.repair ? { repair: { load: loadRepair } } : {}),
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
        const { state } = yield* host.view();
        const result = yield* host.deliver(
          Events.Cancel.make({ actor: "local-user" }),
          `local-stop:${state.runId}`,
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

// Node CLI entrypoint owns the single Effect runtime.
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
