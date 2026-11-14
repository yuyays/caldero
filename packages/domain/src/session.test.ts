import { describe, expect, it } from "@effect/vitest";
import { decide, type Decision, Events, initialSession, type SessionEvent } from "./session.ts";

const now = 1_800_000_000_000;
const repo = { owner: "acme", name: "shop" };
const fresh = (policy: "off" | "observe" = "observe") =>
  initialSession({ sessionId: "github:acme/shop#7", repo, issue: 7, policy });

/** Applies events in order, returning the last decision. */
const run = (events: ReadonlyArray<SessionEvent>, start = fresh()) => {
  let decision = { state: start, instructions: [], result: "applied" } as Decision;
  for (const event of events) decision = decide(decision.state, event, now);
  return decision;
};
const labeled = Events.IssueLabeled.make({ context: "Fix the login bug", baseSha: "base1" });
const answered = (runId: number) => Events.RunAnswered.make({ runId });
const validated = (runId: number, patchDigest: string) =>
  Events.Validated.make({ runId, patchDigest, evidence: "typecheck ok, 12 tests passed" });
/** The binding a reviewer sees for the first proposal. */
const firstBinding = {
  sessionId: "github:acme/shop#7",
  version: 1,
  runId: 1,
  repo,
  baseSha: "base1",
  patchDigest: "sha256:aaa",
};
const proposed = [labeled, answered(1), validated(1, "sha256:aaa")];
const cancel = Events.Cancel.make({ actor: "yuyays" });
const publishFailed = (kind: "retryable" | "permanent" | "ambiguous") =>
  Events.PublishFailed.make({ kind, message: `${kind} failure` });
const input = (text: string) => Events.UserInput.make({ text });
const approve = (binding = firstBinding) => Events.Approve.make({ actor: "yuyays", binding });

describe("decide", () => {
  it("starts run 1 with the issue context when an observed issue is labeled", () => {
    const { state, instructions, result } = decide(
      fresh(),
      Events.IssueLabeled.make({ context: "Fix the login bug", baseSha: "base1" }),
      now,
    );
    expect(result).toBe("applied");
    expect(state.status).toBe("running");
    expect(state.runId).toBe(1);
    expect(instructions).toMatchObject([{ _tag: "Submit" }, { _tag: "Project" }]);
    expect(instructions[0]).toMatchObject({ runId: 1, mode: "start", text: "Fix the login bug" });
  });

  it("ignores a labeled issue in a repo whose policy is off", () => {
    const { state, instructions, result } = run([labeled], fresh("off"));
    expect(result).toBe("stale");
    expect(state.status).toBe("idle");
    expect(instructions).toEqual([]);
  });

  it("validates a run once it answers, and ignores answers from other runs", () => {
    const validating = run([labeled, Events.RunAnswered.make({ runId: 1 })]);
    expect(validating.state.status).toBe("validating");
    expect(validating.instructions).toMatchObject([{ _tag: "Validate" }, { _tag: "Project" }]);
    expect(validating.instructions[0]).toMatchObject({ runId: 1 });

    const other = run([labeled, Events.RunAnswered.make({ runId: 9 })]);
    expect(other.result).toBe("stale");
    expect(other.state.status).toBe("running");
  });

  it("proposes version 1, bound to its run, base and digest, once validation passes", () => {
    const { state, instructions } = run(proposed);
    expect(state.status).toBe("awaitingApproval");
    expect(state.version).toBe(1);
    expect(state.candidate?.binding).toEqual(firstBinding);
    expect(instructions).toMatchObject([{ _tag: "Project" }]);
  });

  it("publishes the approved binding exactly once", () => {
    const approved = run([...proposed, approve()]);
    expect(approved.result).toBe("applied");
    expect(approved.state.status).toBe("publishing");
    expect(approved.instructions[0]).toMatchObject({ _tag: "Publish", binding: firstBinding });

    const repeated = run([...proposed, approve(), approve()]);
    expect(repeated.result).toBe("duplicate");
    expect(repeated.instructions).toEqual([]);
  });

  it.each([
    ["an older version", { ...firstBinding, version: 0 }],
    ["another digest", { ...firstBinding, patchDigest: "sha256:bbb" }],
    ["another base", { ...firstBinding, baseSha: "base0" }],
    ["another run", { ...firstBinding, runId: 2 }],
  ])("refuses an approval for %s", (_case, binding) => {
    const { state, instructions, result } = run([...proposed, approve(binding)]);
    expect(result).toBe("stale");
    expect(state.status).toBe("awaitingApproval");
    expect(instructions).toEqual([]);
  });

  it("refuses an approval before anything is proposed, and after a rejection", () => {
    expect(run([labeled, approve()]).result).toBe("stale");
    const rejected = run([
      ...proposed,
      Events.Reject.make({ actor: "yuyays", binding: firstBinding }),
    ]);
    expect(rejected.state.status).toBe("rejected");
    expect(decide(rejected.state, approve(), now).result).toBe("stale");
  });

  it("steers the current run with input that arrives while it is running", () => {
    const { state, instructions } = run([labeled, input("also check logout")]);
    expect(state.status).toBe("running");
    expect(state.runId).toBe(1);
    expect(instructions[0]).toMatchObject({
      _tag: "Submit",
      runId: 1,
      mode: "steer",
      text: "also check logout",
    });
  });

  it.each([
    ["validating", [labeled, answered(1)]],
    ["awaiting approval", proposed],
  ])(
    "starts a new run when input arrives while %s, and ignores the old run's late result",
    (_case, before) => {
      const restarted = run([...before, input("use the new API instead")]);
      expect(restarted.state.status).toBe("running");
      expect(restarted.state.runId).toBe(2);
      expect(restarted.state.candidate).toBeNull();
      expect(restarted.instructions[0]).toMatchObject({ _tag: "Submit", runId: 2, mode: "start" });

      const late = decide(restarted.state, validated(1, "sha256:old"), now);
      expect(late.result).toBe("stale");

      const next = run([answered(2), validated(2, "sha256:new")], restarted.state);
      expect(next.state.status).toBe("awaitingApproval");
      expect(next.state.candidate?.binding).toMatchObject({
        version: 1 + restarted.state.version,
        runId: 2,
      });
      expect(decide(next.state, approve(), now).result).toBe("stale");
    },
  );

  it("holds input that arrives while publishing", () => {
    const { state, instructions } = run([...proposed, approve(), input("rename the button")]);
    expect(state.status).toBe("publishing");
    expect(state.queued).toEqual(["rename the button"]);
    expect(instructions).toMatchObject([{ _tag: "Project" }]);
  });

  it("retries with a new run, carrying the evidence, when validation fails", () => {
    const failedOnce = run([
      labeled,
      answered(1),
      Events.ValidationFailed.make({ runId: 1, evidence: "2 tests failed" }),
    ]);
    expect(failedOnce.state.status).toBe("running");
    expect(failedOnce.state.runId).toBe(2);
    expect(failedOnce.instructions[0]).toMatchObject({ _tag: "Submit", runId: 2, mode: "start" });
    expect(failedOnce.instructions[0]).toHaveProperty(
      "text",
      expect.stringContaining("2 tests failed"),
    );
  });

  it("fails the session with a reason after three failed attempts in a row", () => {
    const attempt = (runId: number, failure: "validation" | "run") =>
      failure === "validation"
        ? [answered(runId), Events.ValidationFailed.make({ runId, evidence: "tests failed" })]
        : [Events.RunFailed.make({ runId, reason: "model error" })];
    const { state, instructions } = run([
      labeled,
      ...attempt(1, "validation"),
      ...attempt(2, "run"),
      ...attempt(3, "validation"),
    ]);
    expect(state.status).toBe("failed");
    expect(state.failure).toContain("tests failed");
    expect(instructions).toMatchObject([{ _tag: "Project" }]);
  });

  it("ignores failures reported for a run that is no longer current", () => {
    const { result, state } = run([labeled, Events.RunFailed.make({ runId: 7, reason: "late" })]);
    expect(result).toBe("stale");
    expect(state.status).toBe("running");
  });

  it("cancels a running session and aborts its run; a second cancel is a duplicate", () => {
    const cancelled = run([labeled, cancel]);
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.instructions[0]).toMatchObject({ _tag: "AbortRun", runId: 1 });
    expect(decide(cancelled.state, cancel, now).result).toBe("duplicate");
  });

  it("cancels a proposal without aborting anything", () => {
    const { state, instructions } = run([...proposed, cancel]);
    expect(state.status).toBe("cancelled");
    expect(instructions).toMatchObject([{ _tag: "Project" }]);
  });

  it("refuses to cancel while publishing", () => {
    const { state, result } = run([...proposed, approve(), cancel]);
    expect(result).toBe("stale");
    expect(state.status).toBe("publishing");
  });

  it("records the pull request and comments on the issue once publishing succeeds", () => {
    const pr = { number: 42, url: "https://github.com/acme/shop/pull/42" };
    const { state, instructions } = run([...proposed, approve(), Events.PublishSucceeded.make(pr)]);
    expect(state.status).toBe("published");
    expect(state.pullRequest).toEqual(pr);
    expect(instructions[0]).toMatchObject({ _tag: "Comment", key: "published:v1" });
    expect(instructions[0]).toHaveProperty("text", expect.stringContaining(pr.url));
  });

  it("reconciles instead of publishing again when the outcome is unknown", () => {
    const { state, instructions } = run([...proposed, approve(), publishFailed("ambiguous")]);
    expect(state.status).toBe("publishing");
    expect(instructions[0]).toMatchObject({ _tag: "Reconcile", binding: firstBinding });
  });

  it("retries a retryable publish with a new instruction, then fails after the limit", () => {
    const once = run([...proposed, approve(), publishFailed("retryable")]);
    expect(once.instructions[0]).toMatchObject({ _tag: "Publish", binding: firstBinding });
    const first = run([...proposed, approve()]).instructions[0];
    expect(once.instructions[0]?.instructionId).not.toBe(first?.instructionId);

    const exhausted = run([
      ...proposed,
      approve(),
      publishFailed("retryable"),
      publishFailed("retryable"),
      publishFailed("retryable"),
    ]);
    expect(exhausted.state.status).toBe("failed");
  });

  it("fails at once on a permanent publish failure", () => {
    const { state } = run([...proposed, approve(), publishFailed("permanent")]);
    expect(state.status).toBe("failed");
    expect(state.failure).toContain("permanent failure");
  });

  it("retries a failed run with a new run that continues the task", () => {
    const { state, instructions } = run([
      labeled,
      Events.RunFailed.make({ runId: 1, reason: "model error" }),
    ]);
    expect(state.status).toBe("running");
    expect(state.runId).toBe(2);
    expect(instructions[0]).toMatchObject({ _tag: "Submit", runId: 2, mode: "start" });
  });

  it("fails instead of reconciling forever when the publish outcome stays unknown", () => {
    const { state } = run([
      ...proposed,
      approve(),
      publishFailed("ambiguous"),
      publishFailed("ambiguous"),
      publishFailed("ambiguous"),
    ]);
    expect(state.status).toBe("failed");
    expect(state.failure).toContain("ambiguous failure");
  });

  it("starts the next run with input held during publishing, once the publish settles", () => {
    const pr = { number: 42, url: "https://github.com/acme/shop/pull/42" };
    const { state, instructions } = run([
      ...proposed,
      approve(),
      input("rename the button"),
      Events.PublishSucceeded.make(pr),
    ]);
    expect(state.status).toBe("running");
    expect(state.runId).toBe(2);
    expect(state.queued).toEqual([]);
    expect(state.pullRequest).toEqual(pr);
    expect(instructions).toMatchObject([
      { _tag: "Comment", key: "published:v1" },
      { _tag: "Submit", runId: 2, mode: "start", text: "rename the button" },
      { _tag: "Project" },
    ]);
  });

  it("records who approved, rejected or cancelled", () => {
    expect(run([...proposed, approve()]).state.decidedBy).toBe("yuyays");
    const rejected = Events.Reject.make({ actor: "reviewer2", binding: firstBinding });
    expect(run([...proposed, rejected]).state.decidedBy).toBe("reviewer2");
    expect(run([labeled, Events.Cancel.make({ actor: "reviewer3" })]).state.decidedBy).toBe(
      "reviewer3",
    );
  });
});
