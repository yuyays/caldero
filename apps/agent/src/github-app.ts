import { createPrivateKey, sign } from "node:crypto";
import type { ApprovalBinding, Repo } from "@puchero/domain";
import { Clock, DateTime, Effect, Layer, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import {
  branchName,
  GitHub,
  GitHubError,
  PublishError,
  type PublishJournal,
  type PublishProgress,
  type Patch,
  type SourceFile,
} from "./ports.ts";

export interface GitHubAppOptions {
  readonly appId: string;
  readonly installationId: number;
  readonly privateKey: string;
  readonly repo: Repo;
  readonly author: { readonly name: string; readonly email: string };
  /** GitHub Enterprise API root, or an HTTP peer in contract tests. */
  readonly apiUrl?: string;
}

class HttpFailure extends Schema.TaggedError<HttpFailure>()("HttpFailure", {
  status: Schema.Int,
  message: Schema.String,
  rateLimited: Schema.optionalKey(Schema.Boolean),
}) {}

const tokenResponse = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }));
const commitResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ sha: Schema.String, tree: Schema.Struct({ sha: Schema.String }) }),
);
const treeResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    truncated: Schema.Boolean,
    tree: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        mode: Schema.String,
        type: Schema.String,
        sha: Schema.String,
      }),
    ),
  }),
);
const blobResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ encoding: Schema.Literal("base64"), content: Schema.String }),
);
const shaResponse = Schema.decodeUnknownEffect(Schema.Struct({ sha: Schema.String }));
const refResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) }),
);
const prSchema = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  head: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
});
const prResponse = Schema.decodeUnknownEffect(prSchema);
const prsResponse = Schema.decodeUnknownEffect(Schema.Array(prSchema));
const repoResponse = Schema.decodeUnknownEffect(Schema.Struct({ default_branch: Schema.String }));
const issueResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    title: Schema.String,
    body: Schema.NullOr(Schema.String),
    html_url: Schema.String,
  }),
);
const commentsResponse = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ body: Schema.String })),
);
const labeledIssuesResponse = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      pull_request: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const githubError = (error: HttpFailure) => new GitHubError({ message: error.message });
const readError = (error: HttpFailure | GitHubError | Schema.SchemaError) =>
  error instanceof GitHubError
    ? error
    : error instanceof HttpFailure
      ? githubError(error)
      : new GitHubError({ message: "Invalid GitHub response" });
const segment = encodeURIComponent;
const bindingKey = (binding: ApprovalBinding) =>
  JSON.stringify([
    binding.sessionId,
    binding.version,
    binding.runId,
    binding.repo.owner,
    binding.repo.name,
    binding.baseRef,
    binding.baseSha,
    binding.patchDigest,
  ]);
const validPath = (path: string) =>
  !path.includes("\\") &&
  !path.includes("\0") &&
  path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

const publishError = (error: HttpFailure | GitHubError | PublishError | Schema.SchemaError) =>
  error instanceof PublishError
    ? error
    : new PublishError({
        kind:
          error instanceof HttpFailure && (error.status === 429 || error.rateLimited === true)
            ? "retryable"
            : error instanceof HttpFailure &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 429
              ? "permanent"
              : "ambiguous",
        message:
          error instanceof Schema.SchemaError ? "Invalid GitHub publish response" : error.message,
      });

/** HTTP is the external seam: cancellation covers both the request and response body. Never follow token-bearing redirects. */
const request = Effect.fn("GitHubApp.request")(function* (
  root: string,
  token: string,
  path: string,
  body?: object,
) {
  const method = body === undefined ? "GET" : "POST";
  return yield* Effect.tryPromise({
    try: (signal) =>
      fetch(`${root}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "puchero",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      }).then(async (response): Promise<unknown> => {
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpFailure({
            status: response.status,
            message: `GitHub ${method} ${path}: HTTP ${response.status}`,
            rateLimited:
              response.status === 429 ||
              (response.status === 403 &&
                (response.headers.has("retry-after") ||
                  response.headers.get("x-ratelimit-remaining") === "0")),
          });
        }
        return response.json();
      }),
    catch: (error) =>
      error instanceof HttpFailure
        ? error
        : new HttpFailure({
            status: 0,
            message: `GitHub ${method} ${path}: request or response failed`,
          }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(new HttpFailure({ status: 0, message: `GitHub ${method} ${path}: timed out` })),
    }),
  );
});

/** App credentials stay in the host. Every public operation mints a fresh repository-scoped installation token. */
const make = Effect.fn("GitHubApp.make")(function* (options: GitHubAppOptions) {
  const signingKey = yield* Effect.try({
    try: () => createPrivateKey(options.privateKey),
    catch: () => new GitHubError({ message: "Invalid GitHub App private key" }),
  });
  const root = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const prefix = `/repos/${segment(options.repo.owner)}/${segment(options.repo.name)}`;
  const client = Effect.fn("GitHubApp.client")(function* (repo: Repo) {
    if (repo.owner !== options.repo.owner || repo.name !== options.repo.name)
      return yield* new HttpFailure({
        status: 403,
        message: "Repository is outside the configured installation scope",
      });
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: options.appId, iat: now - 60, exp: now + 540 }),
    ).toString("base64url");
    const jwt = yield* Effect.try({
      try: () =>
        `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), signingKey).toString("base64url")}`,
      catch: () => new HttpFailure({ status: 0, message: "Could not sign GitHub App JWT" }),
    });
    const data = yield* request(
      root,
      jwt,
      `/app/installations/${options.installationId}/access_tokens`,
      {
        repositories: [repo.name],
        permissions: { contents: "write", pull_requests: "write", issues: "write" },
      },
    );
    const token = yield* tokenResponse(data).pipe(
      Effect.mapError(
        () => new HttpFailure({ status: 0, message: "Invalid installation token response" }),
      ),
    );
    return (path: string, body?: object) => request(root, token.token, `${prefix}${path}`, body);
  });

  type Api = Effect.Success<ReturnType<typeof client>>;
  const comments = Effect.fn("GitHubApp.comments")(function* (api: Api, issue: number) {
    const result: Array<{ readonly body: string }> = [];
    for (let page = 1; ; page++) {
      const items = yield* commentsResponse(
        yield* api(`/issues/${issue}/comments?per_page=100&page=${page}`),
      );
      result.push(...items);
      if (items.length < 100) return result;
    }
  });
  const readRef = Effect.fn("GitHubApp.readRef")(function* (api: Api, ref: string) {
    const data = yield* api(`/git/ref/heads/${segment(ref)}`).pipe(
      Effect.catchTag("HttpFailure", (error) =>
        error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
    return data === null ? null : (yield* refResponse(data)).object.sha;
  });
  /** A new publication cannot silently retarget a validated candidate to a changed base branch. */
  const requireCandidateBase = Effect.fn("GitHubApp.requireCandidateBase")(
    (api: Api, binding: ApprovalBinding) =>
      readRef(api, binding.baseRef).pipe(
        Effect.filterOrFail(
          (sha) => sha === binding.baseSha,
          () =>
            new PublishError({
              kind: "permanent",
              message: "Base branch moved since validation; publication stopped",
            }),
        ),
        Effect.asVoid,
      ),
  );
  const load = Effect.fn("GitHubApp.loadJournal")(function* (
    issue: number,
    binding: ApprovalBinding,
    journal: PublishJournal,
  ) {
    const saved = yield* journal.read();
    if (
      saved !== null &&
      (bindingKey(saved.binding) !== bindingKey(binding) || saved.issue !== issue)
    )
      return yield* new PublishError({
        kind: "permanent",
        message: "Publish journal does not match the validated binding",
      });
    return saved;
  });

  /** Reconcile before creating: even closed PRs count, and an existing branch is never overwritten. */
  const finish = Effect.fn("GitHubApp.finish")(function* (
    api: Api,
    progress: PublishProgress,
    journal: PublishJournal,
  ) {
    const branch = branchName(progress.issue, progress.binding);
    const remote = yield* readRef(api, branch);
    if (remote !== progress.commitSha)
      return yield* new PublishError({
        kind: "permanent",
        message: `branch conflict on ${branch}`,
      });
    if (progress.pullRequest !== null) return progress.pullRequest;
    const find = Effect.fn("GitHubApp.findPullRequest")(function* () {
      for (let page = 1; ; page++) {
        const prs = yield* prsResponse(
          yield* api(
            `/pulls?state=all&head=${segment(`${progress.binding.repo.owner}:${branch}`)}&per_page=100&page=${page}`,
          ),
        );
        for (const pr of prs) {
          if (pr.head.ref !== branch) continue;
          if (pr.head.sha !== progress.commitSha || pr.base.ref !== progress.binding.baseRef)
            return yield* new PublishError({
              kind: "permanent",
              message: `Pull request conflicts with the validated binding on ${branch}`,
            });
          return { number: pr.number, url: pr.html_url };
        }
        if (prs.length < 100) return null;
      }
    });
    let pullRequest = yield* find();
    if (pullRequest === null) {
      yield* requireCandidateBase(api, progress.binding);
      pullRequest = yield* api("/pulls", {
        title: progress.title,
        body: progress.body,
        head: branch,
        base: progress.binding.baseRef,
      }).pipe(
        Effect.flatMap(prResponse),
        Effect.map((pr) => ({ number: pr.number, url: pr.html_url })),
        Effect.catchTag("HttpFailure", (error) =>
          error.status !== 422
            ? Effect.fail(error)
            : find().pipe(
                Effect.filterOrFail(
                  (found) => found !== null,
                  () => error,
                ),
              ),
        ),
      );
    }
    yield* journal.save({ ...progress, refCreated: true, pullRequest });
    return pullRequest;
  });
  const github = GitHub.of({
    fetchIssueContext: Effect.fn("GitHubApp.fetchIssueContext")(function* (
      repo: Repo,
      issue: number,
    ) {
      const api = yield* client(repo);
      const repository = yield* repoResponse(yield* api(""));
      const baseRef = repository.default_branch;
      const baseSha = yield* readRef(api, baseRef);
      if (baseSha === null)
        return yield* new GitHubError({ message: "Repository default branch does not exist" });
      const details = yield* issueResponse(yield* api(`/issues/${issue}`));
      const discussion = yield* comments(api, issue);
      const agentsData = yield* api(`/contents/AGENTS.md?ref=${segment(baseSha)}`).pipe(
        Effect.catchTag("HttpFailure", (error) =>
          error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
      let agents = "";
      if (agentsData !== null) {
        const file = yield* blobResponse(agentsData);
        const bytes = Base64.decode(file.content.replace(/\s/g, ""));
        if (Result.isFailure(bytes))
          return yield* new GitHubError({ message: "Invalid base64 AGENTS.md" });
        agents = new TextDecoder().decode(bytes.success);
      }
      return {
        baseRef,
        baseSha,
        context: `GitHub issue ${details.html_url}\nRepository: ${repo.owner}/${repo.name}\nBase: ${baseRef} at ${baseSha}\n\n# ${details.title}\n${details.body ?? ""}\n\n## Comments\n${discussion.map((comment) => comment.body).join("\n\n")}\n\n## Repository AGENTS.md\n${agents}`,
      };
    }, Effect.mapError(readError)),

    comment: Effect.fn("GitHubApp.comment")(function* (
      repo: Repo,
      issue: number,
      key: string,
      text: string,
    ) {
      const api = yield* client(repo);
      const marker = `<!-- puchero:${Buffer.from(key).toString("base64url")} -->`;
      if (
        (yield* comments(api, issue)).some((comment) => comment.body.split("\n").includes(marker))
      )
        return;
      yield* api(`/issues/${issue}/comments`, { body: `${text}\n\n${marker}` });
    }, Effect.mapError(readError)),
    fetchSource: Effect.fn("GitHubApp.fetchSource")(
      function* (repo: Repo, sha: string) {
        const api = yield* client(repo);
        const commit = yield* commitResponse(yield* api(`/git/commits/${segment(sha)}`));
        const tree = yield* treeResponse(
          yield* api(`/git/trees/${segment(commit.tree.sha)}?recursive=1`),
        );
        if (tree.truncated)
          return yield* new GitHubError({
            message: "Repository tree is truncated; refusing an incomplete workspace",
          });
        return yield* Effect.forEach(
          tree.tree.filter((entry) => entry.type !== "tree"),
          (entry) =>
            Effect.gen(function* () {
              if (
                !validPath(entry.path) ||
                entry.type !== "blob" ||
                !["100644", "100755"].includes(entry.mode)
              )
                return yield* new GitHubError({
                  message: `Unsupported repository entry: ${entry.path} (${entry.mode})`,
                });
              const blob = yield* blobResponse(yield* api(`/git/blobs/${segment(entry.sha)}`));
              const bytes = Base64.decode(blob.content.replace(/\s/g, ""));
              if (Result.isFailure(bytes))
                return yield* new GitHubError({ message: `Invalid base64 blob: ${entry.path}` });
              return {
                path: entry.path,
                content: bytes.success,
                executable: entry.mode === "100755",
              } satisfies SourceFile;
            }),
          { concurrency: 8 },
        );
      },
      Effect.mapError((error) =>
        error instanceof GitHubError
          ? error
          : error instanceof HttpFailure
            ? githubError(error)
            : new GitHubError({ message: "Invalid GitHub source response" }),
      ),
    ),

    publish: Effect.fn("GitHubApp.publish")(function* (
      issue: number,
      binding: ApprovalBinding,
      patch: Patch,
      journal: PublishJournal,
    ) {
      if (
        patch.digest !== binding.patchDigest ||
        patch.files.some((file) => !validPath(file.path)) ||
        new Set(patch.files.map((file) => file.path)).size !== patch.files.length
      )
        return yield* new PublishError({
          kind: "permanent",
          message: "Patch does not match the validated candidate or has invalid paths",
        });
      let progress = yield* load(issue, binding, journal);
      if (progress === null) {
        const date = DateTime.formatIso(yield* DateTime.now);
        progress = {
          binding,
          issue,
          author: { ...options.author, date },
          message: `puchero: issue #${issue} version ${binding.version}\n\nPatch: ${binding.patchDigest}`,
          title: `Resolve #${issue} (agent v${binding.version})`,
          body: `Closes #${issue}\n\nValidated patch: ${binding.patchDigest}\nBase: ${binding.baseRef} at ${binding.baseSha}`,
          baseTree: null,
          blobs: null,
          treeSha: null,
          commitSha: null,
          refCreated: false,
          pullRequest: null,
        };
        yield* journal.save(progress);
      }
      const api = yield* client(binding.repo);
      if (progress.baseTree === null) {
        const commit = yield* commitResponse(
          yield* api(`/git/commits/${segment(binding.baseSha)}`),
        );
        progress = { ...progress, baseTree: commit.tree.sha };
        yield* journal.save(progress);
      }
      if (progress.blobs === null) {
        const blobs = yield* Effect.forEach(
          patch.files.filter((file) => file.change === "write"),
          (file) =>
            api("/git/blobs", { content: file.content, encoding: "base64" }).pipe(
              Effect.flatMap(shaResponse),
              Effect.map((blob) => ({ path: file.path, sha: blob.sha })),
            ),
        );
        progress = { ...progress, blobs };
        yield* journal.save(progress);
      }
      if (progress.treeSha === null) {
        const blobs = new Map((progress.blobs ?? []).map((blob) => [blob.path, blob.sha]));
        const tree = yield* shaResponse(
          yield* api("/git/trees", {
            base_tree: progress.baseTree,
            tree: patch.files.map((file) => ({
              path: file.path,
              mode: file.change === "write" && file.executable ? "100755" : "100644",
              type: "blob",
              sha: file.change === "delete" ? null : blobs.get(file.path),
            })),
          }),
        );
        progress = { ...progress, treeSha: tree.sha };
        yield* journal.save(progress);
      }
      if (progress.commitSha === null) {
        const commit = yield* shaResponse(
          yield* api("/git/commits", {
            message: progress.message,
            tree: progress.treeSha,
            parents: [binding.baseSha],
            author: progress.author,
            committer: progress.author,
          }),
        );
        progress = { ...progress, commitSha: commit.sha };
        yield* journal.save(progress);
      }
      const branch = branchName(issue, binding);
      const expectedCommit = progress.commitSha;
      const remote = yield* readRef(api, branch);
      if (remote !== null && remote !== progress.commitSha)
        return yield* new PublishError({
          kind: "permanent",
          message: `branch conflict on ${branch}`,
        });
      if (remote === null) {
        if (progress.refCreated)
          return yield* new PublishError({
            kind: "permanent",
            message: `Published branch was removed: ${branch}`,
          });
        yield* requireCandidateBase(api, binding);
        yield* api("/git/refs", { ref: `refs/heads/${branch}`, sha: expectedCommit }).pipe(
          Effect.catchTag("HttpFailure", (error) =>
            error.status !== 422
              ? Effect.fail(error)
              : readRef(api, branch).pipe(
                  Effect.flatMap((sha) =>
                    sha === expectedCommit
                      ? Effect.succeed(null)
                      : Effect.fail(
                          new PublishError({
                            kind: "permanent",
                            message: `branch conflict on ${branch}`,
                          }),
                        ),
                  ),
                ),
          ),
        );
      }
      if (!progress.refCreated) {
        progress = { ...progress, refCreated: true };
        yield* journal.save(progress);
      }
      return yield* finish(api, progress, journal);
    }, Effect.mapError(publishError)),

    reconcile: Effect.fn("GitHubApp.reconcile")(
      function* (issue: number, binding: ApprovalBinding, journal: PublishJournal) {
        const progress = yield* load(issue, binding, journal);
        if (progress?.commitSha == null) return { found: "nothing" } as const;
        const api = yield* client(binding.repo);
        const remote = yield* readRef(api, branchName(issue, binding));
        if (remote === null)
          return progress.refCreated
            ? ({ found: "conflict", message: "Published branch was removed" } as const)
            : ({ found: "nothing" } as const);
        if (remote !== progress.commitSha)
          return {
            found: "conflict",
            message: `branch conflict on ${branchName(issue, binding)}`,
          } as const;
        return yield* finish(api, progress, journal).pipe(
          Effect.map((pullRequest) => ({ found: "pullRequest", pullRequest }) as const),
        );
      },
      Effect.catchTag("PublishError", (error) =>
        Effect.succeed({ found: "conflict", message: error.message } as const),
      ),
      Effect.mapError((error) =>
        error instanceof GitHubError
          ? error
          : error instanceof HttpFailure
            ? githubError(error)
            : new GitHubError({ message: "Invalid GitHub reconciliation response" }),
      ),
    ),
  });
  return {
    ...github,
    /** Host-only discovery stays outside the session's GitHub port. REST also lists PRs here. */
    listOpenLabeledIssues: Effect.fn("GitHubApp.listOpenLabeledIssues")(
      function* (label: string) {
        const api = yield* client(options.repo);
        const issues: number[] = [];
        for (let page = 1; ; page++) {
          const rows = yield* labeledIssuesResponse(
            yield* api(
              `/issues?state=open&labels=${segment(label)}&sort=created&direction=asc&per_page=100&page=${page}`,
            ),
          );
          issues.push(
            ...rows.filter((row) => row.pull_request === undefined).map((row) => row.number),
          );
          if (rows.length < 100) return [...new Set(issues)];
        }
      },
      Effect.mapError(
        (error) =>
          new GitHubError({
            message:
              error instanceof HttpFailure
                ? error.message
                : "Invalid GitHub issue discovery response",
          }),
      ),
    ),
  };
});

export const GitHubApp = {
  make,
  layer: (options: GitHubAppOptions) => Layer.effect(GitHub, make(options)),
};
