import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ApprovalBinding, Repo, SessionState } from "@puchero/domain";
import { Context, type Effect, Schema } from "effect";

/** A failure's message, for errors that cross into a typed error or a stored outcome. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One changed file of a patch. Content is base64 so binary files survive JSON. */
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

/** A frozen change set against the session's base commit. `digest` names it in approvals. */
export const Patch = Schema.Struct({
  digest: Schema.String,
  /** Human-readable `git diff` of the change set, for the inbox. */
  diff: Schema.String,
  files: Schema.Array(FileChange),
});
export type Patch = typeof Patch.Type;

/** The result of validating the workspace: a frozen patch and what the checks printed. */
export interface Validation {
  readonly passed: boolean;
  readonly patch: Patch;
  readonly evidence: string;
}

/** A file of the repository at the base commit. */
export interface SourceFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

/**
 * The agent's sandbox for one session. Every method is idempotent: a task that crashed after calling it calls it again.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** The environment Pi's coding tools run in. */
    readonly env: () => ExecutionEnv;
    /** Make the workspace hold `repo` at `baseSha`; does nothing once it does. */
    readonly prepare: (repo: Repo, baseSha: string) => Effect.Effect<void, WorkspaceError>;
    /** Freeze the current change set, run the checks against the frozen copy, and keep the patch. */
    readonly validate: () => Effect.Effect<Validation, WorkspaceError>;
    /** A patch an earlier `validate` froze. */
    readonly patch: (digest: string) => Effect.Effect<Patch, WorkspaceError>;
    /** Stop every command still running in the workspace. */
    readonly quiesce: () => Effect.Effect<void, WorkspaceError>;
  }
>()("puchero/Workspace") {}

export const PullRequest = Schema.Struct({ number: Schema.Int, url: Schema.String });
export type PullRequest = typeof PullRequest.Type;

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

/** Why a publish failed; `ambiguous` means it may have landed and must be reconciled, not repeated. */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  kind: Schema.Literals(["retryable", "permanent", "ambiguous"]),
  message: Schema.String,
}) {}

/** What reconciling an ambiguous publish found on GitHub. */
export type ReconcileResult =
  | { readonly found: "pullRequest"; readonly pullRequest: PullRequest }
  | { readonly found: "nothing" }
  | { readonly found: "conflict"; readonly message: string };

/** The branch a candidate is published on. */
export const branchName = (issue: number, binding: ApprovalBinding) =>
  `puchero/${issue}-v${binding.version}`;

/** GitHub, as the session sees it. Publishing and commenting are idempotent per binding and key. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly fetchSource: (
      repo: Repo,
      sha: string,
    ) => Effect.Effect<ReadonlyArray<SourceFile>, GitHubError>;
    readonly publish: (
      issue: number,
      binding: ApprovalBinding,
      patch: Patch,
    ) => Effect.Effect<PullRequest, PublishError>;
    readonly reconcile: (
      issue: number,
      binding: ApprovalBinding,
    ) => Effect.Effect<ReconcileResult, GitHubError>;
    readonly comment: (
      repo: Repo,
      issue: number,
      key: string,
      text: string,
    ) => Effect.Effect<void, GitHubError>;
  }
>()("puchero/GitHub") {}

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
  message: Schema.String,
}) {}

/** The session index the inbox lists. Keeps a session's newest revision; older ones are ignored. */
export class Projection extends Context.Service<
  Projection,
  { readonly project: (state: SessionState) => Effect.Effect<void, ProjectionError> }
>()("puchero/Projection") {}
