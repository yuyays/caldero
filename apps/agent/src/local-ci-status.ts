import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestCi } from "@caldero/contracts/local-status";
import type { Repo } from "@caldero/domain";
import { Effect, Schema } from "effect";

const query = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        commits(last: 1) {
          nodes { commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                checkRunCountsByState { state count }
                statusContextCountsByState { state count }
                nodes {
                  kind: __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl startedAt
                    checkSuite { app { id } workflowRun { event workflow { id name } } }
                  }
                  ... on StatusContext { context state targetUrl createdAt }
                }
              }
            }
          } }
        }
      }
    }
  }
`;

const State = Schema.Literals(["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"]);
const Check = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
    startedAt: Schema.NullOr(Schema.String),
    checkSuite: Schema.NullOr(
      Schema.Struct({
        app: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        workflowRun: Schema.NullOr(
          Schema.Struct({
            event: Schema.String,
            workflow: Schema.Struct({ id: Schema.String, name: Schema.String }),
          }),
        ),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: State,
    targetUrl: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
  }),
]);
type GitHubCheck = typeof Check.Type;
const StateCounts = Schema.Array(Schema.Struct({ state: Schema.String, count: Schema.Int }));
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            headRefOid: Schema.String,
            commits: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  commit: Schema.Struct({
                    oid: Schema.String,
                    statusCheckRollup: Schema.NullOr(
                      Schema.Struct({
                        state: State,
                        contexts: Schema.Struct({
                          totalCount: Schema.Int,
                          checkRunCountsByState: StateCounts,
                          statusContextCountsByState: StateCounts,
                          nodes: Schema.Array(Check),
                        }),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          }),
        }),
      }),
    }),
  ),
);

const statusOf = {
  EXPECTED: "pending",
  ERROR: "failing",
  FAILURE: "failing",
  PENDING: "pending",
  SUCCESS: "passing",
} as const;

export const noPullRequestCi: PullRequestCi = {
  status: "no-pr",
  headSha: null,
  checks: [],
  totalChecks: 0,
  checksUrl: null,
  detailsTruncated: false,
  counts: null,
  error: null,
};

const exec = promisify(execFile);
const safeLink = (url: string | null) =>
  url && URL.canParse(url) && ["https:", "http:"].includes(new URL(url).protocol) ? url : null;

/** Choose the latest run per publisher, workflow, event and check name within the returned page. */
const latestChecks = (nodes: ReadonlyArray<GitHubCheck>) => {
  const latest = new Map<string, { check: GitHubCheck; time: string }>();
  for (const check of nodes) {
    const run = check.kind === "CheckRun" ? check.checkSuite?.workflowRun : null;
    const key = JSON.stringify(
      check.kind === "StatusContext"
        ? [check.kind, check.context]
        : [check.kind, check.checkSuite?.app?.id, run?.workflow.id, run?.event, check.name],
    );
    // An unstarted active run supersedes a completed attempt for the same check.
    const time =
      check.kind === "StatusContext"
        ? check.createdAt
        : (check.startedAt ?? (check.status === "COMPLETED" ? "" : "\uFFFF"));
    const previous = latest.get(key);
    if (!previous || time > previous.time) latest.set(key, { check, time });
  }
  return [...latest.values()].map(({ check }) => check);
};

const checkRunStatus = (
  check: Extract<GitHubCheck, { kind: "CheckRun" }>,
): PullRequestCi["checks"][number]["status"] => {
  if (check.status !== "COMPLETED") return "pending";
  switch (check.conclusion) {
    case "SUCCESS":
      return "passing";
    case "CANCELLED":
      return "cancelled";
    case "NEUTRAL":
    case "SKIPPED":
      return "neutral";
    case "OUTDATED":
    case "STALE":
    case null:
      return "pending";
    default:
      return "failing";
  }
};

/** Read one PR's head and GitHub's aggregate together. CLI authentication belongs to the operator. */
export const readPullRequestCi = Effect.fn("readPullRequestCi")(function* (
  repo: Repo,
  number: number,
) {
  const checksUrl = `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pull/${number}/checks`;
  const empty = { ...noPullRequestCi, checksUrl };
  const unavailable = (error: string): PullRequestCi => ({
    ...empty,
    status: "unavailable",
    error,
  });
  return yield* Effect.tryPromise({
    try: (signal) =>
      exec(
        "gh",
        [
          "api",
          "graphql",
          "--hostname",
          "github.com",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${repo.owner}`,
          "-f",
          `repo=${repo.name}`,
          "-F",
          `number=${number}`,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          signal,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
        },
      ),
    catch: (error) => {
      if (typeof error === "object" && error !== null) {
        if ("code" in error && error.code === "ENOENT")
          return "Install GitHub CLI (gh) to read PR checks.";
        if ("killed" in error && error.killed) return "GitHub CI lookup timed out.";
      }
      return "GitHub CI could not be fetched. Check gh auth status and access to this PR.";
    },
  }).pipe(
    Effect.flatMap(({ stdout }) =>
      decode(stdout).pipe(Effect.mapError(() => "GitHub returned an unreadable CI response.")),
    ),
    Effect.map(({ data }): PullRequestCi => {
      const pr = data.repository.pullRequest;
      const commit = pr.commits.nodes[0]?.commit;
      if (!commit || commit.oid !== pr.headRefOid)
        return unavailable("GitHub did not return checks for the current PR head. Try again.");
      const rollup = commit.statusCheckRollup;
      if (!rollup) return { ...empty, status: "none", headSha: commit.oid };
      const contexts = rollup.contexts;
      const checks = latestChecks(contexts.nodes).map((check): PullRequestCi["checks"][number] => {
        if (check.kind === "StatusContext")
          return {
            name: check.context,
            workflow: null,
            status: statusOf[check.state],
            url: safeLink(check.targetUrl),
          };
        return {
          name: check.name,
          workflow: check.checkSuite?.workflowRun?.workflow.name ?? null,
          status: checkRunStatus(check),
          url: safeLink(check.detailsUrl),
        };
      });
      return {
        status: statusOf[rollup.state],
        headSha: commit.oid,
        checks,
        totalChecks: contexts.totalCount,
        checksUrl,
        detailsTruncated: contexts.totalCount > contexts.nodes.length,
        counts: {
          checkRuns: Object.fromEntries(
            contexts.checkRunCountsByState.map(({ state, count }) => [state, count]),
          ),
          statusContexts: Object.fromEntries(
            contexts.statusContextCountsByState.map(({ state, count }) => [state, count]),
          ),
        },
        error: null,
      };
    }),
    Effect.catch((message) => Effect.succeed(unavailable(message))),
  );
});
