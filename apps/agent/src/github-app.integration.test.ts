import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { GitHubApp } from "./github-app.ts";
import { type Patch, type PublishProgress, type PublishJournal } from "./ports.ts";

const repo = { owner: "acme", name: "app" };
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const binding = {
  sessionId: "acme/app#7",
  version: 1,
  runId: 1,
  repo,
  baseSha: "base-1",
  baseRef: "main",
  patchDigest: "sha256:patch",
};
const patch: Patch = {
  digest: binding.patchDigest,
  diff: "binary and modes",
  files: [
    { path: "old.txt", change: "delete" },
    { path: "logo.bin", change: "write", content: "AP8B/g==", executable: false },
    { path: "bin/run", change: "write", content: "IyEvYmluL3NoCg==", executable: true },
  ],
};

const memoryJournal = () => {
  let value: PublishProgress | null = null;
  const journal: PublishJournal = {
    read: () => Effect.succeed(value),
    save: (progress) =>
      Effect.sync(() => {
        value = progress;
      }),
  };
  return { journal, value: () => value };
};

/** A real HTTP peer; only GitHub is simulated, not the adapter's transport or auth. */
const peer = (handle: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
          const server = createServer(handle);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("No TCP port");
            resolve({ server, url: `http://127.0.0.1:${address.port}` });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

describe("GitHub repair publication", () => {
  it.effect("times out an unresponsive GitHub API request", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const http = yield* peer((request) => {
        request.resume();
        Deferred.doneUnsafe(received, Effect.void);
        // Hold the response open so only the adapter's timeout can settle the request.
      });
      const github = yield* GitHubApp.make({
        appId: "1",
        installationId: 42,
        privateKey,
        repo,
        author: { name: "bot", email: "bot@example.test" },
        apiUrl: http.url,
      });
      const settled = yield* Deferred.make<void>();
      const fiber = yield* github.listOpenLabeledIssues("agent").pipe(
        Effect.flip,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(received);
      yield* TestClock.adjust("29 seconds");
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("2 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toContain("timed out");
    }),
  );

  it.effect("admits only open, same-repository pull requests authored by the configured App", () =>
    Effect.gen(function* () {
      const pr = {
        number: 101,
        html_url: "https://github.test/acme/app/pull/101",
        state: "open",
        merged: false,
        user: { login: "repair-fixture[bot]", type: "Bot" },
        head: { sha: "pr-head", ref: "caldero/7-v1", repo: { full_name: "acme/app" } },
        base: { ref: "main" },
      };
      let remote = pr;
      const http = yield* peer((request, response) => {
        switch (request.url) {
          case "/app/installations/42/access_tokens":
            request.resume();
            return json(response, { token: "token" });
          case "/app":
            return json(response, { slug: "repair-fixture" });
          case "/repos/acme/app/pulls/101":
            return json(response, remote);
          default:
            return json(response, {}, 404);
        }
      });
      const github = yield* GitHubApp.make({
        appId: "1",
        installationId: 42,
        privateKey,
        repo,
        author: { name: "bot", email: "bot@example.test" },
        apiUrl: http.url,
      });
      expect(yield* github.readRepairTarget(101)).toMatchObject({
        number: 101,
        headSha: "pr-head",
      });
      for (const [fixture, message] of [
        [{ ...pr, state: "closed" }, "open pull request"],
        [{ ...pr, state: "closed", merged: true }, "open pull request"],
        [{ ...pr, head: { ...pr.head, repo: { full_name: "fork/app" } } }, "configured repository"],
        [
          { ...pr, user: { login: pr.user.login, type: "User" } },
          "opened by the configured GitHub App",
        ],
        [
          { ...pr, user: { ...pr.user, login: "other[bot]" } },
          "opened by the configured GitHub App",
        ],
      ] as const) {
        remote = fixture;
        expect((yield* github.readRepairTarget(101).pipe(Effect.flip)).message).toContain(message);
      }
    }),
  );

  for (const outcome of ["success", "lost response", "concurrent push"] as const) {
    it.effect(`appends at most one checked commit on the existing PR after ${outcome}`, () =>
      Effect.gen(function* () {
        const { journal, value } = memoryJournal();
        let head = "pr-head";
        let commitMessage = "";
        let writes = 0;
        const http = yield* peer((request, response) => {
          switch (request.url) {
            case "/app/installations/42/access_tokens":
              request.resume();
              return json(response, { token: "token" });
            case "/app":
              return json(response, { slug: "repair-fixture" });
            case "/repos/acme/app/pulls/101":
              return json(response, {
                number: 101,
                html_url: "https://github.test/acme/app/pull/101",
                state: "open",
                merged: false,
                user: { login: "repair-fixture[bot]", type: "Bot" },
                head: { sha: head, ref: "caldero/7-v1", repo: { full_name: "acme/app" } },
                base: { ref: "main" },
              });
            case "/repos/acme/app/git/commits/fix":
              return json(response, { message: commitMessage, parents: [{ sha: "pr-head" }] });
            case "/repos/acme/app/git/commits/human":
              return json(response, { message: "human push", parents: [{ sha: "pr-head" }] });
            case "/graphql": {
              let body = "";
              request.on("data", (chunk) => {
                body += String(chunk);
              });
              request.on("end", () => {
                const { input } = JSON.parse(body).variables;
                expect(input).toMatchObject({
                  expectedHeadOid: "pr-head",
                  branch: { repositoryNameWithOwner: "acme/app", branchName: "caldero/7-v1" },
                  fileChanges: {
                    additions: [{ path: "logo.bin", contents: "AP8B/g==" }],
                    deletions: [{ path: "old.txt" }],
                  },
                });
                commitMessage = `${input.message.headline}\n\n${input.message.body}`;
                expect(value()?.message).toBe(commitMessage);
                if (outcome === "concurrent push") head = "human";
                if (head !== input.expectedHeadOid)
                  return json(response, { errors: [{ message: "Head moved" }] });
                writes++;
                head = "fix";
                if (outcome === "lost response") return response.destroy();
                return json(response, {
                  data: { createCommitOnBranch: { commit: { oid: head } } },
                });
              });
              return;
            }
            default:
              return json(response, {}, 404);
          }
        });
        const github = yield* GitHubApp.make({
          appId: "1",
          installationId: 42,
          privateKey,
          repo,
          author: { name: "bot", email: "bot@example.test" },
          apiUrl: http.url,
        });
        const target = yield* github.readRepairTarget(101);
        const repair = { ...binding, baseSha: target.headSha, version: 2, repair: target };
        const repairPatch = { ...patch, files: patch.files.slice(0, 2) };
        if (outcome === "success") {
          for (const invalid of [
            patch,
            { ...repairPatch, diff: "old mode 100755\nnew mode 100644" },
          ]) {
            expect(
              yield* github.publish(7, repair, invalid, journal).pipe(Effect.flip),
            ).toMatchObject({
              kind: "permanent",
            });
          }
          expect(writes).toBe(0);
        }
        const attempted = yield* github
          .publish(7, repair, repairPatch, journal)
          .pipe(Effect.result);
        if (outcome === "success") expect(attempted).toMatchObject({ success: { number: 101 } });
        else expect(attempted).toMatchObject({ failure: { kind: "ambiguous" } });
        const reconciled = yield* github.reconcile(7, repair, journal);
        if (outcome === "concurrent push") {
          expect(reconciled).toMatchObject({ found: "conflict" });
          expect(writes).toBe(0);
        } else {
          expect(reconciled).toMatchObject({ found: "pullRequest", pullRequest: { number: 101 } });
          expect(yield* github.publish(7, repair, repairPatch, journal)).toMatchObject({
            number: 101,
          });
          expect(writes).toBe(1);
        }
      }),
    );
  }
});

describe("GitHub issue discovery", () => {
  it.effect("paginates open labeled issues and excludes pull requests", () =>
    Effect.gen(function* () {
      const pages: string[] = [];
      const http = yield* peer((request, response) => {
        if (request.url === "/app/installations/42/access_tokens") {
          request.resume();
          json(response, { token: "token" });
          return;
        }
        const url = new URL(request.url ?? "", "http://fixture");
        expect(url.pathname).toBe("/repos/acme/app/issues");
        expect(url.searchParams.get("state")).toBe("open");
        expect(url.searchParams.get("labels")).toBe("agent work");
        const page = url.searchParams.get("page") ?? "";
        pages.push(page);
        json(
          response,
          page === "1"
            ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1, pull_request: {} }))
            : [{ number: 107 }, { number: 108 }],
        );
      });
      const github = yield* GitHubApp.make({
        appId: "1",
        installationId: 42,
        privateKey,
        repo,
        author: { name: "bot", email: "bot@example.test" },
        apiUrl: http.url,
      });
      expect(yield* github.listOpenLabeledIssues("agent work")).toEqual([107, 108]);
      expect(pages).toEqual(["1", "2"]);
    }),
  );
});

/** GitHub's publication protocol, with remote state independent of the client's journal. */
const publisherPeer = () =>
  Effect.gen(function* () {
    const posts: Array<{ path: string; body: unknown }> = [];
    let branch: string | null = null;
    let pr: {
      number: number;
      html_url: string;
      head: { sha: string; ref: string };
      base: { ref: string };
    } | null = null;
    let drop: string | null = null;
    let raceRef: string | null = null;
    let racePr = false;
    let base = "base-1";
    const http = yield* peer((request, response) => {
      const path = request.url ?? "";
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          const data: unknown = JSON.parse(body);
          posts.push({ path, body: data });
          const reply = (value: unknown, status = 201) => {
            if (drop === path) {
              drop = null;
              response.destroy();
            } else json(response, value, status);
          };
          if (path === "/app/installations/42/access_tokens")
            json(response, { token: "token" }, 201);
          else if (path.endsWith("/git/blobs"))
            reply({
              sha:
                typeof data === "object" &&
                data !== null &&
                "content" in data &&
                data.content === "AP8B/g=="
                  ? "binary-blob"
                  : "script-blob",
            });
          else if (path.endsWith("/git/trees")) reply({ sha: "new-tree" });
          else if (path.endsWith("/git/commits")) reply({ sha: "new-commit" });
          else if (path.endsWith("/git/refs")) {
            if (raceRef !== null) {
              branch = raceRef;
              raceRef = null;
            }
            if (branch !== null) json(response, { message: "Reference already exists" }, 422);
            else {
              branch = "new-commit";
              reply({ object: { sha: branch } });
            }
          } else if (path === "/repos/acme/app/pulls") {
            if (racePr) {
              pr = {
                number: 101,
                html_url: "https://github.test/acme/app/pull/101",
                head: { sha: "new-commit", ref: "caldero/7-v1" },
                base: { ref: "main" },
              };
              racePr = false;
            }
            if (pr !== null) json(response, { message: "PR already exists" }, 422);
            else {
              pr = {
                number: 101,
                html_url: "https://github.test/acme/app/pull/101",
                head: { sha: "new-commit", ref: "caldero/7-v1" },
                base: { ref: "main" },
              };
              reply(pr);
            }
          } else json(response, {}, 404);
        });
      } else if (path === "/repos/acme/app/git/commits/base-1")
        json(response, { sha: "base-1", tree: { sha: "base-tree" } });
      else if (path === "/repos/acme/app/git/ref/heads/main")
        json(response, { object: { sha: base } });
      else if (path.startsWith("/repos/acme/app/git/ref/heads/")) {
        if (branch === null) json(response, {}, 404);
        else json(response, { object: { sha: branch } });
      } else if (path.startsWith("/repos/acme/app/pulls?")) json(response, pr === null ? [] : [pr]);
      else json(response, {}, 404);
    });
    return {
      ...http,
      posts,
      branch: () => branch,
      pr: () => pr,
      setBranch: (sha: string) => {
        branch = sha;
      },
      setBase: (sha: string) => {
        base = sha;
      },
      dropAfter: (path: string) => {
        drop = path;
      },
      raceRef: (sha: string) => {
        raceRef = sha;
      },
      racePr: () => {
        racePr = true;
      },
    };
  });

const adapter = (apiUrl: string) =>
  GitHubApp.make({
    appId: "123",
    installationId: 42,
    privateKey,
    repo,
    apiUrl,
    author: { name: "caldero", email: "bot@example.com" },
  });

describe("GitHubApp", () => {
  for (const rateLimit of [
    { status: 429, retryAfter: null, kind: "retryable" },
    { status: 403, retryAfter: "1", kind: "retryable" },
    { status: 403, retryAfter: null, kind: "permanent" },
  ]) {
    it.effect(
      `classifies HTTP ${rateLimit.status} with Retry-After ${rateLimit.retryAfter} as ${rateLimit.kind}`,
      () =>
        Effect.gen(function* () {
          const http = yield* peer((_request, response) => {
            if (rateLimit.retryAfter !== null)
              response.setHeader("Retry-After", rateLimit.retryAfter);
            json(response, { message: "Denied" }, rateLimit.status);
          });
          const github = yield* adapter(http.url);
          expect(
            yield* github.publish(7, binding, patch, memoryJournal().journal).pipe(Effect.flip),
          ).toMatchObject({ kind: rateLimit.kind });
        }),
    );
  }
  for (const tree of [
    { truncated: true, tree: [] },
    { truncated: false, tree: [{ path: "link", mode: "120000", type: "blob", sha: "symlink" }] },
    {
      truncated: false,
      tree: [{ path: "vendor", mode: "160000", type: "commit", sha: "submodule" }],
    },
  ]) {
    it.effect(`refuses incomplete or unsupported source trees: ${JSON.stringify(tree)}`, () =>
      Effect.gen(function* () {
        const http = yield* peer((request, response) => {
          if (request.url === "/app/installations/42/access_tokens")
            json(response, { token: "token" }, 201);
          else if (request.url === "/repos/acme/app/git/commits/base-1")
            json(response, { sha: "base-1", tree: { sha: "tree" } });
          else json(response, tree);
        });
        const github = yield* adapter(http.url);
        expect(yield* github.fetchSource(repo, "base-1").pipe(Effect.flip)).toMatchObject({
          _tag: "GitHubError",
        });
      }),
    );
  }

  it.effect("does not send a token or request outside its configured repository", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const http = yield* peer((request, response) => {
        calls.push(request.url ?? "");
        json(response, {}, 403);
      });
      const github = yield* adapter(http.url);
      expect(
        yield* github.fetchSource({ owner: "another", name: "repo" }, "base-1").pipe(Effect.flip),
      ).toMatchObject({ message: "Repository is outside the configured installation scope" });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("deduplicates a comment after GitHub stored it but its response was lost", () =>
    Effect.gen(function* () {
      const posted: Array<{ body: string }> = [];
      const http = yield* peer((request, response) => {
        if (request.url === "/app/installations/42/access_tokens")
          json(response, { token: "token" }, 201);
        else if (request.method === "GET") json(response, posted);
        else {
          let body = "";
          request.on("data", (chunk) => {
            body += String(chunk);
          });
          request.on("end", () => {
            posted.push(JSON.parse(body));
            response.destroy();
          });
        }
      });
      const github = yield* adapter(http.url);
      yield* github.comment(repo, 7, "published:v1", "Opened PR").pipe(Effect.flip);
      yield* github.comment(repo, 7, "published:v1", "Opened PR");
      expect(posted).toEqual([{ body: "Opened PR\n\n<!-- caldero:cHVibGlzaGVkOnYx -->" }]);
    }),
  );
  for (const stage of ["blobs", "trees", "commits", "refs", "pulls"]) {
    it.effect(
      `recovers a lost ${stage} response without duplicating the PR or changing commit metadata`,
      () =>
        Effect.gen(function* () {
          const http = yield* publisherPeer();
          http.dropAfter(`/repos/acme/app/${stage === "pulls" ? stage : `git/${stage}`}`);
          const { journal } = memoryJournal();
          const first = yield* adapter(http.url);
          expect(yield* first.publish(7, binding, patch, journal).pipe(Effect.flip)).toMatchObject({
            kind: "ambiguous",
          });
          const next = yield* adapter(http.url);
          const result = yield* next.reconcile(7, binding, journal);
          const pr =
            result.found === "pullRequest"
              ? result.pullRequest
              : yield* next.publish(7, binding, patch, journal);
          expect(pr.number).toBe(101);
          expect(http.posts.filter((post) => post.path === "/repos/acme/app/pulls")).toHaveLength(
            1,
          );
          const commits = http.posts.filter((post) => post.path.endsWith("/git/commits"));
          expect(
            commits.every((post) => JSON.stringify(post.body) === JSON.stringify(commits[0]?.body)),
          ).toBe(true);
        }),
    );
  }

  for (const crashAfterSave of [1, 2, 3, 4, 5, 6, 7]) {
    it.effect(
      `resumes from durable receipt ${crashAfterSave} after the publishing process dies`,
      () =>
        Effect.gen(function* () {
          const http = yield* publisherPeer();
          const saved = memoryJournal();
          let saves = 0;
          const journal: PublishJournal = {
            read: saved.journal.read,
            save: (progress) =>
              saved.journal
                .save(progress)
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      ++saves === crashAfterSave
                        ? Effect.die(new Error("Process died"))
                        : Effect.void,
                    ),
                  ),
                ),
          };
          const first = yield* adapter(http.url);
          const interrupted = yield* first.publish(7, binding, patch, journal).pipe(Effect.exit);
          expect(Exit.isFailure(interrupted)).toBe(true);
          const next = yield* adapter(http.url);
          expect((yield* next.publish(7, binding, patch, saved.journal)).number).toBe(101);
          expect(http.posts.filter((post) => post.path === "/repos/acme/app/pulls")).toHaveLength(
            1,
          );
        }),
    );
  }

  it.effect("accepts 422 only when the raced branch and PR match the approved commit", () =>
    Effect.gen(function* () {
      const http = yield* publisherPeer();
      http.raceRef("new-commit");
      http.racePr();
      const github = yield* adapter(http.url);
      expect((yield* github.publish(7, binding, patch, memoryJournal().journal)).number).toBe(101);
    }),
  );

  it.effect("refuses a conflicting raced branch without opening a PR or overwriting it", () =>
    Effect.gen(function* () {
      const http = yield* publisherPeer();
      http.raceRef("someone-else");
      const github = yield* adapter(http.url);
      expect(
        yield* github.publish(7, binding, patch, memoryJournal().journal).pipe(Effect.flip),
      ).toMatchObject({ kind: "permanent", message: "branch conflict on caldero/7-v1" });
      expect(http.branch()).toBe("someone-else");
      expect(http.pr()).toBeNull();
    }),
  );

  it.effect("refuses publication after the approved base branch moved", () =>
    Effect.gen(function* () {
      const http = yield* publisherPeer();
      http.setBase("advanced-base");
      const github = yield* adapter(http.url);
      expect(
        yield* github.publish(7, binding, patch, memoryJournal().journal).pipe(Effect.flip),
      ).toMatchObject({
        kind: "permanent",
        message: "Base branch moved since validation; publication stopped",
      });
      expect(http.pr()).toBeNull();
      expect(http.branch()).toBeNull();
    }),
  );
  it.effect(
    "hydrates issue context at one base commit and finds an existing linking comment on later pages",
    () =>
      Effect.gen(function* () {
        const posted: Array<unknown> = [];
        const http = yield* peer((request, response) => {
          const path = request.url ?? "";
          if (path === "/app/installations/42/access_tokens")
            json(response, { token: "token" }, 201);
          else if (path === "/repos/acme/app") json(response, { default_branch: "main" });
          else if (path === "/repos/acme/app/git/ref/heads/main")
            json(response, { object: { sha: "base-1" } });
          else if (path === "/repos/acme/app/issues/7")
            json(response, {
              title: "Fix login",
              body: "Login fails",
              html_url: "https://github.test/issues/7",
            });
          else if (path.startsWith("/repos/acme/app/contents/AGENTS.md?ref=base-1"))
            json(response, {
              encoding: "base64",
              content: Buffer.from("Use Effect").toString("base64"),
            });
          else if (path === "/repos/acme/app/issues/7/comments?per_page=100&page=1")
            json(
              response,
              Array.from({ length: 100 }, () => ({ body: "context" })),
            );
          else if (path === "/repos/acme/app/issues/7/comments?per_page=100&page=2")
            json(response, [{ body: "result\n\n<!-- caldero:cHVibGlzaGVkOnYx -->" }]);
          else {
            posted.push(path);
            json(response, {}, 201);
          }
        });
        const github = yield* adapter(http.url);
        const context = yield* github.fetchIssueContext(repo, 7);
        expect(context).toMatchObject({ baseRef: "main", baseSha: "base-1" });
        expect(context.context).toContain("Fix login");
        expect(context.context).toContain("Use Effect");
        expect(context.context).toContain("context");
        expect(context.context).toContain("https://github.test/issues/7");
        yield* github.comment(repo, 7, "published:v1", "result");
        expect(posted).toEqual([]);
      }),
  );
  it.effect(
    "publishes the exact binary, deletion and executable patch once against the base tree",
    () =>
      Effect.gen(function* () {
        const http = yield* publisherPeer();
        const github = yield* adapter(http.url);
        const { journal, value } = memoryJournal();
        expect(yield* github.publish(7, binding, patch, journal)).toEqual({
          number: 101,
          url: "https://github.test/acme/app/pull/101",
        });
        expect(yield* github.publish(7, binding, patch, journal)).toEqual({
          number: 101,
          url: "https://github.test/acme/app/pull/101",
        });
        expect(http.posts.filter((post) => post.path.endsWith("/git/trees"))).toEqual([
          {
            path: "/repos/acme/app/git/trees",
            body: {
              base_tree: "base-tree",
              tree: [
                { path: "old.txt", mode: "100644", type: "blob", sha: null },
                { path: "logo.bin", mode: "100644", type: "blob", sha: "binary-blob" },
                { path: "bin/run", mode: "100755", type: "blob", sha: "script-blob" },
              ],
            },
          },
        ]);
        expect(http.posts.find((post) => post.path.endsWith("/git/blobs"))?.body).toEqual({
          content: "AP8B/g==",
          encoding: "base64",
        });
        expect(http.posts.find((post) => post.path.endsWith("/git/commits"))?.body).toMatchObject({
          tree: "new-tree",
          parents: ["base-1"],
          author: { name: "caldero", email: "bot@example.com", date: "1970-01-01T00:00:00.000Z" },
          committer: {
            name: "caldero",
            email: "bot@example.com",
            date: "1970-01-01T00:00:00.000Z",
          },
        });
        expect(http.posts.filter((post) => post.path === "/repos/acme/app/pulls")).toHaveLength(1);
        expect(value()?.commitSha).toBe("new-commit");
      }),
  );
  it.effect(
    "mints a repository-scoped App token and fetches binary source and executable modes",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const auth: Array<string> = [];
        let tokenBody = "";
        const http = yield* peer((request, response) => {
          calls.push(`${request.method} ${request.url}`);
          auth.push(request.headers.authorization ?? "");
          if (request.url === "/app/installations/42/access_tokens") {
            request.on("data", (chunk) => {
              tokenBody += String(chunk);
            });
            request.on("end", () =>
              json(
                response,
                { token: "installation-token", expires_at: "2099-01-01T00:00:00Z" },
                201,
              ),
            );
          } else if (request.url === "/repos/acme/app/git/commits/base-1")
            json(response, { sha: "base-1", tree: { sha: "base-tree" } });
          else if (request.url === "/repos/acme/app/git/trees/base-tree?recursive=1")
            json(response, {
              truncated: false,
              tree: [
                { path: "bin", mode: "040000", type: "tree", sha: "dir" },
                { path: "bin/run", mode: "100755", type: "blob", sha: "script" },
                { path: "logo.bin", mode: "100644", type: "blob", sha: "binary" },
              ],
            });
          else if (request.url === "/repos/acme/app/git/blobs/script")
            json(response, { encoding: "base64", content: "IyEvYmluL3NoCg==\n" });
          else if (request.url === "/repos/acme/app/git/blobs/binary")
            json(response, { encoding: "base64", content: "AP8B/g==" });
          else json(response, { message: "Unexpected request" }, 404);
        });
        const github = yield* GitHubApp.make({
          appId: "123",
          installationId: 42,
          privateKey,
          repo,
          apiUrl: http.url,
          author: { name: "caldero", email: "bot@example.com" },
        });
        const files = yield* github.fetchSource(repo, "base-1");
        expect(files.map((file) => ({ ...file, content: [...file.content] }))).toEqual([
          {
            path: "bin/run",
            executable: true,
            content: [35, 33, 47, 98, 105, 110, 47, 115, 104, 10],
          },
          { path: "logo.bin", executable: false, content: [0, 255, 1, 254] },
        ]);
        expect(JSON.parse(tokenBody)).toEqual({
          repositories: ["app"],
          permissions: { contents: "write", pull_requests: "write", issues: "write" },
        });
        const jwt = auth[0]?.slice("Bearer ".length) ?? "";
        const [header, payload, signature] = jwt.split(".");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            keys.publicKey,
            Buffer.from(signature ?? "", "base64url"),
          ),
        ).toBe(true);
        expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
          iss: "123",
        });
        expect(auth.slice(1).every((value) => value === "Bearer installation-token")).toBe(true);
        expect(calls).toContain("GET /repos/acme/app/git/trees/base-tree?recursive=1");
      }),
  );
});
