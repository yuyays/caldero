import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestCi } from "@puchero/contracts/local-status";
import type { Repo } from "@puchero/domain";
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
                nodes {
                  kind: __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
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
  }),
  Schema.Struct({
    kind: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: State,
    targetUrl: Schema.NullOr(Schema.String),
  }),
]);
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

const unavailable = (error: string): PullRequestCi => ({
  status: "unavailable",
  headSha: null,
  checks: [],
  totalChecks: 0,
  error,
});

const exec = promisify(execFile);
const safeLink = (url: string | null) =>
  url && URL.canParse(url) && ["https:", "http:"].includes(new URL(url).protocol) ? url : null;

/** Read one PR's head and GitHub's aggregate together. CLI authentication belongs to the operator. */
export const readPullRequestCi = Effect.fn("readPullRequestCi")(function* (
  repo: Repo,
  number: number,
) {
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
          signal,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        },
      ),
    catch: () =>
      "GitHub CI could not be fetched. Check gh auth status and access to this repository.",
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
      if (!rollup || rollup.contexts.totalCount === 0)
        return { status: "none", headSha: commit.oid, checks: [], totalChecks: 0, error: null };
      const checks = rollup.contexts.nodes.map((check): PullRequestCi["checks"][number] => {
        if (check.kind === "StatusContext")
          return {
            name: check.context,
            status: statusOf[check.state],
            url: safeLink(check.targetUrl),
          };
        const status =
          check.status !== "COMPLETED" || check.conclusion === null
            ? "pending"
            : check.conclusion === "SUCCESS"
              ? "passing"
              : ["NEUTRAL", "SKIPPED"].includes(check.conclusion)
                ? "neutral"
                : "failing";
        return { name: check.name, status, url: safeLink(check.detailsUrl) };
      });
      return {
        status: statusOf[rollup.state],
        headSha: commit.oid,
        checks,
        totalChecks: rollup.contexts.totalCount,
        error: null,
      };
    }),
    Effect.catch((message) => Effect.succeed(unavailable(message))),
  );
});
