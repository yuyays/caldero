import { Schema } from "effect";

/** A GitHub repository. */
export const Repo = Schema.Struct({ owner: Schema.String, name: Schema.String });
export type Repo = typeof Repo.Type;

export const RepairTarget = Schema.Struct({
  number: Schema.Int,
  headRef: Schema.String,
  headSha: Schema.String,
  baseRef: Schema.String,
});
export type RepairTarget = typeof RepairTarget.Type;

/** The exact candidate bound to publication. Historical name retained for stored journals. */
export const ApprovalBinding = Schema.Struct({
  sessionId: Schema.String,
  version: Schema.Int,
  runId: Schema.Int,
  repo: Repo,
  baseSha: Schema.String,
  baseRef: Schema.String,
  patchDigest: Schema.String,
  repair: Schema.optionalKey(RepairTarget),
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

/** Historical values remain readable; all new sessions publish automatically. */
export const Policy = Schema.Literals(["off", "observe", "auto"]);
export type Policy = typeof Policy.Type;

const publicCheckText = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isPattern(/^(?![\s\S]*[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])/u),
);
/** An operator-designated check whose label and command may appear on the PR. */
export const PublicCheck = Schema.Struct({
  label: publicCheckText.check(Schema.isMaxLength(120)),
  command: publicCheckText.check(Schema.isMaxLength(1000)),
});
export type PublicCheck = typeof PublicCheck.Type;
export const PublicChecks = Schema.Array(PublicCheck).check(Schema.isMaxLength(8));

/** A validated, frozen patch bound to publication. */
export const Candidate = Schema.Struct({
  binding: ApprovalBinding,
  evidence: Schema.String,
  /** Public check descriptions from this candidate's successful local validation. */
  publicChecks: Schema.optionalKey(PublicChecks),
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
  repair: Schema.optionalKey(RepairTarget),
  /** The run that spent each PR's automatic repair attempt. */
  automaticRepairRuns: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  /** Who stopped the session, or its historical reviewer, for the audit trail. */
  decidedBy: Schema.NullOr(Schema.String),
  updatedAt: Schema.Finite,
});
export type SessionState = typeof SessionState.Type;

const AutomaticRepairStatus = Schema.Literals(["available", "running", "used", "unavailable"]);
export const AutomaticRepairGuidance = Schema.Struct({
  status: AutomaticRepairStatus,
  nextAction: Schema.NullOr(Schema.Literals(["repair", "retry"])),
});
export type AutomaticRepairGuidance = typeof AutomaticRepairGuidance.Type;

/** Describe the saved attempt for the current PR, independently of live CI. */
export const automaticRepairStatus = (
  state: SessionState,
): typeof AutomaticRepairStatus.Type | null => {
  const number = state.pullRequest?.number;
  if (number === undefined) return null;
  const attemptedRun = state.automaticRepairRuns?.[number];
  if (attemptedRun === undefined) return state.status === "published" ? "available" : "unavailable";
  if (
    attemptedRun === state.runId &&
    ["running", "validating", "publishing"].includes(state.status)
  )
    return "running";
  return "used";
};

/** Failed edits can be retried explicitly. Frozen patches must reconcile publication first. */
export const canStartRepair = (state: SessionState, automatic = false): boolean => {
  const number = state.pullRequest?.number;
  if (number === undefined) return false;
  if (automatic) return automaticRepairStatus(state) === "available";
  return (
    state.status === "published" ||
    (state.status === "failed" && state.repair?.number === number && state.candidate === null)
  );
};

/** A reported failure can suggest repair. A saved candidate needs publication recovery first. */
export const automaticRepairGuidance = (
  state: SessionState,
  hasFailedCheck: boolean,
): AutomaticRepairGuidance | null => {
  const status = automaticRepairStatus(state);
  if (status === null) return null;
  if (state.status === "failed" && state.candidate !== null) return { status, nextAction: "retry" };
  return {
    status,
    nextAction: status !== "available" && hasFailedCheck && canStartRepair(state) ? "repair" : null,
  };
};

export const SessionEvent = Schema.TaggedUnion({
  IssueLabeled: { context: Schema.String, baseSha: Schema.String, baseRef: Schema.String },
  UserInput: { text: Schema.String },
  Retry: { expectedRevision: Schema.Int },
  Repair: {
    expectedRevision: Schema.Int,
    target: RepairTarget,
    context: Schema.String,
    automatic: Schema.optionalKey(Schema.Boolean),
  },
  RunAnswered: { runId: Schema.Int },
  Validated: {
    runId: Schema.Int,
    patchDigest: Schema.String,
    evidence: Schema.String,
    publicChecks: Schema.optionalKey(PublicChecks),
  },
  ValidationFailed: { runId: Schema.Int, evidence: Schema.String },
  RunFailed: { runId: Schema.Int, reason: Schema.String },
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
  Publish: {
    instructionId: Schema.String,
    binding: ApprovalBinding,
    publicChecks: Schema.optionalKey(PublicChecks),
  },
  Reconcile: { instructionId: Schema.String, binding: ApprovalBinding },
  Project: { instructionId: Schema.String, revision: Schema.Int, snapshot: Schema.String },
  Comment: { instructionId: Schema.String, key: Schema.String, text: Schema.String },
});
export type Instruction = typeof Instruction.Type;

/** `applied` changed the session; `duplicate` repeats what already happened; `stale` was refused. */
export type DecisionResult = "applied" | "duplicate" | "stale";

/** Failure limit for ordinary runs and publication. An explicit repair gets one edit run. */
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
}): SessionState =>
  SessionState.make({
    ...init,
    policy: "auto",
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

  /** Retry ordinary runs within budget. Repair finishes after its first run or check failure. */
  const retryRun = (text: string, failure: string): Decision => {
    const attempts = state.attempts + 1;
    if (state.repair || attempts >= attemptLimit)
      return applied({ status: "failed", attempts, failure });
    const runId = state.runId + 1;
    return applied({ status: "running", runId, attempts }, [submit(runId, "start", text)]);
  };

  return SessionEvent.match(event, {
    IssueLabeled: ({ context, baseSha, baseRef }) => {
      if (state.status !== "idle") return unchanged("duplicate");
      return applied({ status: "running", runId: 1, baseSha, baseRef }, [
        submit(1, "start", context),
      ]);
    },
    Retry: ({ expectedRevision }) => {
      if (state.status !== "failed" || state.revision !== expectedRevision)
        return unchanged("stale");
      // A frozen candidate means publication may have landed: keep its identity and reconcile first.
      const binding = state.candidate?.binding;
      if (binding !== undefined)
        return applied({ status: "publishing", attempts: 0, failure: null }, [
          (instructionId) => Instruction.cases.Reconcile.make({ instructionId, binding }),
        ]);
      if (state.repair) return unchanged("stale");
      const runId = state.runId + 1;
      return applied({ status: "running", runId, attempts: 0, failure: null }, [
        submit(
          runId,
          "start",
          `Retry the failed task using the existing conversation and workspace. Fix the cause and finish again.\n\nPrevious failure:\n${state.failure ?? "No failure details were saved."}`,
        ),
      ]);
    },
    Repair: ({ expectedRevision, target, context, automatic }) => {
      if (
        !canStartRepair(state, automatic) ||
        state.revision !== expectedRevision ||
        state.pullRequest?.number !== target.number
      )
        return unchanged("stale");
      const runId = state.runId + 1;
      return applied(
        {
          status: "running",
          runId,
          repair: target,
          ...(automatic
            ? { automaticRepairRuns: { ...state.automaticRepairRuns, [target.number]: runId } }
            : {}),
          baseSha: target.headSha,
          baseRef: target.baseRef,
          attempts: 0,
          candidate: null,
          failure: null,
          queued: [],
        },
        [submit(runId, "start", context)],
      );
    },
    UserInput: ({ text }) => {
      if (state.repair) return unchanged("stale");
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
    Validated: ({ runId, patchDigest, evidence, publicChecks }) => {
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
        ...(state.repair ? { repair: state.repair } : {}),
      };
      return applied(
        {
          status: "publishing",
          version,
          attempts: 0,
          candidate: { binding, evidence, ...(publicChecks === undefined ? {} : { publicChecks }) },
        },
        [
          (instructionId) =>
            Instruction.cases.Publish.make({
              instructionId,
              binding,
              ...(publicChecks === undefined ? {} : { publicChecks }),
            }),
        ],
      );
    },
    ValidationFailed: ({ runId, evidence }) => {
      if (!isCurrentRun(runId, "validating")) return unchanged("stale");
      return retryRun(
        `Validation failed. Fix the failures and finish again.\n\n${evidence}`,
        `Validation failed: ${evidence}`,
      );
    },
    RunFailed: ({ runId, reason }) => {
      if (!isCurrentRun(runId, "running", "validating")) return unchanged("stale");
      return retryRun(
        `The previous attempt failed (${reason}). Continue the task.`,
        `Run failed: ${reason}`,
      );
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
            text: state.candidate?.binding.repair
              ? `Added a checked CI repair to ${url} (version ${state.version}).`
              : `Opened ${url} for version ${state.version}.`,
          }),
      ]);
    },
    PublishFailed: ({ kind, message }) => {
      const candidate = state.candidate;
      if (state.status !== "publishing" || candidate === null) return unchanged("stale");
      const { binding, publicChecks } = candidate;
      const attempts = state.attempts + 1;
      if (kind === "permanent" || attempts >= attemptLimit)
        return settle({ status: "failed", attempts, failure: `Publish failed: ${message}` });
      // An unknown outcome is reconciled, never republished: the first attempt may have landed.
      return applied({ attempts }, [
        (instructionId) =>
          kind === "ambiguous"
            ? Instruction.cases.Reconcile.make({ instructionId, binding })
            : Instruction.cases.Publish.make({
                instructionId,
                binding,
                ...(publicChecks === undefined ? {} : { publicChecks }),
              }),
      ]);
    },
  });
};
