import { Repo, SessionState } from "@puchero/domain";
import { Schema } from "effect";

export const PullRequestCi = Schema.Struct({
  status: Schema.Literals(["none", "pending", "passing", "failing", "unavailable"]),
  headSha: Schema.NullOr(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["pending", "passing", "failing", "neutral"]),
      url: Schema.NullOr(Schema.String),
    }),
  ),
  totalChecks: Schema.Int,
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
