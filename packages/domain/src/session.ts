import { Schema } from "effect";

/** A GitHub repository. */
export const Repo = Schema.Struct({ owner: Schema.String, name: Schema.String });
export type Repo = typeof Repo.Type;

/** The exact candidate a publication or approval is bound to. */
export const ApprovalBinding = Schema.Struct({
  sessionId: Schema.String,
  version: Schema.Int,
  runId: Schema.Int,
  repo: Repo,
  baseSha: Schema.String,
  baseRef: Schema.String,
  patchDigest: Schema.String,
});
export type ApprovalBinding = typeof ApprovalBinding.Type;

export const Status = Schema.Literals([
  "idle",
  "running",
  "validating",
  "awaitingApproval",
  "publishing",
  "published",
  "rejected",
  "cancelled",
  "failed",
]);
export type Status = typeof Status.Type;

export const Policy = Schema.Literals(["off", "observe", "auto"]);
export type Policy = typeof Policy.Type;

/** A validated, frozen patch bound to its publication or optional approval. */
export const Candidate = Schema.Struct({
  binding: ApprovalBinding,
  evidence: Schema.String,
});

export const SessionState = Schema.Struct({
  sessionId: Schema.String,
  repo: Repo,
  issue: Schema.Int,
  policy: Policy,
  status: Status,
  /** Increments with every applied event; instruction IDs derive from it. */
  revision: Schema.Int,
  /** The current Pi run; results for any other run are ignored. */
  runId: Schema.Int,
  /** Increments with every proposed candidate. */
  version: Schema.Int,
  baseSha: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  candidate: Schema.NullOr(Candidate),
  /** Failed attempts of the current phase. */
  attempts: Schema.Int,
  /** Input that arrived while publishing; held until the publish settles. */
  queued: Schema.Array(Schema.String),
  pullRequest: Schema.NullOr(Schema.Struct({ number: Schema.Int, url: Schema.String })),
  failure: Schema.NullOr(Schema.String),
  /** Who approved, rejected or cancelled, for the audit trail. */
  decidedBy: Schema.NullOr(Schema.String),
  updatedAt: Schema.Finite,
});
export type SessionState = typeof SessionState.Type;

export const SessionEvent = Schema.TaggedUnion({
  IssueLabeled: { context: Schema.String, baseSha: Schema.String, baseRef: Schema.String },
  UserInput: { text: Schema.String },
  RunAnswered: { runId: Schema.Int },
  Validated: { runId: Schema.Int, patchDigest: Schema.String, evidence: Schema.String },
  ValidationFailed: { runId: Schema.Int, evidence: Schema.String },
  RunFailed: { runId: Schema.Int, reason: Schema.String },
  Approve: { actor: Schema.String, binding: ApprovalBinding },
  Reject: { actor: Schema.String, binding: ApprovalBinding },
  Cancel: { actor: Schema.String },
  PublishSucceeded: { number: Schema.Int, url: Schema.String },
  PublishFailed: {
    kind: Schema.Literals(["retryable", "permanent", "ambiguous"]),
    message: Schema.String,
  },
});
export type SessionEvent = typeof SessionEvent.Type;
/** Event constructors, e.g. `Events.UserInput.make({ text })`. */
export const Events = SessionEvent.cases;

/** An external action, committed before it runs. `instructionId` is unique and stable. */
export const Instruction = Schema.TaggedUnion({
  Submit: {
    instructionId: Schema.String,
    runId: Schema.Int,
    mode: Schema.Literals(["start", "steer"]),
    text: Schema.String,
  },
  Validate: { instructionId: Schema.String, runId: Schema.Int },
  AbortRun: { instructionId: Schema.String, runId: Schema.Int },
  Publish: { instructionId: Schema.String, binding: ApprovalBinding },
  Reconcile: { instructionId: Schema.String, binding: ApprovalBinding },
  Project: { instructionId: Schema.String, revision: Schema.Int, snapshot: Schema.String },
  Comment: { instructionId: Schema.String, key: Schema.String, text: Schema.String },
});
export type Instruction = typeof Instruction.Type;

const sameBinding = (a: ApprovalBinding, b: ApprovalBinding) =>
  a.sessionId === b.sessionId &&
  a.version === b.version &&
  a.runId === b.runId &&
  a.repo.owner === b.repo.owner &&
  a.repo.name === b.repo.name &&
  a.baseSha === b.baseSha &&
  a.baseRef === b.baseRef &&
  a.patchDigest === b.patchDigest;

/** `applied` changed the session; `duplicate` repeats what already happened; `stale` was refused. */
export type DecisionResult = "applied" | "duplicate" | "stale";

/** Consecutive failures of one phase (run and validation, or publishing) before the session fails. */
const attemptLimit = 3;

export interface Decision {
  readonly state: SessionState;
  readonly instructions: ReadonlyArray<Instruction>;
  readonly result: DecisionResult;
}

export const initialSession = (init: {
  sessionId: string;
  repo: Repo;
  issue: number;
  policy: Policy;
}): SessionState =>
  SessionState.make({
    ...init,
    status: "idle",
    revision: 0,
    runId: 0,
    version: 0,
    baseSha: null,
    baseRef: null,
    candidate: null,
    attempts: 0,
    queued: [],
    pullRequest: null,
    failure: null,
    decidedBy: null,
    updatedAt: 0,
  });

/**
 * The session's only decision function. Pure: it returns the next state and the instructions to
 * run, and never performs them. Callers commit both together, then run each instruction.
 */
export const decide = (state: SessionState, event: SessionEvent, now: number): Decision => {
  const revision = state.revision + 1;
  const id = (index: number) => `${state.sessionId}/${revision}/${index}`;
  const unchanged = (result: "duplicate" | "stale"): Decision => ({
    state,
    instructions: [],
    result,
  });
  /** Applies a change; every applied event also projects the new revision. */
  const applied = (
    change: Partial<SessionState>,
    instructions: ReadonlyArray<(id: string) => Instruction> = [],
  ): Decision => {
    const next = { ...state, ...change, revision, updatedAt: now };
    return {
      state: next,
      instructions: [
        ...instructions,
        (instructionId: string) =>
          Instruction.cases.Project.make({
            instructionId,
            revision,
            snapshot: JSON.stringify(next),
          }),
      ].map((make, index) => make(id(index))),
      result: "applied",
    };
  };
  const submit =
    (runId: number, mode: "start" | "steer", text: string) => (instructionId: string) =>
      Instruction.cases.Submit.make({ instructionId, runId, mode, text });

  const isCurrentRun = (runId: number, ...statuses: ReadonlyArray<Status>) =>
    runId === state.runId && statuses.includes(state.status);
  /** The current candidate's binding, when `binding` names exactly that candidate. */
  const matchesCandidate = (binding: ApprovalBinding) => {
    const current = state.candidate?.binding;
    return current !== undefined && sameBinding(current, binding);
  };
  /** Settles a publish; input held meanwhile starts the next run. */
  const settle = (
    change: Partial<SessionState>,
    instructions: ReadonlyArray<(id: string) => Instruction> = [],
  ): Decision => {
    if (state.queued.length === 0) return applied(change, instructions);
    const runId = state.runId + 1;
    return applied(
      { ...change, status: "running", runId, attempts: 0, candidate: null, queued: [] },
      [...instructions, submit(runId, "start", state.queued.join("\n\n"))],
    );
  };

  /** Starts the next run after a failure, or fails the session once the attempts are used up. */
  const retry = (text: string, failure: string): Decision => {
    const attempts = state.attempts + 1;
    if (attempts >= attemptLimit) return applied({ status: "failed", attempts, failure });
    const runId = state.runId + 1;
    return applied({ status: "running", runId, attempts }, [submit(runId, "start", text)]);
  };

  return SessionEvent.match(event, {
    IssueLabeled: ({ context, baseSha, baseRef }) => {
      if (state.policy === "off") return unchanged("stale");
      if (state.status !== "idle") return unchanged("duplicate");
      return applied({ status: "running", runId: 1, baseSha, baseRef }, [
        submit(1, "start", context),
      ]);
    },
    UserInput: ({ text }) => {
      switch (state.status) {
        case "running":
          return applied({}, [submit(state.runId, "steer", text)]);
        // New input makes the candidate obsolete: a new run proposes the next version.
        case "validating":
        case "awaitingApproval": {
          const runId = state.runId + 1;
          return applied({ status: "running", runId, candidate: null, attempts: 0 }, [
            submit(runId, "start", text),
          ]);
        }
        case "publishing":
          return applied({ queued: [...state.queued, text] });
        default:
          return unchanged("stale");
      }
    },
    RunAnswered: ({ runId }) => {
      if (!isCurrentRun(runId, "running")) return unchanged("stale");
      return applied({ status: "validating" }, [
        (instructionId) => Instruction.cases.Validate.make({ instructionId, runId }),
      ]);
    },
    Validated: ({ runId, patchDigest, evidence }) => {
      if (!isCurrentRun(runId, "validating") || state.baseSha === null || state.baseRef === null)
        return unchanged("stale");
      const version = state.version + 1;
      const binding = {
        sessionId: state.sessionId,
        version,
        runId,
        repo: state.repo,
        baseSha: state.baseSha,
        baseRef: state.baseRef,
        patchDigest,
      };
      const automatic = state.policy === "auto";
      return applied(
        {
          status: automatic ? "publishing" : "awaitingApproval",
          version,
          attempts: 0,
          candidate: { binding, evidence },
        },
        automatic
          ? [(instructionId) => Instruction.cases.Publish.make({ instructionId, binding })]
          : [],
      );
    },
    ValidationFailed: ({ runId, evidence }) => {
      if (!isCurrentRun(runId, "validating")) return unchanged("stale");
      return retry(
        `Validation failed. Fix the failures and finish again.\n\n${evidence}`,
        `Validation failed: ${evidence}`,
      );
    },
    RunFailed: ({ runId, reason }) => {
      if (!isCurrentRun(runId, "running", "validating")) return unchanged("stale");
      return retry(
        `The previous attempt failed (${reason}). Continue the task.`,
        `Run failed: ${reason}`,
      );
    },
    Approve: ({ actor, binding }) => {
      if (state.policy !== "observe") return unchanged("stale");
      if (!matchesCandidate(binding)) return unchanged("stale");
      if (state.status === "publishing" || state.status === "published")
        return unchanged("duplicate");
      if (state.status !== "awaitingApproval") return unchanged("stale");
      return applied({ status: "publishing", attempts: 0, decidedBy: actor }, [
        (instructionId) => Instruction.cases.Publish.make({ instructionId, binding }),
      ]);
    },
    Reject: ({ actor, binding }) => {
      if (state.policy !== "observe") return unchanged("stale");
      if (!matchesCandidate(binding)) return unchanged("stale");
      if (state.status === "rejected") return unchanged("duplicate");
      if (state.status !== "awaitingApproval") return unchanged("stale");
      return applied({ status: "rejected", decidedBy: actor });
    },
    Cancel: ({ actor }) => {
      switch (state.status) {
        case "running":
        case "validating":
          return applied({ status: "cancelled", decidedBy: actor }, [
            (instructionId) =>
              Instruction.cases.AbortRun.make({ instructionId, runId: state.runId }),
          ]);
        case "idle":
        case "awaitingApproval":
          return applied({ status: "cancelled", decidedBy: actor });
        case "cancelled":
          return unchanged("duplicate");
        default:
          // Publishing may already have reached GitHub; finished sessions have nothing to cancel.
          return unchanged("stale");
      }
    },
    PublishSucceeded: ({ number, url }) => {
      if (state.status === "published") return unchanged("duplicate");
      if (state.status !== "publishing") return unchanged("stale");
      return settle({ status: "published", pullRequest: { number, url } }, [
        (instructionId) =>
          Instruction.cases.Comment.make({
            instructionId,
            key: `published:v${state.version}`,
            text: `Opened ${url} for version ${state.version}.`,
          }),
      ]);
    },
    PublishFailed: ({ kind, message }) => {
      const binding = state.candidate?.binding;
      if (state.status !== "publishing" || binding === undefined) return unchanged("stale");
      const attempts = state.attempts + 1;
      if (kind === "permanent" || attempts >= attemptLimit)
        return settle({ status: "failed", attempts, failure: `Publish failed: ${message}` });
      // An unknown outcome is reconciled, never republished: the first attempt may have landed.
      const next = kind === "ambiguous" ? Instruction.cases.Reconcile : Instruction.cases.Publish;
      return applied({ attempts }, [(instructionId) => next.make({ instructionId, binding })]);
    },
  });
};
