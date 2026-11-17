import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Events } from "@puchero/domain";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { makeFakeGitHub } from "./fake-github.ts";
import { openLocalIssue } from "./local-runner.ts";
import { scriptedModels } from "./testing.ts";
import { localWatchIssueError } from "./local-watch.ts";

const repo = { owner: "acme", name: "app" };
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-local-run-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

describe("Local durable runner", () => {
  it.effect("rejects incompatible retry arguments before loading Pi or GitHub credentials", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      for (const [args, message] of [
        [["--retry", "--watch"], "--watch cannot"],
        [["--retry", "--check-connection"], "--retry cannot"],
        [["--retry", "--state-root", root], "require --watch"],
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
          openLocalIssue({ repo, issue: 7, stateDir, checks, pi, retry }).pipe(
            Effect.provide(github.layer),
          );
        const failed = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* open(["echo missing-fixture; false"]);
            yield* host.drain();
            return (yield* host.view()).state;
          }),
        );
        expect(failed.status).toBe("failed");
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
        if (file?.change !== "write") return expect.unreachable();
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
            const previous = process.env.PUCHERO_TEST_HOST_ONLY;
            process.env.PUCHERO_TEST_HOST_ONLY = "host-only-canary";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.PUCHERO_TEST_HOST_ONLY;
              else process.env.PUCHERO_TEST_HOST_ONLY = previous;
            }),
        );
        const stateDir = yield* directory;
        const github = makeFakeGitHub({ source: [] });
        const scripted = scriptedModels();
        const reasoning: Array<string | undefined> = [];
        const original = scripted.control.script;
        scripted.control.script = (context, options, ...rest) => {
          reasoning.push(options?.reasoning);
          return original(context, options, ...rest);
        };
        const open = () =>
          openLocalIssue({
            repo,
            issue: 7,
            stateDir,
            checks: ['test -f notes.txt && test -z "${PUCHERO_TEST_HOST_ONLY+x}"'],
            pi: { ...scripted, thinkingLevel: "medium" },
          }).pipe(Effect.provide(github.layer));
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
        expect(github.state.pullRequests).toHaveLength(1);
      }),
  );
  it.effect("Stop cancels the local run and terminates its active shell process", () =>
    Effect.gen(function* () {
      const stateDir = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const pi = scriptedModels();
      const started = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          watch(stateDir, { recursive: true }, (_event, name) => {
            if (name?.endsWith("started")) started.resolve();
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
      yield* Effect.promise(() => started.promise);
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
      const busy = yield* openLocalIssue(options).pipe(Effect.provide(github.layer), Effect.flip);
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
