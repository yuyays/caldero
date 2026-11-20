import { Repo, SessionState } from "@caldero/domain";
import { Schema } from "effect";

/** Optional live observation of the current GitHub PR head. */
export const PullRequestCi = Schema.Struct({
  status: Schema.Literals(["no-pr", "none", "pending", "passing", "failing", "unavailable"]),
  headSha: Schema.NullOr(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      workflow: Schema.NullOr(Schema.String),
      status: Schema.Literals(["pending", "passing", "failing", "neutral", "cancelled"]),
      url: Schema.NullOr(Schema.String),
    }),
  ),
  totalChecks: Schema.Int,
  checksUrl: Schema.NullOr(Schema.String),
  detailsTruncated: Schema.Boolean,
  counts: Schema.NullOr(
    Schema.Struct({
      checkRuns: Schema.Record(Schema.String, Schema.Int),
      statusContexts: Schema.Record(Schema.String, Schema.Int),
    }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type PullRequestCi = typeof PullRequestCi.Type;

/** Saved local execution state, suitable for a CLI or a future authenticated UI. */
export const LocalSessionStatus = Schema.Struct({
  issue: Schema.Int,
  source: Schema.Literals(["session", "queued", "uninitialized", "missing", "unavailable"]),
  state: Schema.NullOr(SessionState),
  error: Schema.NullOr(Schema.String),
  ci: Schema.optionalKey(PullRequestCi),
});
export type LocalSessionStatus = typeof LocalSessionStatus.Type;

export const LocalStatus = Schema.Struct({
  repo: Repo,
  stateRoot: Schema.String,
  watcher: Schema.Struct({
    lock: Schema.Literals(["held", "free", "unknown"]),
    pid: Schema.NullOr(Schema.Int),
    error: Schema.NullOr(Schema.String),
  }),
  sessions: Schema.Array(LocalSessionStatus),
  warnings: Schema.Array(Schema.String),
});
export type LocalStatus = typeof LocalStatus.Type;
