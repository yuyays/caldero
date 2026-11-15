import { ApprovalBinding, Repo, SessionState, Status } from "@puchero/domain";
import { Schema } from "effect";

/** A file's immutable contents; base64 preserves binary data in stored patches. */
export const FileChange = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    change: Schema.Literal("write"),
    content: Schema.String,
    executable: Schema.Boolean,
  }),
  Schema.Struct({ path: Schema.String, change: Schema.Literal("delete") }),
]);
export type FileChange = typeof FileChange.Type;
export const Patch = Schema.Struct({
  digest: Schema.String,
  diff: Schema.String,
  files: Schema.Array(FileChange),
});
export type Patch = typeof Patch.Type;

/** Rebuildable index fields only; patch data and validation evidence remain in the authoritative session. */
export const SessionSummary = Schema.Struct({
  sessionId: Schema.String,
  repo: Repo,
  issue: Schema.Int,
  status: Status,
  revision: Schema.Int,
  version: Schema.Int,
  runId: Schema.Int,
  baseSha: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  patchDigest: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(Schema.Struct({ number: Schema.Int, url: Schema.String })),
  decidedBy: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  updatedAt: Schema.Finite,
});
export type SessionSummary = typeof SessionSummary.Type;
export const summarizeSession = (state: typeof SessionState.Type): SessionSummary => ({
  sessionId: state.sessionId,
  repo: state.repo,
  issue: state.issue,
  status: state.status,
  revision: state.revision,
  version: state.version,
  runId: state.runId,
  baseSha: state.baseSha,
  baseRef: state.baseRef,
  patchDigest: state.candidate?.binding.patchDigest ?? null,
  pullRequest: state.pullRequest,
  decidedBy: state.decidedBy,
  failure: state.failure,
  updatedAt: state.updatedAt,
});
export const AuditEntry = Schema.Struct({
  instructionId: Schema.String,
  sessionId: Schema.String,
  revision: Schema.Int,
  status: Status,
  actor: Schema.NullOr(Schema.String),
  updatedAt: Schema.Finite,
});
export type AuditEntry = typeof AuditEntry.Type;
export const SessionView = Schema.Struct({
  state: SessionState,
  patch: Schema.NullOr(Patch),
  patchUnavailable: Schema.optionalKey(Schema.Boolean),
});
export type SessionView = typeof SessionView.Type;
export const SessionDetail = Schema.Struct({
  view: SessionView,
  audit: Schema.Array(AuditEntry),
  auditUnavailable: Schema.optionalKey(Schema.Boolean),
});
export type SessionDetail = typeof SessionDetail.Type;
export const DecisionResponse = Schema.Struct({
  result: Schema.Literals(["applied", "duplicate"]),
  view: SessionView,
});
export const DecisionRequest = Schema.Struct({
  binding: ApprovalBinding,
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export const CancelRequest = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export const InputRequest = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export class InboxUnauthorized extends Schema.TaggedError<InboxUnauthorized>()(
  "InboxUnauthorized",
  { message: Schema.String },
) {}
export class InboxForbidden extends Schema.TaggedError<InboxForbidden>()("InboxForbidden", {
  message: Schema.String,
}) {}
export class InboxNotFound extends Schema.TaggedError<InboxNotFound>()("InboxNotFound", {
  message: Schema.String,
}) {}
export class InboxUnavailable extends Schema.TaggedError<InboxUnavailable>()("InboxUnavailable", {
  message: Schema.String,
}) {}
export class StaleDecision extends Schema.TaggedError<StaleDecision>()("StaleDecision", {
  message: Schema.String,
  view: SessionView,
}) {}
export class InboxMediaType extends Schema.TaggedError<InboxMediaType>()("InboxMediaType", {
  message: Schema.String,
}) {}
