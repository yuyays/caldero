import { describe, expect, it } from "@effect/vitest";
import {
  automaticRepairGuidance,
  automaticRepairStatus,
  decide,
  type Decision,
  Events,
  initialSession,
  type SessionEvent,
} from "./session.ts";

const now = 1_800_000_000_000;
const repo = { owner: "acme", name: "shop" };
const fresh = () => initialSession({ sessionId: "github:acme/shop#7", repo, issue: 7 });

/** Applies events in order, returning the last decision. */
const run = (events: ReadonlyArray<SessionEvent>, start = fresh()) => {
  let decision = { state: start, instructions: [], result: "applied" } as Decision;
  for (const event of events) decision = decide(decision.state, event, now);
  return decision;
};
const labeled = Events.IssueLabeled.make({
  context: "Fix the login bug",
  baseSha: "base1",
  baseRef: "main",
});
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
  baseRef: "main",
  patchDigest: "sha256:aaa",
};
const proposed = [labeled, answered(1), validated(1, "sha256:aaa")];
const cancel = Events.Cancel.make({ actor: "yuyays" });
const publishFailed = (kind: "retryable" | "permanent" | "ambiguous") =>
  Events.PublishFailed.make({ kind, message: `${kind} failure` });
const input = (text: string) => Events.UserInput.make({ text });

describe("decide", () => {
  it("binds an explicit repair to the saved PR and permits one edit attempt", () => {
    const pr = { number: 42, url: "https://example.test/42" };
    const published = run([...proposed, Events.PublishSucceeded.make(pr)]).state;
    const target = { number: 42, headRef: "caldero/7-v1", headSha: "pr-head", baseRef: "main" };
    const request = { expectedRevision: published.revision, target, context: "A test failed" };
    for (const event of [
      Events.Repair.make({ ...request, expectedRevision: published.revision - 1 }),
      Events.Repair.make({ ...request, target: { ...target, number: 43 } }),
    ]) {
      expect(decide(published, event, now)).toMatchObject({ result: "stale", instructions: [] });
    }
    const repair = Events.Repair.make(request);
    expect(decide(fresh(), repair, now).result).toBe("stale");
    const first = decide(published, repair, now);
    expect(first.state).toMatchObject({ status: "running", runId: 2, baseSha: "pr-head" });
    expect(decide(first.state, repair, now).result).toBe("stale");
    expect(decide(first.state, input("Start another edit"), now).result).toBe("stale");
    for (const failure of [
      run([Events.RunFailed.make({ runId: 2, reason: "model stopped" })], first.state),
      run(
        [answered(2), Events.ValidationFailed.make({ runId: 2, evidence: "checks failed" })],
        first.state,
      ),
    ]) {
      expect(failure.state).toMatchObject({ status: "failed", runId: 2, candidate: null });
      expect(failure.instructions).toMatchObject([{ _tag: "Project" }]);
      expect(
        decide(failure.state, Events.Retry.make({ expectedRevision: failure.state.revision }), now)
          .result,
      ).toBe("stale");
    }
    const checked = run([answered(2), validated(2, "sha256:repair")], first.state);
    expect(checked.instructions[0]).toMatchObject({
      _tag: "Publish",
      binding: { baseSha: "pr-head", repair: target, patchDigest: "sha256:repair" },
    });
    const failedPublish = decide(checked.state, publishFailed("permanent"), now).state;
    expect(automaticRepairStatus(failedPublish)).toBe("unavailable");
    const retry = decide(
      failedPublish,
      Events.Retry.make({ expectedRevision: failedPublish.revision }),
      now,
    );
    expect(retry.instructions).toMatchObject([
      { _tag: "Reconcile", binding: { repair: target } },
      { _tag: "Project" },
    ]);
    expect(
      decide(checked.state, Events.PublishSucceeded.make(pr), now).instructions[0],
    ).toMatchObject({
      _tag: "Comment",
      text: expect.stringContaining("Added a checked CI repair"),
    });
  });

  it("blocks another automatic repair on the same PR at a new head", () => {
    const pr = { number: 42, url: "https://example.test/42" };
    const published = run([...proposed, Events.PublishSucceeded.make(pr)]).state;
    expect(automaticRepairStatus(published)).toBe("available");
    const target = { number: 42, headRef: "caldero/7-v1", headSha: "pr-head", baseRef: "main" };
    const first = decide(
      published,
      Events.Repair.make({
        expectedRevision: published.revision,
        target,
        context: "A test failed",
        automatic: true,
      }),
      now,
    );
    expect(first.result).toBe("applied");
    expect(automaticRepairStatus(first.state)).toBe("running");
    const repaired = run(
      [answered(2), validated(2, "sha256:repair"), Events.PublishSucceeded.make(pr)],
      first.state,
    ).state;
    expect(automaticRepairStatus(repaired)).toBe("used");
    const request = {
      expectedRevision: repaired.revision,
      target: { ...target, headSha: "new-pr-head" },
      context: "CI is still failing",
    };
    expect(
      decide(repaired, Events.Repair.make({ ...request, automatic: true }), now),
    ).toMatchObject({ result: "stale", instructions: [] });
    expect(decide(repaired, Events.Repair.make(request), now).result).toBe("applied");
    const failedEdit = run(
      [Events.RunFailed.make({ runId: 2, reason: "model stopped" })],
      first.state,
    ).state;
    const failedPublish = run(
      [answered(2), validated(2, "sha256:repair"), publishFailed("permanent")],
      first.state,
    ).state;
    const resume = (revision: number, automatic = false) =>
      Events.Repair.make({ ...request, expectedRevision: revision, automatic });
    expect(decide(failedEdit, resume(failedEdit.revision, true), now).result).toBe("stale");
    expect(decide(failedEdit, resume(failedEdit.revision), now).result).toBe("applied");
    expect(decide(failedPublish, resume(failedPublish.revision), now).result).toBe("stale");
  });

  it("offers publication recovery for a failed follow-up with a saved PR", () => {
    expect(automaticRepairGuidance(fresh(), true)).toBeNull();

    const failed = run([
      ...proposed,
      input("Follow-up while publishing"),
      Events.PublishSucceeded.make({ number: 42, url: "https://example.test/42" }),
      answered(2),
      validated(2, "sha256:follow-up"),
      publishFailed("permanent"),
    ]).state;
    expect(automaticRepairGuidance(failed, false)).toEqual({
      status: "unavailable",
      nextAction: "retry",
    });
  });

  it("reconciles a failed frozen publication and refuses retries outside failed state", () => {
    const failed = run([...proposed, publishFailed("permanent")]).state;
    const retried = decide(failed, Events.Retry.make({ expectedRevision: failed.revision }), now);
    expect(retried.state).toMatchObject({
      status: "publishing",
      runId: 1,
      version: 1,
      attempts: 0,
      candidate: { binding: firstBinding },
    });
    expect(retried.instructions).toMatchObject([
      { _tag: "Reconcile", binding: firstBinding },
      { _tag: "Project" },
    ]);
    for (const state of [
      fresh(),
      run([labeled]).state,
      run(proposed).state,
      run([labeled, cancel]).state,
      run([
        ...proposed,
        Events.PublishSucceeded.make({ number: 42, url: "https://example.test/42" }),
      ]).state,
    ]) {
      expect(
        decide(state, Events.Retry.make({ expectedRevision: state.revision }), now).result,
      ).toBe("stale");
    }
  });

  it("allows retry of failed follow-up work while retaining the previous PR and next candidate version", () => {
    const failed = run([
      ...proposed,
      input("Follow up"),
      Events.PublishSucceeded.make({ number: 42, url: "https://example.test/42" }),
      Events.RunFailed.make({ runId: 2, reason: "outage" }),
      Events.RunFailed.make({ runId: 3, reason: "outage" }),
      Events.RunFailed.make({ runId: 4, reason: "outage" }),
    ]).state;
    expect(failed).toMatchObject({
      status: "failed",
      candidate: null,
      pullRequest: { number: 42 },
    });
    const retried = decide(failed, Events.Retry.make({ expectedRevision: failed.revision }), now);
    expect(retried.state).toMatchObject({
      status: "running",
      runId: 5,
      version: 1,
      attempts: 0,
      pullRequest: { number: 42 },
    });
    const checked = run([answered(5), validated(5, "sha256:followup")], retried.state);
    expect(checked.instructions[0]).toMatchObject({
      _tag: "Publish",
      binding: { version: 2, runId: 5, patchDigest: "sha256:followup" },
    });
  });

  it("explicitly restarts exhausted checks with failure context and rejects an old retry revision", () => {
    const failed = run([
      labeled,
      answered(1),
      Events.ValidationFailed.make({ runId: 1, evidence: "missing fixture" }),
      answered(2),
      Events.ValidationFailed.make({ runId: 2, evidence: "missing fixture" }),
      answered(3),
      Events.ValidationFailed.make({ runId: 3, evidence: "missing fixture" }),
    ]).state;
    expect(failed.status).toBe("failed");
    const request = Events.Retry.make({ expectedRevision: failed.revision });
    const retried = decide(failed, request, now);
    expect(retried.state).toMatchObject({
      status: "running",
      runId: 4,
      attempts: 0,
      failure: null,
    });
    expect(retried.instructions).toMatchObject([
      { _tag: "Submit", mode: "start", runId: 4, text: expect.stringContaining("missing fixture") },
      { _tag: "Project" },
    ]);
    const failedAgain = run(
      [
        Events.RunFailed.make({ runId: 4, reason: "outage" }),
        Events.RunFailed.make({ runId: 5, reason: "outage" }),
        Events.RunFailed.make({ runId: 6, reason: "outage" }),
      ],
      retried.state,
    ).state;
    expect(failedAgain.status).toBe("failed");
    expect(decide(failedAgain, request, now).result).toBe("stale");
    expect(decide(retried.state, request, now).instructions).toEqual([]);
  });

  it("publishes a validated frozen candidate automatically without recording a human approval", () => {
    const automatic = fresh();
    const decision = run(proposed, automatic);
    expect(decision.state).toMatchObject({
      status: "publishing",
      version: 1,
      decidedBy: null,
      candidate: { binding: firstBinding, evidence: "typecheck ok, 12 tests passed" },
    });
    expect(decision.instructions).toMatchObject([
      { _tag: "Publish", binding: firstBinding },
      { _tag: "Project" },
    ]);
    const project = decision.instructions.find((instruction) => instruction["_tag"] === "Project");
    if (project?.["_tag"] !== "Project") expect.unreachable();
    expect(JSON.parse(project.snapshot)).toMatchObject({
      policy: "auto",
      status: "publishing",
      candidate: { binding: firstBinding },
    });
    const repeated = decide(decision.state, validated(1, "sha256:aaa"), now);
    expect(repeated.result).toBe("stale");
    expect(repeated.instructions).toEqual([]);
  });

  it("never publishes failed or stale auto validation and validates queued input as a new candidate", () => {
    const automatic = fresh();
    const failed = run(
      [labeled, answered(1), Events.ValidationFailed.make({ runId: 1, evidence: "tests failed" })],
      automatic,
    );
    expect(failed.state).toMatchObject({ status: "running", runId: 2, candidate: null });
    expect(failed.instructions.some((instruction) => instruction["_tag"] === "Publish")).toBe(
      false,
    );
    const oldResult = decide(failed.state, validated(1, "old"), now);
    expect(oldResult.result).toBe("stale");
    expect(oldResult.instructions).toEqual([]);
    const next = run(
      [
        ...proposed,
        input("Make another change"),
        Events.PublishSucceeded.make({ number: 1, url: "https://example.com/pr/1" }),
        answered(2),
        validated(2, "sha256:next"),
      ],
      automatic,
    );
    expect(next.state).toMatchObject({
      status: "publishing",
      version: 2,
      runId: 2,
      decidedBy: null,
      candidate: { binding: { patchDigest: "sha256:next", version: 2, runId: 2 } },
    });
    expect(next.instructions[0]).toMatchObject({
      _tag: "Publish",
      binding: { patchDigest: "sha256:next", version: 2 },
    });
  });
  it("keeps the state of each projected revision even when later events change the session", () => {
    const first = run([labeled]);
    const projected = first.instructions.find((instruction) => instruction["_tag"] === "Project");
    if (projected?.["_tag"] !== "Project") expect.unreachable();
    expect(JSON.parse(projected.snapshot)).toMatchObject({
      status: "running",
      revision: 1,
      runId: 1,
    });
    const later = run([...proposed]);
    expect(later.state.status).toBe("publishing");
    expect(JSON.parse(projected.snapshot).status).toBe("running");
  });
  it("starts run 1 with the issue context when an observed issue is labeled", () => {
    const { state, instructions, result } = decide(
      fresh(),
      Events.IssueLabeled.make({ context: "Fix the login bug", baseSha: "base1", baseRef: "main" }),
      now,
    );
    expect(result).toBe("applied");
    expect(state.status).toBe("running");
    expect(state.runId).toBe(1);
    expect(instructions).toMatchObject([{ _tag: "Submit" }, { _tag: "Project" }]);
    expect(instructions[0]).toMatchObject({ runId: 1, mode: "start", text: "Fix the login bug" });
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

  it.each([["validating", [labeled, answered(1)]]])(
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
      expect(next.state.status).toBe("publishing");
      expect(next.state.candidate?.binding).toMatchObject({
        version: 1 + restarted.state.version,
        runId: 2,
      });
    },
  );

  it("holds input that arrives while publishing", () => {
    const { state, instructions } = run([...proposed, input("rename the button")]);
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

  it("refuses to cancel while publishing", () => {
    const { state, result } = run([...proposed, cancel]);
    expect(result).toBe("stale");
    expect(state.status).toBe("publishing");
  });

  it("records the pull request and comments on the issue once publishing succeeds", () => {
    const pr = { number: 42, url: "https://github.com/acme/shop/pull/42" };
    const { state, instructions } = run([...proposed, Events.PublishSucceeded.make(pr)]);
    expect(state.status).toBe("published");
    expect(state.pullRequest).toEqual(pr);
    expect(instructions[0]).toMatchObject({ _tag: "Comment", key: "published:v1" });
    expect(instructions[0]).toHaveProperty("text", expect.stringContaining(pr.url));
  });

  it("reconciles instead of publishing again when the outcome is unknown", () => {
    const { state, instructions } = run([...proposed, publishFailed("ambiguous")]);
    expect(state.status).toBe("publishing");
    expect(instructions[0]).toMatchObject({ _tag: "Reconcile", binding: firstBinding });
  });

  it("retries a retryable publish with a new instruction, then fails after the limit", () => {
    const publicChecks = [{ label: "Demo reload", command: "pnpm test demo" }];
    const checked = [
      labeled,
      answered(1),
      Events.Validated.make({
        runId: 1,
        patchDigest: firstBinding.patchDigest,
        evidence: "private check output",
        publicChecks,
      }),
    ];
    const once = run([...checked, publishFailed("retryable")]);
    expect(once.instructions[0]).toMatchObject({
      _tag: "Publish",
      binding: firstBinding,
      publicChecks,
    });
    expect(once.instructions[0]).not.toHaveProperty("evidence");
    const first = run(checked).instructions[0];
    expect(once.instructions[0]?.instructionId).not.toBe(first?.instructionId);

    const exhausted = run([
      ...proposed,
      publishFailed("retryable"),
      publishFailed("retryable"),
      publishFailed("retryable"),
    ]);
    expect(exhausted.state.status).toBe("failed");
  });

  it("fails at once on a permanent publish failure", () => {
    const { state } = run([...proposed, publishFailed("permanent")]);
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

  it("records who stopped the session", () => {
    expect(run([labeled, Events.Cancel.make({ actor: "reviewer3" })]).state.decidedBy).toBe(
      "reviewer3",
    );
  });

  it("keeps a legacy paused candidate inert until new instructions create a validated replacement", () => {
    const legacy = {
      ...run(proposed).state,
      policy: "observe" as const,
      status: "awaitingApproval" as const,
    };
    expect(decide(legacy, validated(1, "sha256:aaa"), now).result).toBe("stale");
    const next = run([input("Use the new API"), answered(2), validated(2, "sha256:new")], legacy);
    expect(next.state).toMatchObject({ status: "publishing", version: 2, decidedBy: null });
    expect(next.instructions[0]).toMatchObject({
      _tag: "Publish",
      binding: { version: 2, patchDigest: "sha256:new" },
    });
  });
});
