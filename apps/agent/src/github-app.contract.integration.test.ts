import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { GitHubApp } from "./github-app.ts";
import { GitHubError, type Patch, type PublishJournal, PublishProgress } from "./ports.ts";

const decodeJournal = Schema.decodeSync(Schema.fromJsonString(PublishProgress));
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the opt-in scratch GitHub App contract check`);
  return value;
};

/** Explicit opt-in only: creates a branch and PR in the configured scratch repository, and leaves them for inspection. */
describe.skipIf(process.env.PUCHERO_GITHUB_CONTRACT !== "1")("GitHub App live contract", () => {
  it.live(
    "publishes via installation credentials, verifies the files, and reconciles to the same PR",
    () =>
      Effect.gen(function* () {
        const owner = required("PUCHERO_GITHUB_OWNER");
        const name = required("PUCHERO_GITHUB_REPO");
        const issue = Number(required("PUCHERO_GITHUB_ISSUE"));
        const installationId = Number(required("PUCHERO_GITHUB_INSTALLATION_ID"));
        if (
          !Number.isSafeInteger(issue) ||
          issue <= 0 ||
          !Number.isSafeInteger(installationId) ||
          installationId <= 0
        )
          return yield* new GitHubError({
            message: "Issue and installation ID must be positive integers",
          });
        const journalPath = required("PUCHERO_GITHUB_JOURNAL_FILE");
        const ioError = () =>
          new GitHubError({ message: "Could not read credentials or retain the contract journal" });
        const existing = yield* Effect.tryPromise({
          try: () => readFile(journalPath, "utf8"),
          catch: (error) =>
            new GitHubError({
              message:
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
                  ? "missing"
                  : "Could not read contract journal",
            }),
        }).pipe(
          Effect.catchIf(
            (error) => error.message === "missing",
            () => Effect.succeed(null),
          ),
        );
        let progress = existing === null ? null : decodeJournal(existing);
        const repo = { owner, name };
        const options = {
          repo,
          installationId,
          appId: required("PUCHERO_GITHUB_APP_ID"),
          privateKey: yield* Effect.tryPromise({
            try: () => readFile(required("PUCHERO_GITHUB_PRIVATE_KEY_FILE"), "utf8"),
            catch: ioError,
          }),
          author: { name: "puchero contract", email: "puchero-contract@users.noreply.github.com" },
        };
        const github = yield* GitHubApp.make(options);
        const context = yield* github.fetchIssueContext(repo, issue);
        const version =
          progress?.binding.version ?? Number.parseInt(randomUUID().slice(0, 8), 16) + 1;
        const changes: Patch["files"] = [
          {
            path: `.puchero-contract/${version}/binary.bin`,
            change: "write",
            content: "AP8B/g==",
            executable: false,
          },
          {
            path: `.puchero-contract/${version}/run.sh`,
            change: "write",
            content: "IyEvYmluL3NoCg==",
            executable: true,
          },
        ];
        const digest = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
        const binding = progress?.binding ?? {
          sessionId: `contract:${owner}/${name}#${issue}`,
          version,
          runId: 1,
          repo,
          baseRef: context.baseRef,
          baseSha: context.baseSha,
          patchDigest: digest,
        };
        const patch: Patch = {
          digest,
          diff: "contract binary and executable fixture",
          files: changes,
        };
        const journal: PublishJournal = {
          read: () => Effect.succeed(progress),
          save: (value) =>
            Effect.tryPromise({
              try: () => writeFile(journalPath, JSON.stringify(value), { mode: 0o600 }),
              catch: ioError,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  progress = value;
                }),
              ),
            ),
        };
        const pr = yield* github.publish(issue, binding, patch, journal);
        const saved = yield* journal.read();
        if (saved?.commitSha == null)
          return yield* new GitHubError({ message: "No committed publication receipt" });
        const files = yield* github.fetchSource(repo, saved.commitSha);
        expect(
          files.find((file) => file.path === `.puchero-contract/${binding.version}/binary.bin`)
            ?.content,
        ).toEqual(new Uint8Array([0, 255, 1, 254]));
        expect(
          files.find((file) => file.path === `.puchero-contract/${binding.version}/run.sh`)
            ?.executable,
        ).toBe(true);
        const next = yield* GitHubApp.make(options);
        expect(yield* next.reconcile(issue, binding, journal)).toEqual({
          found: "pullRequest",
          pullRequest: pr,
        });
        return yield* Effect.logInfo(`Scratch contract PR: ${pr.url}; journal: ${journalPath}`);
      }),
    { timeout: 120_000 },
  );
});
