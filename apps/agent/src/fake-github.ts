import { Effect, Layer } from "effect";
import {
  branchName,
  GitHub,
  GitHubError,
  type Patch,
  PublishError,
  type PullRequest,
  type SourceFile,
} from "./ports.ts";

/** Everything the fake GitHub holds, for assertions. */
export interface FakeGitHubState {
  readonly branches: Map<string, string>;
  readonly pullRequests: Array<PullRequest & { readonly branch: string; readonly patch: Patch }>;
  readonly comments: Array<{ readonly issue: number; readonly key: string; readonly text: string }>;
}

/**
 * An in-memory GitHub. `publish` lands a candidate on its branch and opens one PR per branch; `afterPublish` runs
 * once the PR exists and before the call returns, so a test can crash the host there or make the response go missing.
 */
export const makeFakeGitHub = (options: {
  readonly source: ReadonlyArray<SourceFile>;
  readonly afterPublish?: () => void;
  /** Answer the next publish this many times with a failure of this kind after it landed. */
  /** Fail reconciliation before inspecting remote state, as a temporary GitHub outage would. */
  readonly failReconcile?: { times: number };
  readonly dropResponses?: { readonly kind: "retryable" | "ambiguous"; times: number };
  /** Branches that already exist, by name, with the digest of what they hold. */
  readonly branches?: ReadonlyArray<readonly [string, string]>;
}) => {
  const state: FakeGitHubState = {
    branches: new Map(options.branches),
    pullRequests: [],
    comments: [],
  };
  const service = GitHub.of({
    fetchIssueContext: Effect.fn("FakeGitHub.fetchIssueContext")(function* () {
      return { baseRef: "main", baseSha: "base-1", context: "Write the notes." };
    }),
    fetchSource: Effect.fn("FakeGitHub.fetchSource")(function* () {
      return options.source;
    }),
    publish: Effect.fn("FakeGitHub.publish")(function* (issue, binding, patch) {
      const branch = branchName(issue, binding);
      const existing = state.branches.get(branch);
      if (existing !== undefined && existing !== patch.digest)
        return yield* new PublishError({
          kind: "permanent",
          message: `branch conflict on ${branch}`,
        });
      state.branches.set(branch, patch.digest);
      let pullRequest = state.pullRequests.find((candidate) => candidate.branch === branch);
      if (pullRequest === undefined) {
        const number = state.pullRequests.length + 100;
        pullRequest = { number, url: `https://github.test/pull/${number}`, branch, patch };
        state.pullRequests.push(pullRequest);
      }
      options.afterPublish?.();
      const drop = options.dropResponses;
      if (drop !== undefined && drop.times > 0) {
        drop.times -= 1;
        return yield* new PublishError({ kind: drop.kind, message: "response lost" });
      }
      return { number: pullRequest.number, url: pullRequest.url };
    }),
    reconcile: Effect.fn("FakeGitHub.reconcile")(function* (issue, binding) {
      if (options.failReconcile !== undefined && options.failReconcile.times > 0) {
        options.failReconcile.times -= 1;
        return yield* new GitHubError({ message: "reconciliation unavailable" });
      }
      const branch = branchName(issue, binding);
      const digest = state.branches.get(branch);
      if (digest === undefined) return { found: "nothing" } as const;
      if (digest !== binding.patchDigest)
        return { found: "conflict", message: `branch conflict on ${branch}` } as const;
      const pullRequest = state.pullRequests.find((candidate) => candidate.branch === branch);
      if (pullRequest === undefined) return { found: "nothing" } as const;
      return {
        found: "pullRequest",
        pullRequest: { number: pullRequest.number, url: pullRequest.url },
      } as const;
    }),
    comment: Effect.fn("FakeGitHub.comment")(function* (_repo, issue, key, text) {
      if (!state.comments.some((comment) => comment.key === key))
        state.comments.push({ issue, key, text });
    }),
  });
  return { state, layer: Layer.succeed(GitHub, service) };
};
