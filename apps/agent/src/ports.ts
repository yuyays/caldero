import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Patch } from "@caldero/contracts/inbox";
export { FileChange, Patch } from "@caldero/contracts/inbox";
import { ApprovalBinding, type PublicCheck, type Repo, type SessionState } from "@caldero/domain";
import { Context, type Effect, Schema } from "effect";

/** A failure's message, for errors that cross into a typed error or a stored outcome. */
export const errorMessage = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

/** The result of validating the workspace: a frozen patch and what the checks printed. */
export interface Validation {
  readonly passed: boolean;
  readonly patch: Patch;
  readonly evidence: string;
  readonly publicChecks?: ReadonlyArray<PublicCheck>;
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

export const Checkpoint = Schema.Struct({ number: Schema.Int, digest: Schema.String });
export type Checkpoint = typeof Checkpoint.Type;

/** Pi owns this journal; the workspace owns detecting and repairing a changed boot. */
export interface WorkspaceRecovery {
  readonly read: (signal: AbortSignal) => Effect.Effect<
    {
      readonly repo: Repo;
      readonly baseSha: string;
      readonly bootId: string | null;
      readonly checkpoint: Checkpoint | null;
    },
    WorkspaceError
  >;
  /** Atomically record the boot and admit the restoration steer, when present. */
  readonly restored: (
    bootId: string,
    notice: string | undefined,
    signal: AbortSignal,
  ) => Effect.Effect<void, WorkspaceError>;
}

/** Immutable blobs outside the sandbox, namespaced to one session. */
export class WorkspaceStore extends Context.Service<
  WorkspaceStore,
  {
    readonly put: (key: string, value: string) => Effect.Effect<void, WorkspaceError>;
    readonly get: (key: string) => Effect.Effect<string, WorkspaceError>;
  }
>()("caldero/WorkspaceStore") {}

/**
 * The agent's sandbox for one session. Every method is idempotent: a task that crashed after calling it calls it again.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** The environment Pi's coding tools run in. */
    readonly env: (recovery?: WorkspaceRecovery) => ExecutionEnv;
    /** Upload a complete change set before the caller commits its pointer. */
    readonly checkpoint: (number: number) => Effect.Effect<Checkpoint, WorkspaceError>;
    /** Make the workspace hold `repo` at `baseSha`; restart a repair from a clean checkout. */
    readonly prepare: (
      repo: Repo,
      baseSha: string,
      reset?: boolean,
    ) => Effect.Effect<void, WorkspaceError>;
    /** Freeze the current change set, run the checks against the frozen copy, and keep the patch. */
    readonly validate: () => Effect.Effect<Validation, WorkspaceError>;
    /** A patch an earlier `validate` froze. */
    readonly patch: (digest: string) => Effect.Effect<Patch, WorkspaceError>;
    /** Stop every command still running in the workspace. */
    readonly quiesce: () => Effect.Effect<void, WorkspaceError>;
  }
>()("caldero/Workspace") {}

export const PullRequest = Schema.Struct({ number: Schema.Int, url: Schema.String });
export type PullRequest = typeof PullRequest.Type;

/** Frozen publish intent and stage receipts. The host stores these outside the sandbox in Pi. */
export const PublishProgress = Schema.Struct({
  binding: ApprovalBinding,
  issue: Schema.Int,
  author: Schema.Struct({ name: Schema.String, email: Schema.String, date: Schema.String }),
  message: Schema.String,
  title: Schema.String,
  body: Schema.String,
  baseTree: Schema.NullOr(Schema.String),
  blobs: Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String, sha: Schema.String }))),
  treeSha: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  refCreated: Schema.Boolean,
  pullRequest: Schema.NullOr(PullRequest),
});
export type PublishProgress = typeof PublishProgress.Type;

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

/** Each save must commit before the adapter advances; failures stop the current operation. */
export interface PublishJournal {
  readonly read: () => Effect.Effect<PublishProgress | null, GitHubError>;
  readonly save: (progress: PublishProgress) => Effect.Effect<void, GitHubError>;
}

export interface IssueContext {
  readonly baseRef: string;
  readonly baseSha: string;
  readonly context: string;
}

/** Why a publish failed; `ambiguous` means it may have landed and must be reconciled, not repeated. */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  kind: Schema.Literals(["retryable", "permanent", "ambiguous"]),
  message: Schema.String,
}) {}

/** What recovery found. An expected branch without a PR may finish the journaled PR stage. */
export type ReconcileResult =
  | { readonly found: "pullRequest"; readonly pullRequest: PullRequest }
  | { readonly found: "nothing" }
  | { readonly found: "conflict"; readonly message: string };

/** The branch a candidate is published on. */
export const branchName = (issue: number, binding: ApprovalBinding) =>
  `caldero/${issue}-v${binding.version}`;

/** GitHub, as the session sees it. Publishing and commenting are idempotent per binding and key. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly fetchIssueContext: (
      repo: Repo,
      issue: number,
    ) => Effect.Effect<IssueContext, GitHubError>;
    readonly fetchSource: (
      repo: Repo,
      sha: string,
    ) => Effect.Effect<ReadonlyArray<SourceFile>, GitHubError>;
    readonly publish: (
      issue: number,
      binding: ApprovalBinding,
      patch: Patch,
      journal: PublishJournal,
      publicChecks?: ReadonlyArray<PublicCheck>,
    ) => Effect.Effect<PullRequest, PublishError>;
    readonly reconcile: (
      issue: number,
      binding: ApprovalBinding,
      journal: PublishJournal,
    ) => Effect.Effect<ReconcileResult, GitHubError>;
    readonly comment: (
      repo: Repo,
      issue: number,
      key: string,
      text: string,
    ) => Effect.Effect<void, GitHubError>;
  }
>()("caldero/GitHub") {}

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
  message: Schema.String,
}) {}

/** The session index the inbox lists. Keeps a session's newest revision; older ones are ignored. */
export class Projection extends Context.Service<
  Projection,
  {
    readonly project: (
      state: SessionState,
      instructionId: string,
    ) => Effect.Effect<void, ProjectionError>;
  }
>()("caldero/Projection") {}
