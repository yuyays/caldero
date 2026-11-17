import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeFakeGitHub } from "./fake-github.ts";
import { openLocalIssue } from "./local-runner.ts";
import { collectLocalStatus } from "./local-status.ts";
import { scriptedModels } from "./testing.ts";
import { openLocalWatcher } from "./local-watch.ts";
import { LocalStatus } from "@puchero/contracts/local-status";

const repo = { owner: "acme", name: "app" };
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-status-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

describe("Read-only local status", () => {
  it.effect("shows a failed validation and its saved attempt count without retrying it", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const github = makeFakeGitHub({ source: [] });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* openLocalIssue({
            repo,
            issue: 7,
            stateDir: join(stateRoot, "7"),
            checks: ["printf 'check\\rspoof\\007'; false"],
            pi: scriptedModels(),
          }).pipe(Effect.provide(github.layer));
          yield* host.drain();
        }),
      );
      const status = yield* collectLocalStatus({ repo, stateRoot, issue: 7 });
      expect(status.sessions[0]?.state).toMatchObject({ status: "failed", attempts: 3 });
      expect(status.sessions[0]?.state?.failure).toContain("exit 1");
      expect(github.state.pullRequests).toHaveLength(0);
      const text = yield* Effect.promise(() =>
        promisify(execFile)(
          process.execPath,
          [
            join(import.meta.dirname, "local-status-cli.ts"),
            "--repo",
            "acme/app",
            "--state-root",
            stateRoot,
            "--issue",
            "7",
          ],
          { env: { PATH: "/usr/bin:/bin", HOME: stateRoot }, encoding: "utf8" },
        ),
      );
      expect(text.stdout.includes("\r")).toBe(false);
      expect(text.stdout.includes("\u0007")).toBe(false);
    }),
  );

  it.effect("reads a published session without reopening its host or changing its database", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      const stateDir = join(stateRoot, "7");
      const github = makeFakeGitHub({ source: [] });
      const published = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* openLocalIssue({
            repo,
            issue: 7,
            stateDir,
            checks: ["test -f notes.txt"],
            pi: scriptedModels(),
          }).pipe(Effect.provide(github.layer));
          yield* host.drain();
          // Inspect while the real host still owns SQLite and its runner lock.
          expect((yield* collectLocalStatus({ repo, stateRoot })).sessions[0]?.state?.status).toBe(
            "published",
          );
          return (yield* host.view()).state;
        }),
      );
      const before = yield* Effect.promise(() => readFile(join(stateDir, "session.sqlite")));
      const files = yield* Effect.promise(() => readdir(stateDir));
      const result = yield* collectLocalStatus({ repo, stateRoot });
      expect(result.sessions[0]?.error).toBeNull();
      expect(result.sessions[0]).toMatchObject({
        issue: 7,
        source: "session",
        state: {
          status: "published",
          pullRequest: published.pullRequest,
        },
      });
      expect(result.sessions[0]?.state?.candidate?.evidence).toContain("test -f notes.txt");
      expect(result.watcher.lock).toBe("free");
      expect(yield* Effect.promise(() => readFile(join(stateDir, "session.sqlite")))).toEqual(
        before,
      );
      const after = yield* Effect.promise(() => readdir(stateDir));
      // SQLite read-only WAL readers may create bookkeeping sidecars, never session data.
      const dataFiles = (names: string[]) =>
        names.filter((name) => !["session.sqlite-shm", "session.sqlite-wal"].includes(name));
      expect(dataFiles(after)).toEqual(dataFiles(files));
      if (after.includes("session.sqlite-wal"))
        expect((yield* Effect.promise(() => stat(join(stateDir, "session.sqlite-wal")))).size).toBe(
          0,
        );
      expect(github.state.pullRequests).toHaveLength(1);
      expect(
        (yield* collectLocalStatus({ repo: { owner: "other", name: "app" }, stateRoot }))
          .sessions[0]?.source,
      ).toBe("unavailable");
    }),
  );

  it.effect("observes the watcher lock and reports free ownership after its scope closes", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* openLocalWatcher({
            repo,
            stateRoot,
            pollSeconds: 60,
            discover: Effect.succeed([]),
            runIssue: () => Effect.succeed("published" as const),
          });
          const status = yield* collectLocalStatus({ repo, stateRoot });
          expect(status.watcher.lock).toBe("held");
          expect(status.watcher.pid).not.toBeNull();
        }),
      );
      expect((yield* collectLocalStatus({ repo, stateRoot })).watcher.lock).toBe("free");
    }),
  );

  it.effect("reports queued work and isolates corrupt or unsupported databases", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      yield* Effect.promise(() =>
        writeFile(
          join(stateRoot, "watch.json"),
          JSON.stringify({
            version: 1,
            repo,
            pending: [7, 8],
            settled: [9],
          }),
        ),
      );
      yield* Effect.promise(() => mkdir(join(stateRoot, "8")));
      const empty = yield* Effect.promise(() =>
        openNodeSqliteStorage(join(stateRoot, "5/session.sqlite")),
      );
      yield* Effect.promise(() => empty.close(BACKGROUND_CONTEXT));
      yield* Effect.promise(() => writeFile(join(stateRoot, "8/session.sqlite"), "corrupt"));
      const futurePath = join(stateRoot, "9/session.sqlite");
      const storage = yield* Effect.promise(() => openNodeSqliteStorage(futurePath));
      yield* Effect.promise(() => storage.close(BACKGROUND_CONTEXT));
      yield* Effect.acquireUseRelease(
        Effect.promise(() => openNodeSqliteDatabase(futurePath)),
        (db) => Effect.promise(() => db.run("UPDATE durable_schema SET version = 999")),
        (db) => Effect.promise(() => db.close()),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const github = makeFakeGitHub({ source: [] });
          const host = yield* openLocalIssue({
            repo,
            issue: 10,
            stateDir: join(stateRoot, "10"),
            checks: ["test -f notes.txt"],
            pi: scriptedModels(),
          }).pipe(Effect.provide(github.layer));
          yield* host.drain();
        }),
      );
      const snapshot = yield* collectLocalStatus({ repo, stateRoot });
      expect(snapshot.sessions.map((session) => [session.issue, session.source])).toEqual([
        [5, "uninitialized"],
        [7, "queued"],
        [8, "unavailable"],
        [9, "unavailable"],
        [10, "session"],
      ]);
      expect(snapshot.sessions[4]?.state?.status).toBe("published");
      expect((yield* Effect.promise(() => readdir(stateRoot))).sort()).toEqual([
        "10",
        "5",
        "8",
        "9",
        "watch.json",
      ]);
    }),
  );

  it.effect(
    "missing state roots are not created and malformed receipts are reported unchanged",
    () =>
      Effect.gen(function* () {
        const root = yield* directory;
        const stateRoot = join(root, "missing");
        expect((yield* collectLocalStatus({ repo, stateRoot })).sessions).toEqual([]);
        expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
        yield* Effect.promise(() => writeFile(join(root, "watch.json"), "bad receipt"));
        const result = yield* collectLocalStatus({ repo, stateRoot: root, issue: 7 });
        expect(result.warnings).toHaveLength(1);
        expect(result.sessions).toEqual([
          { issue: 7, source: "missing", state: null, error: null },
        ]);
        expect(yield* Effect.promise(() => readFile(join(root, "watch.json"), "utf8"))).toBe(
          "bad receipt",
        );
      }),
  );

  it.effect("the CLI requires no Pi profile or private key and JSON is a reusable snapshot", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const config = join(root, "github.json");
      yield* Effect.promise(() =>
        writeFile(config, JSON.stringify({ repo, privateKeyFile: "/missing/key.pem" })),
      );
      const stateRoot = join(root, "absent-state");
      const result = yield* Effect.promise(() =>
        promisify(execFile)(
          process.execPath,
          [
            join(import.meta.dirname, "local-status-cli.ts"),
            "--github-config",
            config,
            "--state-root",
            stateRoot,
            "--json",
          ],
          { env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8" },
        ),
      );
      const snapshot = yield* Schema.decodeUnknownEffect(LocalStatus)(JSON.parse(result.stdout));
      expect(snapshot).toMatchObject({
        repo,
        stateRoot,
        sessions: [],
        watcher: { lock: "free" },
      });
      expect(yield* Effect.promise(() => readdir(root))).toEqual(["github.json"]);
    }),
  );

  it.effect("reports unknown ownership when the OS lock scanner is unavailable", () =>
    Effect.gen(function* () {
      const stateRoot = yield* directory;
      yield* Effect.promise(() => writeFile(join(stateRoot, ".watch.lock"), ""));
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env.PATH;
          process.env.PATH = "/nonexistent/puchero-status-test";
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const status = yield* collectLocalStatus({ repo, stateRoot });
            expect(status.watcher).toMatchObject({ lock: "unknown", pid: null });
            expect(status.sessions).toEqual([]);
          }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
          }),
      );
    }),
  );

  it.effect(
    "the CLI returns exit 1 with a structured snapshot when receipt identity mismatches",
    () =>
      Effect.gen(function* () {
        const stateRoot = yield* directory;
        yield* Effect.promise(() =>
          writeFile(
            join(stateRoot, "watch.json"),
            JSON.stringify({
              version: 1,
              repo: { owner: "other", name: "app" },
              pending: [7],
              settled: [],
            }),
          ),
        );
        const result = yield* Effect.promise(() =>
          promisify(execFile)(
            process.execPath,
            [
              join(import.meta.dirname, "local-status-cli.ts"),
              "--repo",
              "acme/app",
              "--state-root",
              stateRoot,
              "--json",
            ],
            { env: { PATH: "/usr/bin:/bin", HOME: stateRoot }, encoding: "utf8" },
          ).then(
            (value) => ({ code: 0, stdout: value.stdout }),
            (error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                typeof error.code === "number" &&
                "stdout" in error &&
                typeof error.stdout === "string"
              )
                return { code: error.code, stdout: error.stdout };
              throw error;
            },
          ),
        );
        expect(result.code).toBe(1);
        const snapshot = yield* Schema.decodeUnknownEffect(LocalStatus)(JSON.parse(result.stdout));
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.sessions).toEqual([]);
      }),
  );
});
