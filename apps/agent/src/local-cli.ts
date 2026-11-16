import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Events, Repo } from "@puchero/domain";
import { Effect, Schema } from "effect";
import { GitHubApp } from "./github-app.ts";
import { openLocalPi } from "./local-pi.ts";
import { openLocalIssue, LocalRunnerError, validateLocalIssue } from "./local-runner.ts";
import { GitHub } from "./ports.ts";

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

--github-config PATH   GitHub App config (default ~/.config/puchero/github-app.json)
--pi-dir PATH          Pi profile directory (default Pi's configured agent directory)
--state-dir PATH       Durable state (default ~/.local/state/puchero/OWNER/REPO/ISSUE)
--check-connection     Verify Pi login and model without starting an issue
--help                Show this help

Local tools run as your user. Use this runner only with trusted repositories.
Ctrl-C requests Stop; publication already in progress may finish. A second Ctrl-C exits immediately.`;

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
  if (!values["check-connection"]) yield* validateLocalIssue(issue, values.check ?? []);
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
