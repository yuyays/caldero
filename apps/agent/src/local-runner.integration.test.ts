import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { Events } from "@caldero/domain";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { makeFakeGitHub } from "./fake-github.ts";
import { openLocalIssue } from "./local-runner.ts";
import { scriptedModels } from "./testing.ts";
import { localWatchIssueError, openLocalWatcher } from "./local-watch.ts";
import { GitHub } from "./ports.ts";

const repo = { owner: "acme", name: "app" };
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "caldero-local-run-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

describe("Local durable runner", () => {
  it.effect("refuses a copied pre-rename database before admitting work", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const open = () =>
        openLocalIssue({
          stateDir,
          repo,
          issue: 7,
          pi: scriptedModels(),
          checks: ["test -f notes.txt"],
        }).pipe(Effect.provide(github.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* open();
          yield* host.drain();
        }),
      );
      const path = join(stateDir, "session.sqlite");
      // Model a copy from the old brand namespace without changing the saved payload.
      yield* Effect.acquireUseRelease(
        Effect.promise(() => openNodeSqliteDatabase(path)),
        (db) =>
          Effect.promise(() =>
            db.run(
              "UPDATE documents SET kind = ? WHERE kind = ?",
              JSON.stringify("puchero.session"),
              JSON.stringify("caldero.session"),
            ),
          ),
        (db) => Effect.promise(() => db.close()),
      );
      const failure = yield* Effect.scoped(open()).pipe(Effect.flip);
      expect(failure.message).toContain("pre-rename");
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("repairs from the saved PR head without restoring edits from the old base", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const fake = makeFakeGitHub({ source: [] });
      const github = yield* GitHub.pipe(Effect.provide(fake.layer));
      const pi = scriptedModels();
      let first = true;
      pi.control.script = () => {
        if (!first) return fauxAssistantMessage("Done.");
        first = false;
        return fauxAssistantMessage(
          fauxToolCall("write", { path: "old-only.txt", content: "original" }),
          { stopReason: "toolUse" },
        );
      };
      const options = { stateDir, repo, issue: 7, pi };
      const published = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* openLocalIssue({ ...options, checks: ["test -f old-only.txt"] }).pipe(
            Effect.provide(fake.layer),
          );
          yield* host.drain();
          return (yield* host.view()).state;
        }),
      );
      expect(published.status).toBe("published");
      const fixed = scriptedModels();
      const repair = Effect.fn("fixture.repair")((number: number) =>
        Effect.succeed({
          target: { number, headRef: "caldero/7-v1", headSha: "current-head", baseRef: "main" },
          context: "Fix the red job",
        }),
      );
      const remote = GitHub.of({
        ...github,
        fetchSource: (_repo, sha) =>
          Effect.succeed(
            sha === "current-head"
              ? [{ path: "pr-head.txt", content: Buffer.from("from PR"), executable: false }]
              : [],
          ),
        publish: (_issue, binding, patch) =>
          Effect.sync(() => {
            expect(binding.repair).toMatchObject({ number: 100, headSha: "current-head" });
            expect(patch.files.map((file) => file.path)).toEqual(["notes.txt"]);
            return { number: 100, url: "https://github.test/pull/100" };
          }),
      });
      const repaired = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* openLocalIssue({
            ...options,
            pi: fixed,
            repair: { load: repair },
            checks: [
              "test -f pr-head.txt && test ! -e old-only.txt && grep -q 'Fix the red job' notes.txt",
            ],
          }).pipe(Effect.provideService(GitHub, remote));
          yield* host.drain();
          return (yield* host.view()).state;
        }),
      );
      expect(repaired).toMatchObject({
        status: "published",
        version: 2,
        pullRequest: published.pullRequest,
      });
      expect(fake.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("watch resumes an admitted automatic repair and never repairs the same PR twice", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const fake = makeFakeGitHub({ source: [] });
      const github = yield* GitHub.pipe(Effect.provide(fake.layer));
      const options = {
        stateDir: join(stateRoot, "7"),
        repo,
        issue: 7,
        checks: ["test -f notes.txt"],
      };
      let probes = 0;
      const commits: number[] = [];
      const remote = GitHub.of({
        ...github,
        publish: (issue, binding, patch, journal) => {
          const target = binding.repair;
          return target
            ? Effect.sync(() => {
                commits.push(target.number);
                return { number: 100, url: "https://github.test/pull/100" };
              })
            : github.publish(issue, binding, patch, journal);
        },
      });
      // The model blocks until scope teardown, simulating an exit after durable admission.
      const paused = scriptedModels();
      const started = Promise.withResolvers<void>();
      paused.control.script = (_transcript, streamOptions) => {
        started.resolve();
        return new Promise((resolve) => {
          const finish = () => resolve(fauxAssistantMessage("Interrupted."));
          if (streamOptions?.signal?.aborted) finish();
          else streamOptions?.signal?.addEventListener("abort", finish, { once: true });
        });
      };
      const watchPhase = (
        phase: "initial" | "unlabeled" | "green" | "stopping" | "interrupt" | "resume" | "spent",
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            let stop = Effect.void;
            const watcher = yield* openLocalWatcher({
              repo,
              stateRoot,
              pollSeconds: 60,
              discover: Effect.succeed(phase === "unlabeled" || phase === "resume" ? [] : [7]),
              runIssue: Effect.fn("fixture.run")(function* (issue: number, admit: boolean) {
                const host = yield* openLocalIssue({
                  ...options,
                  issue,
                  admit,
                  pi: scriptedModels(),
                }).pipe(
                  Effect.provideService(GitHub, remote),
                  Effect.mapError(localWatchIssueError),
                );
                yield* host.drain().pipe(Effect.mapError(localWatchIssueError));
                yield* stop;
                return (yield* host.view().pipe(Effect.mapError(localWatchIssueError))).state
                  .status;
              }),
              ...(phase === "initial"
                ? {}
                : {
                    repairIssue: Effect.fn("fixture.autoRepair")(
                      function* (
                        issue: number,
                        admit: boolean,
                        admissionOpen: Effect.Effect<boolean>,
                      ) {
                        yield* openLocalIssue({
                          ...options,
                          issue,
                          admit,
                          pi: phase === "interrupt" ? paused : scriptedModels(),
                          repair: {
                            automatic: true,
                            admissionOpen,
                            load: (number) =>
                              Effect.gen(function* () {
                                probes++;
                                if (phase === "green") return undefined;
                                if (phase === "stopping") yield* stop;
                                return {
                                  target: {
                                    number,
                                    headRef: "caldero/7-v1",
                                    headSha: phase === "spent" ? "new-red-head" : "red-head",
                                    baseRef: "main",
                                  },
                                  context: "Fix the red job",
                                };
                              }),
                          },
                        }).pipe(
                          Effect.provideService(GitHub, remote),
                          Effect.flatMap((host) =>
                            phase === "interrupt"
                              ? Effect.promise(() => started.promise)
                              : host.drain(),
                          ),
                          Effect.mapError(localWatchIssueError),
                        );
                      },
                      (repair) => repair.pipe(Effect.ensuring(Effect.suspend(() => stop))),
                    ),
                  }),
            });
            stop = watcher.stop;
            yield* watcher.run;
          }),
        );
      yield* watchPhase("initial");
      yield* watchPhase("unlabeled");
      expect(probes).toBe(0);
      yield* watchPhase("green");
      expect(probes).toBe(1);
      yield* watchPhase("stopping");
      expect(commits).toEqual([]);
      yield* watchPhase("interrupt");
      expect(commits).toEqual([]);
      yield* watchPhase("resume");
      yield* watchPhase("spent");
      expect(probes).toBe(3);
      expect(commits).toEqual([100]);
      expect(fake.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("rejects invalid local arguments before loading Pi or GitHub credentials", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      for (const [args, message] of [
        [["--retry", "--watch"], "--watch cannot"],
        [["--retry", "--check-connection"], "--retry cannot"],
        [["--retry", "--state-root", root], "require --watch"],
        [["--auto-repair", "--issue", "7"], "--auto-repair requires --watch"],
        [["--issue", "7", "--pr-check", "Label only"], "Use --pr-check LABEL=COMMAND"],
      ] as const) {
        const result = yield* Effect.tryPromise({
          try: () =>
            promisify(execFile)(
              process.execPath,
              [join(import.meta.dirname, "local-cli.ts"), ...args],
              { env: { HOME: root, PATH: "/usr/bin:/bin" } },
            ),
          catch: (error) => ({
            code: error instanceof Error && "code" in error ? error.code : null,
            stderr: error instanceof Error && "stderr" in error ? error.stderr : null,
          }),
        }).pipe(Effect.flip);
        expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
      }
    }),
  );

  it.effect(
    "reconciles an exhausted lost publish response without editing or opening another PR",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* directory;
        const github = makeFakeGitHub({
          source: [],
          dropResponses: { kind: "ambiguous", times: 1 },
          failReconcile: { times: 2 },
        });
        const pi = scriptedModels();
        const open = (retry = false) =>
          openLocalIssue({
            repo,
            issue: 7,
            stateDir,
            checks: ["test -f notes.txt"],
            pi,
            retry,
          }).pipe(Effect.provide(github.layer));
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open();
            yield* host.drain();
            return (yield* host.view()).state;
          }),
        );
        expect(first).toMatchObject({ status: "failed", version: 1, runId: 1 });
        expect(github.state.pullRequests).toHaveLength(1);
        pi.control.script = () => {
          throw new Error("Publication retry must not call the model");
        };
        const retry = Events.Retry.make({ expectedRevision: first.revision });
        const recovered = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open(true);
            yield* host.drain();
            // Replaying delivery after the work completes returns its first result without restarting it.
            expect(yield* host.deliver(retry, `local-retry:${first.revision}`)).toBe("applied");
            yield* host.drain();
            return (yield* host.view()).state;
          }),
        );
        expect(recovered).toMatchObject({
          status: "published",
          version: 1,
          runId: 1,
          pullRequest: { number: 100 },
        });
        expect(recovered.candidate?.binding).toEqual(first.candidate?.binding);
        expect(github.state.pullRequests).toHaveLength(1);
      }),
  );

  it.effect(
    "refuses uninitialized or unreadable retry storage without changing it or running the model",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* directory;
        const path = join(stateDir, "session.sqlite");
        const storage = yield* Effect.promise(() => openNodeSqliteStorage(path));
        yield* Effect.promise(() => storage.close(BACKGROUND_CONTEXT));
        const github = makeFakeGitHub({ source: [] });
        const pi = scriptedModels();
        pi.control.script = () => {
          throw new Error("Refused retry must not run the model");
        };
        const retry = () =>
          Effect.scoped(
            openLocalIssue({ repo, issue: 7, stateDir, checks: ["true"], pi, retry: true }),
          ).pipe(Effect.provide(github.layer), Effect.flip);
        const before = yield* Effect.promise(() => readFile(path));
        expect((yield* retry()).message).toContain("Only failed");
        expect(yield* Effect.promise(() => readFile(path))).toEqual(before);
        yield* Effect.promise(() => writeFile(path, "not a SQLite database"));
        expect((yield* retry()).message).toContain("unreadable");
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe("not a SQLite database");
        expect(github.state.pullRequests).toEqual([]);
        expect(yield* Effect.promise(() => readdir(stateDir))).not.toContain("workspace");
      }),
  );

  it.effect("refuses retry of a missing session without creating its directory", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const stateDir = join(root, "missing");
      const github = makeFakeGitHub({ source: [] });
      const result = yield* Effect.scoped(
        openLocalIssue({
          repo,
          issue: 7,
          stateDir,
          checks: ["true"],
          pi: scriptedModels(),
          retry: true,
        }),
      ).pipe(Effect.provide(github.layer), Effect.flip);
      expect(result.message).toContain("existing saved session");
      expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
      expect(github.state.pullRequests).toEqual([]);
    }),
  );

  it.effect(
    "retries failed checks in the saved workspace and keeps failure context after reopen",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* directory;
        const github = makeFakeGitHub({ source: [] });
        const pi = scriptedModels();
        const open = (checks: ReadonlyArray<string>, retry = false) =>
          openLocalIssue({
            repo,
            issue: 7,
            stateDir,
            checks,
            pi,
            retry,
            publicChecks: retry
              ? []
              : [{ label: "Fixture exists", command: "echo missing-fixture; false" }],
          }).pipe(Effect.provide(github.layer));
        const failed = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open([]);
            yield* host.drain();
            return (yield* host.view()).state;
          }),
        );
        expect(failed.status).toBe("failed");
        expect(github.state.pullRequests).toHaveLength(0);
        const recovered = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open(["test -f notes.txt"], true);
            yield* host.drain();
            return yield* host.view();
          }),
        );
        expect(recovered.state).toMatchObject({
          status: "published",
          runId: 4,
          version: 1,
          failure: null,
        });
        const file = recovered.patch?.files[0];
        if (file?.change !== "write") expect.unreachable();
        const text = Buffer.from(file.content, "base64").toString("utf8");
        expect(text).toContain("Previous failure:");
        expect(text).toContain("missing-fixture");
        expect(github.state.pullRequests).toHaveLength(1);
        const published = yield* Effect.scoped(open(["true"], true)).pipe(Effect.flip);
        expect(published.message).toContain("Only failed");
        expect(github.state.pullRequests).toHaveLength(1);
      }),
  );

  it.effect("reports an invalid session directory as a permanent watch configuration failure", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const stateDir = join(root, "not-a-directory");
      yield* Effect.promise(() => writeFile(stateDir, "occupied"));
      const github = makeFakeGitHub({ source: [] });
      const error = yield* openLocalIssue({
        repo,
        issue: 7,
        stateDir,
        checks: ["true"],
        pi: scriptedModels(),
      }).pipe(Effect.provide(github.layer), Effect.mapError(localWatchIssueError), Effect.flip);
      expect(error.retryable).toBe(false);
      expect(github.state.pullRequests).toHaveLength(0);
    }),
  );
  it.effect(
    "persists the checked patch and resumes the published issue without creating another PR",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.CALDERO_TEST_HOST_ONLY;
            process.env.CALDERO_TEST_HOST_ONLY = "host-only-canary";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.CALDERO_TEST_HOST_ONLY;
              else process.env.CALDERO_TEST_HOST_ONLY = previous;
            }),
        );
        const stateDir = yield* directory;
        const github = makeFakeGitHub({ source: [] });
        const remote = yield* GitHub.pipe(Effect.provide(github.layer));
        const scripted = scriptedModels();
        const reasoning: Array<string | undefined> = [];
        const original = scripted.control.script;
        scripted.control.script = (context, options, ...rest) => {
          reasoning.push(options?.reasoning);
          return original(context, options, ...rest);
        };
        const publishedChecks: unknown[] = [];
        const open = () =>
          openLocalIssue({
            repo,
            issue: 7,
            stateDir,
            checks: ['test -f notes.txt && test -z "${CALDERO_TEST_HOST_ONLY+x}"'],
            publicChecks: [
              { label: "The generated notes are nonempty", command: "test -s notes.txt" },
            ],
            pi: { ...scripted, thinkingLevel: "medium" },
          }).pipe(
            Effect.provideService(
              GitHub,
              GitHub.of({
                ...remote,
                publish: (issue, binding, patch, journal, checks) => {
                  publishedChecks.push(checks);
                  return remote.publish(issue, binding, patch, journal, checks);
                },
              }),
            ),
          );
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open();
            yield* host.drain();
            return yield* host.view();
          }),
        );
        expect(first.state.failure).toBeNull();
        expect(first.state).toMatchObject({ status: "published", decidedBy: null });
        expect(first.patch?.files[0]?.path).toBe("notes.txt");
        expect(reasoning).toContain("medium");
        const recovered = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open();
            yield* host.drain();
            return yield* host.view();
          }),
        );
        expect(recovered.state.pullRequest).toEqual(first.state.pullRequest);
        expect(recovered.patch).toEqual(first.patch);
        expect(recovered.patchUnavailable).not.toBe(true);
        expect(recovered.state.candidate?.evidence).toContain("test -s notes.txt");
        expect(publishedChecks).toEqual([
          [{ label: "The generated notes are nonempty", command: "test -s notes.txt" }],
        ]);
        expect(github.state.pullRequests).toHaveLength(1);
      }),
  );
  it.effect("Stop cancels the local run and terminates its active shell process", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const pi = scriptedModels();
      const started = yield* Deferred.make<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          watch(stateDir, { recursive: true }, (_event, name) => {
            if (name?.endsWith("started")) Deferred.doneUnsafe(started, Effect.void);
          }),
        ),
        (watcher) => Effect.sync(() => watcher.close()),
      );
      pi.control.script = () =>
        fauxAssistantMessage(
          fauxToolCall("bash", {
            command: 'echo $$ > "$HOME/starting"; mv "$HOME/starting" "$HOME/started"; sleep 600',
          }),
          { stopReason: "toolUse" },
        );
      const host = yield* openLocalIssue({ repo, issue: 7, stateDir, checks: ["true"], pi }).pipe(
        Effect.provide(github.layer),
      );
      yield* Deferred.await(started);
      const pid = Number(
        yield* Effect.promise(() => readFile(join(stateDir, "shell-home/started"), "utf8")),
      );
      expect(yield* host.deliver(Events.Cancel.make({ actor: "local-user" }), "stop")).toBe(
        "applied",
      );
      yield* host.drain();
      expect((yield* host.view()).state).toMatchObject({
        status: "cancelled",
        decidedBy: "local-user",
      });
      expect(github.state.pullRequests).toHaveLength(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  );
  it.effect("does not publish when local validation fails", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const host = yield* openLocalIssue({
        repo,
        issue: 7,
        stateDir,
        checks: ["false"],
        pi: scriptedModels(),
      }).pipe(Effect.provide(github.layer));
      yield* host.drain();
      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "failed", attempts: 3 });
      expect(state.failure).toContain("(exit 1)");
      expect(github.state.pullRequests).toHaveLength(0);
    }),
  );
  it.effect("refuses a second runner while the same session directory is owned", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const options = {
        repo,
        issue: 7,
        stateDir,
        checks: ["test -f notes.txt"],
        pi: scriptedModels(),
      };
      const first = yield* openLocalIssue(options).pipe(Effect.provide(github.layer));
      const busy = yield* openLocalIssue({ ...options, retry: true }).pipe(
        Effect.provide(github.layer),
        Effect.flip,
      );
      expect(busy).toMatchObject({
        _tag: "LocalRunnerError",
        message: expect.stringContaining("ELOCKED"),
      });
      expect(localWatchIssueError(busy).retryable).toBe(true);
      yield* first.drain();
      expect((yield* first.view()).state.status).toBe("published");
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );
});
