import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
