import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readLocalRepairContext } from "./local-repair-ci.ts";

describe("Repair CI admission", () => {
  it.effect(
    "reads a verified same-head failure and declines old or passing checks without downloading logs",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "caldero-repair-ci-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const oldPath = process.env.PATH;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.PATH = `${root}:/usr/bin:/bin`;
          }),
          () =>
            Effect.sync(() => {
              if (oldPath === undefined) delete process.env.PATH;
              else process.env.PATH = oldPath;
            }),
        );
        const sha = "a".repeat(40);
        const endpoint = "repos/acme/app/actions/jobs/42";
        yield* Effect.promise(() =>
          writeFile(
            join(root, "gh"),
            [
              "#!/bin/sh",
              `cd "${root}" || exit 1`,
              'case "$*" in',
              '  "api graphql --hostname github.com "*) cat rollup.json ;;',
              `  "api --hostname github.com ${endpoint}") cat job.json ;;`,
              `  "api --hostname github.com --allow-escape-sequences ${endpoint}/logs")`,
              "    echo read >> requests",
              "    printf 'old-prefix\\n'",
              "    head -c 2250000 /dev/zero | tr '\\000' x",
              "    printf '\\n\\033[31mAssertion failed: expected 2, got 3\\033[0m\\n' ;;",
              "  *) exit 1 ;;",
              "esac",
            ].join("\n"),
            { mode: 0o700 },
          ),
        );
        const rollup = (state: string, conclusion = state) =>
          Effect.promise(() =>
            writeFile(
              join(root, "rollup.json"),
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      headRefOid: sha,
                      commits: {
                        nodes: [
                          {
                            commit: {
                              oid: sha,
                              statusCheckRollup: {
                                state,
                                contexts: {
                                  totalCount: 1,
                                  checkRunCountsByState: [{ state, count: 1 }],
                                  statusContextCountsByState: [],
                                  nodes: [
                                    {
                                      kind: "CheckRun",
                                      status: "COMPLETED",
                                      conclusion,
                                      name: "unit",
                                      startedAt: "2026-11-21T02:00:00Z",
                                      checkSuite: null,
                                      detailsUrl:
                                        "https://github.com/acme/app/actions/runs/7/job/42",
                                    },
                                  ],
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            ),
          );
        const job = (head: string) =>
          Effect.promise(() =>
            writeFile(
              join(root, "job.json"),
              JSON.stringify({
                id: 42,
                run_id: 7,
                head_sha: head,
                status: "completed",
                conclusion: "failure",
              }),
            ),
          );
        const read = () =>
          readLocalRepairContext(
            { owner: "acme", name: "app" },
            { number: 5, headRef: "caldero/3-v1", headSha: sha, baseRef: "main" },
          );
        yield* rollup("SUCCESS");
        expect(yield* read()).toBeUndefined();
        yield* rollup("PENDING", "FAILURE");
        yield* job("b".repeat(40));
        expect(yield* read()).toBeUndefined();
        yield* job(sha);
        const context = yield* read();
        expect(context).toContain("expected 2, got 3");
        expect(context).not.toContain("old-prefix");
        expect(context).not.toContain("\\u001b");
        expect(context?.length).toBeLessThan(9000);
        expect(yield* Effect.promise(() => readFile(join(root, "requests"), "utf8"))).toBe(
          "read\n",
        );
      }),
  );
});
