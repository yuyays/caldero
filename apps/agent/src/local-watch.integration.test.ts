import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeFakeGitHub } from "./fake-github.ts";
import { openLocalIssue } from "./local-runner.ts";
import { LocalWatchIssueError, localWatchIssueError, openLocalWatcher } from "./local-watch.ts";
import { scriptedModels } from "./testing.ts";
import { GitHubError } from "./ports.ts";

const repo = { owner: "acme", name: "app" };
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "caldero-watch-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

describe("Local issue watcher", () => {
  it.effect("continues issue discovery between automatic CI repair scans", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const firstScan = yield* Deferred.make<void>();
      let discoverCalls = 0;
      const repairs: number[] = [];
      let stop = Effect.void;
      const watcher = yield* openLocalWatcher({
        repo,
        stateRoot,
        pollSeconds: 60,
        discover: Effect.sync(() => {
          discoverCalls++;
          return [7];
        }),
        runIssue: () => Effect.succeed("published" as const),
        repairIssue: Effect.fn("fixture.repairScan")(function* (issue: number) {
          repairs.push(issue);
          if (repairs.length === 1) yield* Deferred.succeed(firstScan, undefined);
          else yield* stop;
        }),
      });
      stop = watcher.stop;
      const fiber = yield* watcher.run.pipe(Effect.forkChild);
      yield* Deferred.await(firstScan);
      yield* TestClock.adjust("299 seconds");
      expect(discoverCalls).toBeGreaterThan(1);
      expect(repairs).toEqual([7]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(repairs).toEqual([7, 7]);
    }),
  );

  it.effect("keeps active statuses pending until a terminal result is reported", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const runs: number[] = [];
      let stop = Effect.void;
      for (const status of ["running", "validating", "publishing", "published"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* openLocalWatcher({
              repo,
              stateRoot,
              pollSeconds: 60,
              discover: Effect.succeed([7]),
              runIssue: Effect.fn("reportActiveStatus")(function* (issue: number) {
                runs.push(issue);
                yield* stop;
                return status;
              }),
            });
            stop = watcher.stop;
            yield* watcher.run;
          }),
        );
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([7, 8]),
            runIssue: Effect.fn("reportNextIssue")(function* (issue: number) {
              runs.push(issue);
              yield* stop;
              return "published" as const;
            }),
          });
          stop = watcher.stop;
          yield* watcher.run;
        }),
      );
      expect(runs).toEqual([7, 7, 7, 7, 8]);
    }),
  );

  it.effect("retains idle admissions through a failed scan and retries after recovery", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      let stop = Effect.void;
      const admits: boolean[] = [];
      let attempt = 0;
      for (const discover of [
        Effect.succeed([7]),
        Effect.fail(new GitHubError({ message: "offline" })),
        Effect.succeed([7]),
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* openLocalWatcher({
              repo,
              stateRoot,
              pollSeconds: 60,
              discover,
              runIssue: Effect.fn("retryIdleIssue")(function* (_issue: number, admit: boolean) {
                admits.push(admit);
                attempt++;
                yield* stop;
                if (attempt === 1)
                  return yield* new LocalWatchIssueError({
                    message: "temporary open failure",
                    retryable: true,
                  });
                return attempt === 2 ? ("idle" as const) : ("published" as const);
              }),
            });
            stop = watcher.stop;
            yield* watcher.run;
          }),
        );
      }
      expect(admits).toEqual([true, false, true]);
    }),
  );

  it.effect("refuses a second watcher and preserves unreadable scheduling receipts", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const options = {
        repo,
        stateRoot,
        pollSeconds: 60,
        discover: Effect.succeed([]),
        runIssue: () => Effect.succeed("published" as const),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* openLocalWatcher(options);
          expect(yield* openLocalWatcher(options).pipe(Effect.flip)).toMatchObject({
            _tag: "LocalRunnerError",
            reason: "locked",
          });
        }),
      );
      yield* Effect.promise(() => writeFile(join(stateRoot, "watch.json"), "unreadable"));
      expect(yield* Effect.scoped(openLocalWatcher(options)).pipe(Effect.flip)).toMatchObject({
        _tag: "LocalWatchError",
      });
      expect(yield* Effect.promise(() => readFile(join(stateRoot, "watch.json"), "utf8"))).toBe(
        "unreadable",
      );
    }),
  );

  it.effect("recovers a lost completion receipt even after the issue loses its label", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const admissions: boolean[] = [];
      let stop = Effect.void;
      let loseCompletion = true;
      const runIssue = Effect.fn("recoverIssue")(
        function* (issue: number, admit: boolean) {
          admissions.push(admit);
          const host = yield* openLocalIssue({
            repo,
            issue,
            stateDir: join(stateRoot, String(issue)),
            checks: ["test -f notes.txt"],
            pi: scriptedModels(),
            admit,
          }).pipe(Effect.provide(github.layer));
          yield* host.drain();
          yield* stop;
          if (loseCompletion)
            return yield* new LocalWatchIssueError({ message: "lost reply", retryable: true });
          return (yield* host.view()).state.status;
        },
        Effect.mapError((error) =>
          error instanceof LocalWatchIssueError ? error : localWatchIssueError(error),
        ),
      );
      for (const eligible of [[7], []]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* openLocalWatcher({
              repo,
              stateRoot,
              pollSeconds: 60,
              discover: Effect.succeed(eligible),
              runIssue,
            });
            stop = watcher.stop;
            yield* watcher.run;
          }),
        );
        loseCompletion = false;
      }
      expect(admissions).toEqual([true, false]);
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("does not admit a queued issue that closes before its first successful attempt", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      let stop = Effect.void;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([7]),
            runIssue: () =>
              stop.pipe(
                Effect.andThen(
                  Effect.fail(new LocalWatchIssueError({ message: "offline", retryable: true })),
                ),
              ),
          });
          stop = watcher.stop;
          yield* watcher.run;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([]),
            runIssue: Effect.fn("skipClosedIssue")(function* (issue: number, admit: boolean) {
              expect(admit).toBe(false);
              const host = yield* openLocalIssue({
                repo,
                issue,
                stateDir: join(stateRoot, String(issue)),
                checks: ["true"],
                pi: scriptedModels(),
                admit,
              }).pipe(Effect.provide(github.layer));
              expect((yield* host.view()).state.status).toBe("idle");
              yield* stop;
              return "idle" as const;
            }, Effect.mapError(localWatchIssueError)),
          });
          stop = watcher.stop;
          yield* watcher.run;
        }),
      );
      expect(github.state.pullRequests).toHaveLength(0);
    }),
  );

  it.effect("Stop finishes the active issue and leaves the next admission for restart", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const runs: number[] = [];
      const watcher = yield* openLocalWatcher({
        repo,
        stateRoot,
        pollSeconds: 60,
        discover: Effect.succeed([7, 8]),
        runIssue: Effect.fn("blockingIssue")(function* (issue: number) {
          runs.push(issue);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
          return "published" as const;
        }),
      });
      const fiber = yield* watcher.run.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* watcher.stop;
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(fiber);
      expect(runs).toEqual([7]);
    }),
  );

  it.effect("runs issues serially and retains terminal receipts across restart", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      const runs: number[] = [];
      let stop = Effect.void;
      const runIssue = (issue: number, admit: boolean) =>
        Effect.gen(function* () {
          runs.push(issue);
          const host = yield* openLocalIssue({
            repo,
            issue,
            stateDir: join(stateRoot, String(issue)),
            checks: ["test -f notes.txt"],
            pi: scriptedModels(),
            admit,
          }).pipe(Effect.provide(github.layer));
          yield* host.drain();
          yield* stop;
          return (yield* host.view()).state.status;
        }).pipe(Effect.mapError(localWatchIssueError));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([7, 7]),
            runIssue,
          });
          stop = watcher.stop;
          yield* watcher.run;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([7, 8]),
            runIssue,
          });
          stop = watcher.stop;
          yield* watcher.run;
        }),
      );
      expect(runs).toEqual([7, 8]);
      expect(github.state.pullRequests).toHaveLength(2);
    }),
  );
});
