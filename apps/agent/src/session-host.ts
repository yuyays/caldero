import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  Harness,
  hook,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type Report,
  runEndTask,
  type Storage,
  type TaskId,
  type Tx,
  wrapTool,
  type ToolRegistration,
  type Wake,
} from "@earendil-works/pi-durable";
import { SessionFault, type SessionView } from "@caldero/contracts/inbox";
export type { SessionView } from "@caldero/contracts/inbox";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  decide,
  Events,
  initialSession,
  Instruction,
  type SessionEvent,
  SessionState,
} from "@caldero/domain";
import { Cause, Clock, Effect, Exit, Result, Schema } from "effect";
import { SessionDoc } from "./session-document.ts";
import {
  errorMessage,
  type Checkpoint,
  GitHub,
  GitHubError,
  type PublishJournal,
  PublishProgress,
  Projection,
  PublishError,
  Workspace,
  WorkspaceError,
} from "./ports.ts";

const context = BACKGROUND_CONTEXT;
const codingTools: ReadonlyArray<ToolRegistration> = CodingTools.tools ?? [];
const stateJson = Schema.fromJsonString(SessionState);
const readStateJson = Schema.decodeSync(stateJson);
const decodeState = (json: string) => {
  try {
    return readStateJson(json);
  } catch {
    throw new SessionFault({
      code: "state_unreadable",
      message: "Stored session state cannot be read; operator repair is required.",
    });
  }
};
const encodeState = Schema.encodeSync(stateJson);

/** The kind of the transcript entry every caldero input is placed as; its data names the run it belongs to. */
const inputKind = "caldero.input";

const WorkspaceDoc = defineDoc<{ bootId: string | null; checkpoint: Checkpoint | null }>({
  kind: "caldero.workspace",
  version: 1,
  scope: "session",
  initial: () => ({ bootId: null, checkpoint: null }),
  checkpointWhen: () => true,
});
const decodeInstruction = Schema.decodeUnknownSync(Instruction);

const publishJson = Schema.fromJsonString(PublishProgress);
const decodePublish = Schema.decodeSync(publishJson);
const encodePublish = Schema.encodeSync(publishJson);
const PublishDoc = defineDoc<{ entries: Record<string, string> }>({
  kind: "caldero.publish",
  version: 1,
  scope: "session",
  initial: () => ({ entries: {} }),
  checkpointWhen: () => true,
});

export class SessionHostError extends Schema.TaggedError<SessionHostError>()("SessionHostError", {
  message: Schema.String,
}) {}

const hostError = (error: unknown) =>
  error instanceof SessionFault ? error : new SessionHostError({ message: errorMessage(error) });

export interface SessionHostOptions {
  readonly storage: Storage;
  /** The session to create on first open; ignored once it exists. */
  readonly session: Parameters<typeof initialSession>[0];
  readonly models: Models;
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** Set by a host that wakes itself (a Durable Object alarm); Pi then arms no timers. */
  readonly onWake?: (wake: Wake) => void;
  readonly onReport?: (report: Report) => void;
}

const done = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;

/** Attempts of an instruction without a session event (a comment, a projection) before it gives up. */
const sideEffectAttempts = 5;

/**
 * One session's durable host. Every external action is an instruction the reducer returned: it is committed together
 * with the state that produced it, as a Pi task, and the task commits the action's outcome as the next event. Events
 * from outside arrive through `deliver`, which is idempotent per event ID.
 */
export const openSessionHost = Effect.fn("openSessionHost")(function* (
  options: SessionHostOptions,
) {
  const workspace = yield* Workspace;
  const github = yield* GitHub;
  const projection = yield* Projection;
  const run = Effect.runPromiseWith(yield* Effect.context());
  // Set before Pi closes: queued reconciliation must not start a commit after admission closes.
  let closing = false;
  /** Every reconciliation pass runs on this tail, so no two passes share a commit line. */
  let reconciliationTail: Promise<void> = Promise.resolve();

  let rootId: ConversationId | undefined;
  const root = () => {
    if (rootId === undefined) throw new Error("The session host is not open yet");
    return rootId;
  };

  /** Decides `event` and commits its state and instructions in `tx`; a seen `eventId` repeats its first result. */
  const applyEvent = Effect.fn("SessionHost.applyEvent")(function* (
    tx: Tx,
    event: SessionEvent,
    eventId: string,
    now: number,
  ) {
    const doc = yield* Effect.tryPromise({ try: () => tx.doc(SessionDoc), catch: hostError });
    const seen = doc.seen[eventId];
    if (seen === "applied" || seen === "duplicate" || seen === "stale") return seen;
    const decision = decide(decodeState(doc.state), event, now);
    doc.seen[eventId] = decision.result;
    if (decision.result !== "applied") return decision.result;
    doc.state = encodeState(decision.state);
    if (event["_tag"] === "Repair") {
      // Checkpoints describe edits relative to the previous base, never the PR head.
      const savedWorkspace = yield* Effect.tryPromise({
        try: () => tx.doc(WorkspaceDoc),
        catch: hostError,
      });
      savedWorkspace.checkpoint = null;
      savedWorkspace.bootId = null;
    }
    for (const instruction of decision.instructions) {
      const id = yield* Effect.tryPromise({
        try: () =>
          tx.createTask(Instructions, instruction, {
            ownership: { kind: "conversation" },
            conversationId: root(),
            // Instructions outlive runs: aborting the conversation must not abort the abort itself.
            background: true,
          }),
        catch: hostError,
      });
      (doc.tasks ??= []).push(id);
    }
    return decision.result;
  });

  const readState = (callContext = context) =>
    Effect.tryPromise({
      try: () => harness.snapshot(SessionDoc, callContext),
      catch: hostError,
    }).pipe(
      Effect.flatMap((doc) =>
        Effect.try({ try: () => decodeState(doc?.state ?? ""), catch: hostError }),
      ),
    );

  /** The event an instruction's action produced, if any. Expected failures become events; others fail the task. */
  const perform = (instruction: Instruction, state: SessionState, journal: PublishJournal) =>
    Instruction.match(instruction, {
      Validate: ({ runId }) =>
        // A validation the session no longer waits for would only race the next run's edits.
        state.status !== "validating" || state.runId !== runId
          ? Effect.undefined
          : workspace.validate().pipe(
              Effect.map((validation): SessionEvent =>
                validation.passed
                  ? Events.Validated.make({
                      runId,
                      patchDigest: validation.patch.digest,
                      evidence: validation.evidence,
                      ...(validation.publicChecks === undefined
                        ? {}
                        : { publicChecks: validation.publicChecks }),
                    })
                  : Events.ValidationFailed.make({ runId, evidence: validation.evidence }),
              ),
              Effect.catchTag("WorkspaceError", (error) =>
                Effect.succeed(Events.ValidationFailed.make({ runId, evidence: error.message })),
              ),
            ),
      Publish: ({ binding, publicChecks }) =>
        workspace.patch(binding.patchDigest).pipe(
          // The candidate's frozen patch is gone; publishing it again cannot help.
          Effect.mapError(
            (error) => new PublishError({ kind: "permanent", message: error.message }),
          ),
          Effect.flatMap((patch) =>
            github.publish(state.issue, binding, patch, journal, publicChecks),
          ),
          Effect.map((pullRequest): SessionEvent => Events.PublishSucceeded.make(pullRequest)),
          Effect.catchTag("PublishError", (error) =>
            Effect.succeed(Events.PublishFailed.make({ kind: error.kind, message: error.message })),
          ),
        ),
      Reconcile: ({ binding }) =>
        github.reconcile(state.issue, binding, journal).pipe(
          Effect.map((result): SessionEvent => {
            if (result.found === "pullRequest")
              return Events.PublishSucceeded.make(result.pullRequest);
            if (result.found === "conflict")
              return Events.PublishFailed.make({ kind: "permanent", message: result.message });
            // Nothing landed, so publishing again is safe.
            return Events.PublishFailed.make({
              kind: "retryable",
              message: "the publish did not land",
            });
          }),
          Effect.catchTag("GitHubError", (error) =>
            Effect.succeed(
              Events.PublishFailed.make({ kind: "ambiguous", message: error.message }),
            ),
          ),
        ),
      Comment: ({ key, text }) =>
        github.comment(state.repo, state.issue, key, text).pipe(Effect.as(undefined)),
      Project: ({ snapshot, instructionId }) =>
        projection.project(decodeState(snapshot), instructionId).pipe(Effect.as(undefined)),
      // Both act on Pi itself, in the task.
      AbortRun: () => Effect.undefined,
      Submit: () => Effect.undefined,
    });

  /**
   * Pi skips `afterRun` when a run fails or is aborted, so a failed run is found from `pi.live` instead: its failure
   * names the run's inputs, and each input's request names the session run it belongs to. Reports it as `RunFailed`
   * in `tx`, at most once per failure; true when that changed the session.
   */
  const reportFailedRun = Effect.fn("SessionHost.reportFailedRun")(function* (tx: Tx, now: number) {
    const live = yield* Effect.tryPromise({
      try: () => tx.doc(LiveDoc, root()),
      catch: hostError,
    });
    const failure = live.runFailure;
    if (failure === undefined || live.run !== undefined) return false;
    const doc = yield* Effect.tryPromise({ try: () => tx.doc(SessionDoc), catch: hostError });
    let runId: number | undefined;
    for (const id of failure.inputs) {
      const requestId = (yield* Effect.tryPromise({
        try: () => tx.submission(id),
        catch: hostError,
      }))?.requestId;
      const requestRun = requestId === undefined ? undefined : doc.runs[requestId];
      if (requestRun !== undefined) runId = Math.max(runId ?? 0, requestRun);
    }
    if (runId === undefined) return false;
    const reason =
      failure.detail === undefined ? failure.reason : `${failure.reason}: ${failure.detail}`;
    const event = Events.RunFailed.make({ runId, reason });
    return (yield* applyEvent(tx, event, `run-failed:${failure.taskId}`, now)) === "applied";
  });

  /** What an event-bearing instruction reports when its action failed unexpectedly, so the session never waits on it. */
  const fallback = (instruction: Instruction, message: string): SessionEvent | undefined =>
    Instruction.match(instruction, {
      Validate: ({ runId }) => Events.ValidationFailed.make({ runId, evidence: message }),
      // It may have landed: reconcile, never repeat.
      Publish: () => Events.PublishFailed.make({ kind: "ambiguous", message }),
      Reconcile: () => Events.PublishFailed.make({ kind: "ambiguous", message }),
      Comment: () => undefined,
      Project: () => undefined,
      AbortRun: () => undefined,
      Submit: () => undefined,
    });

  /** Runs one instruction, then commits its outcome; a crash before that commit runs it again. */
  const Instructions = defineTask<Instruction, { phase: "run"; attempt: number }, null>({
    name: "caldero.instruction",
    version: 1,
    initial: () => ({ phase: "run", attempt: 0 }),
    phases: {
      run: async (task, runtime) => {
        const taskContext = withAbortSignal(runtime.signal, BACKGROUND_CONTEXT);
        const instruction = task.input;
        const eventId = `instruction:${instruction.instructionId}`;
        const handle = await runtime.conversation(runtime.conversationId, taskContext);
        if (handle === undefined) throw new Error("The session's conversation is missing");

        if (Instruction.guards.Submit(instruction)) {
          if (instruction.mode === "start") {
            const state = await run(readState(taskContext), { signal: runtime.signal });
            const prepared = await run(
              Effect.exit(
                state.baseSha === null
                  ? Effect.fail(new WorkspaceError({ message: "the base commit is unknown" }))
                  : workspace.prepare(state.repo, state.baseSha, state.repair !== undefined),
              ),
              { signal: runtime.signal },
            );
            if (Exit.isFailure(prepared)) {
              // The session retries the run, within its attempt limit.
              const reason = `the workspace could not be prepared: ${errorMessage(Cause.squash(prepared.cause))}`;
              await runtime.commit(
                (tx) =>
                  run(
                    Effect.gen(function* () {
                      yield* applyEvent(
                        tx,
                        Events.RunFailed.make({ runId: instruction.runId, reason }),
                        eventId,
                        runtime.now(),
                      );
                      return done;
                    }),
                    { signal: runtime.signal },
                  ),
                taskContext,
              );
              return;
            }
          }
          await runtime.commit(
            (tx) =>
              run(
                Effect.gen(function* () {
                  // A failed run not reported yet would otherwise be hidden by this input starting a new one.
                  yield* reportFailedRun(tx, runtime.now());
                  const doc = yield* Effect.tryPromise({
                    try: () => tx.doc(SessionDoc),
                    catch: hostError,
                  });
                  const current = decodeState(doc.state);
                  if (current.status !== "running" || current.runId !== instruction.runId) {
                    // The session moved on meanwhile. A start is obsolete; a steer is new input for whatever it does now.
                    if (instruction.mode === "steer")
                      yield* applyEvent(
                        tx,
                        Events.UserInput.make({ text: instruction.text }),
                        eventId,
                        runtime.now(),
                      );
                    return done;
                  }
                  // Admission before the commit's table writes, as Pi requires.
                  yield* Effect.tryPromise({
                    try: () =>
                      handle.submit(tx, {
                        type: "input",
                        content: instruction.text,
                        requestId: instruction.instructionId,
                        whenBusy: instruction.mode === "steer" ? "steer" : "followUp",
                        entry: { kind: inputKind, data: { runId: instruction.runId } },
                      }),
                    catch: hostError,
                  });
                  doc.runs[instruction.instructionId] = instruction.runId;
                  return done;
                }),
                { signal: runtime.signal },
              ),
            taskContext,
          );
          return;
        }

        if (Instruction.guards.AbortRun(instruction)) {
          // The run first, so it starts no command after the workspace is quiet.
          await handle.abort(taskContext);
          await run(workspace.quiesce(), { signal: runtime.signal });
          await runtime.commit(() => done, taskContext);
          return;
        }

        const journalKey = String("binding" in instruction ? instruction.binding.version : 0);
        const journal: PublishJournal = {
          read: () =>
            Effect.tryPromise({
              try: async () => {
                const saved = await runtime.snapshot(PublishDoc, taskContext);
                const value = saved?.entries[journalKey];
                return value === undefined ? null : decodePublish(value);
              },
              catch: (error) => new GitHubError({ message: errorMessage(error) }),
            }),
          // Once a receipt commit starts, finish it despite caller cancellation. Pi still rejects writes
          // after the task invocation ends or the host closes; this does not extend the task's lifetime.
          save: (progress) =>
            Effect.tryPromise({
              try: () =>
                runtime.commit(async (tx) => {
                  (await tx.doc(PublishDoc)).entries[journalKey] = encodePublish(progress);
                }, context),
              catch: (error) => new GitHubError({ message: errorMessage(error) }),
            }).pipe(Effect.uninterruptible),
        };
        const state = await run(readState(taskContext), { signal: runtime.signal });
        const outcome = await run(Effect.exit(perform(instruction, state, journal)), {
          signal: runtime.signal,
        });
        const failed = Exit.isFailure(outcome)
          ? fallback(instruction, errorMessage(Cause.squash(outcome.cause)))
          : undefined;
        if (Exit.isFailure(outcome) && failed === undefined) {
          // A comment or projection. Nothing in the session waits for it, so it retries alone.
          const attempt = task.state.checkpoint.attempt + 1;
          if (attempt < sideEffectAttempts) {
            await runtime.sleepUntil(
              runtime.now() + 1000 * 2 ** attempt,
              { phase: "run", attempt },
              context,
            );
            return;
          }
          const message = errorMessage(Cause.squash(outcome.cause));
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
            context,
          );
          return;
        }
        const event = Exit.isSuccess(outcome) ? outcome.value : failed;
        await runtime.commit(
          (tx) =>
            run(
              Effect.gen(function* () {
                if (event !== undefined) yield* applyEvent(tx, event, eventId, runtime.now());
                return done;
              }),
              { signal: runtime.signal },
            ),
          taskContext,
        );
      },
    },
    abort: (_task, runtime) => runtime.commit(() => aborted, context),
  });

  /** Reports a run's answer to the session once the answer is committed. */
  const RunAnswered = defineTask<{ runId: number }, { phase: "report" }, null>({
    name: "caldero.run-answered",
    version: 1,
    initial: () => ({ phase: "report" }),
    phases: {
      report: async (task, runtime) => {
        const callContext = withAbortSignal(runtime.signal, context);
        await runtime.commit(
          (tx) =>
            run(
              Effect.gen(function* () {
                // Input that arrived meanwhile starts another run of the same run ID; its answer is the one to validate.
                const inbox = yield* Effect.tryPromise({
                  try: () => tx.doc(InboxDoc, runtime.conversationId),
                  catch: hostError,
                });
                const pending = inbox.items.some((item) => item.entry?.kind === inputKind);
                if (!pending)
                  yield* applyEvent(
                    tx,
                    Events.RunAnswered.make({ runId: task.input.runId }),
                    `run-answered:${task.id}`,
                    runtime.now(),
                  );
                return done;
              }),
              { signal: runtime.signal },
            ),
          callContext,
        );
      },
    },
    abort: (_task, runtime) => runtime.commit(() => aborted, context),
  });

  const Caldero = defineExtension({
    name: "caldero",
    tasks: [Instructions, RunAnswered],
    wraps: codingTools.map((tool) =>
      wrapTool(tool, (original) => ({
        ...original,
        executionMode: "sequential",
        execute: async (args, api, toolContext) => {
          const result = await original.execute(args, api, toolContext);
          if (["write", "edit", "bash"].includes(original.name)) {
            const saved = await api.snapshot(WorkspaceDoc, toolContext);
            const pointer = await run(workspace.checkpoint((saved?.checkpoint?.number ?? 0) + 1), {
              signal: toolContext.abortSignal,
            });
            // Upload precedes this durable pointer; the tool result commits separately afterwards.
            await api.commit(async (tx) => {
              (await tx.doc(WorkspaceDoc)).checkpoint = pointer;
            }, toolContext);
          }
          return result;
        },
      })),
    ),
    hooks: [
      hook(GenerationTask, {
        afterRun: async (summary, api) => {
          const range = {
            minEntryId: summary.first,
            maxEntryId: summary.last,
            order: "ascending",
          } as const;
          let runId: number | undefined;
          let cursor;
          do {
            const page = await api.entries(range, 500, cursor, context);
            for (const entry of page.items) {
              const data = entry.data;
              if (entry.kind !== inputKind || typeof data !== "object" || data === null) continue;
              if (Array.isArray(data) || typeof data.runId !== "number") continue;
              runId = Math.max(runId ?? 0, data.runId);
            }
            cursor = page.next;
          } while (cursor !== undefined);
          return runId === undefined ? undefined : { tasks: [runEndTask(RunAnswered, { runId })] };
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Caldero);

  const environment = workspace.env({
    read: Effect.fn("SessionHost.readWorkspace")(function* (signal) {
      const callContext = withAbortSignal(signal, context);
      const saved = yield* Effect.tryPromise({
        try: () => harness.snapshot(WorkspaceDoc, callContext),
        catch: (error) => new WorkspaceError({ message: errorMessage(error) }),
      });
      const state = yield* readState(callContext).pipe(
        Effect.mapError((error) => new WorkspaceError({ message: error.message })),
      );
      if (state.baseSha === null)
        return yield* new WorkspaceError({ message: "Workspace has no base commit" });
      return {
        repo: state.repo,
        baseSha: state.baseSha,
        bootId: saved?.bootId ?? null,
        checkpoint: saved?.checkpoint ?? null,
      };
    }),
    restored: (bootId, notice, signal) =>
      Effect.tryPromise({
        try: () =>
          harness.commit(
            (tx) =>
              run(
                Effect.gen(function* () {
                  const doc = yield* Effect.tryPromise({
                    try: () => tx.doc(SessionDoc),
                    catch: hostError,
                  });
                  const state = decodeState(doc.state);
                  if (notice !== undefined && state.status !== "running") {
                    // A restore after the answer reopens the run before the model edits again.
                    yield* applyEvent(
                      tx,
                      Events.UserInput.make({ text: notice }),
                      `workspace-reset:${bootId}`,
                      yield* Clock.currentTimeMillis,
                    );
                  } else if (notice !== undefined)
                    yield* Effect.tryPromise({
                      try: () =>
                        conversation.submit(tx, {
                          type: "input",
                          content: notice,
                          requestId: `workspace-reset:${bootId}`,
                          whenBusy: "steer",
                          entry: {
                            kind: inputKind,
                            data: { runId: state.runId },
                          },
                        }),
                      catch: hostError,
                    });
                  const workspaceDoc = yield* Effect.tryPromise({
                    try: () => tx.doc(WorkspaceDoc),
                    catch: hostError,
                  });
                  workspaceDoc.bootId = bootId;
                }),
                { signal },
              ),
            withAbortSignal(signal, context),
          ),
        catch: (error) => new WorkspaceError({ message: errorMessage(error) }),
      }),
  });

  const harness: Harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) =>
        Harness.open(
          options.storage,
          {
            models: options.models,
            registry,
            env: () => environment,
            // Queued input behind a failed run is withdrawn; the session decides what runs next.
            settings: { afterFailedRun: "withdraw" },
            ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
            onReport: (report) => {
              if (report.kind === "task_faulted") scheduleSync();
              options.onReport?.(report);
            },
          },
          withAbortSignal(signal, context),
        ),
      catch: hostError,
    }),
    (opened) =>
      Effect.tryPromise({
        try: async () => {
          closing = true;
          // Let an in-flight pass settle; queued passes become no-ops instead of committing after close.
          await reconciliationTail;
          await opened.close(context);
        },
        catch: hostError,
      }).pipe(Effect.catch((error) => Effect.logWarning("Closing the session host failed", error))),
  );

  const pi = <A>(operation: (context: typeof BACKGROUND_CONTEXT) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => operation(withAbortSignal(signal, context)),
      catch: hostError,
    });

  // Read persisted state before any initialization write; an unreadable session must never be replaced.
  const savedState = yield* pi((callContext) => harness.snapshot(SessionDoc, callContext));
  if (savedState !== undefined) {
    const saved = yield* Effect.try({ try: () => decodeState(savedState.state), catch: hostError });
    if (
      saved.sessionId !== options.session.sessionId ||
      saved.issue !== options.session.issue ||
      saved.repo.owner !== options.session.repo.owner ||
      saved.repo.name !== options.session.repo.name
    )
      return yield* new SessionFault({
        code: "identity_mismatch",
        message: "Stored session identity does not match this issue; operator repair is required.",
      });
  }
  const conversation = yield* pi((callContext) =>
    harness.root(callContext, {
      agent: {
        model: options.model,
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        extensions: [CodingTools, Caldero],
      },
    }),
  );
  rootId = conversation.id;
  yield* pi((callContext) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(SessionDoc);
      if (doc.state === "") doc.state = encodeState(initialSession(options.session));
    }, callContext),
  );

  const syncRun = Effect.fn("SessionHost.syncRun")(function* (callContext = context) {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        harness.commit(
          (tx) =>
            run(
              Effect.gen(function* () {
                const doc = yield* Effect.tryPromise({
                  try: () => tx.doc(SessionDoc),
                  catch: hostError,
                });
                const processed = new Set(doc.tasks ?? []);
                const tasks = yield* Effect.forEach(
                  [...processed],
                  (id) =>
                    Effect.tryPromise({ try: () => tx.task(id), catch: hostError }).pipe(
                      Effect.map((task) => ({ id, task })),
                    ),
                  { concurrency: "unbounded" },
                );
                const answeredFaults = [];
                let cursor: Parameters<Tx["scanTasks"]>[2];
                do {
                  const page = yield* Effect.tryPromise({
                    try: () =>
                      tx.scanTasks(
                        { kind: "caldero.run-answered", status: "terminal" },
                        100,
                        cursor,
                      ),
                    catch: hostError,
                  });
                  answeredFaults.push(...page.items);
                  cursor = page.next;
                } while (cursor !== undefined);
                yield* reportFailedRun(tx, now);
                for (const task of answeredFaults) {
                  if (task.state.status !== "terminal" || task.state.outcome.status !== "faulted")
                    continue;
                  const input = task.input;
                  if (
                    typeof input !== "object" ||
                    input === null ||
                    Array.isArray(input) ||
                    typeof input.runId !== "number"
                  )
                    continue;
                  yield* applyEvent(
                    tx,
                    Events.RunFailed.make({
                      runId: input.runId,
                      reason: `Answer reporting faulted: ${errorMessage(task.state.outcome.error)}`,
                    }),
                    `faulted:${task.id}`,
                    now,
                  );
                }
                const pending: Array<TaskId> = [];
                for (const { id, task } of tasks) {
                  if (task === undefined) continue;
                  if (task.state.status !== "terminal") {
                    pending.push(id);
                    continue;
                  }
                  if (task.state.outcome.status !== "faulted") continue;
                  const instruction = decodeInstruction(task.input);
                  const reason = `Instruction ${instruction["_tag"]} faulted: ${errorMessage(task.state.outcome.error)}`;
                  const event = Instruction.guards.Submit(instruction)
                    ? Events.RunFailed.make({ runId: instruction.runId, reason })
                    : fallback(instruction, reason);
                  if (event !== undefined) yield* applyEvent(tx, event, `faulted:${id}`, now);
                }
                // applyEvent can append replacement tasks while handling a fault.
                doc.tasks = [...pending, ...(doc.tasks ?? []).filter((id) => !processed.has(id))];
              }),
              { signal: callContext.abortSignal },
            ),
          callContext,
        ),
      catch: hostError,
    });
  });

  /** Runs one reconciliation pass after the previous one; queued passes are skipped once closing starts. */
  const reconcile = (callContext: typeof context = context) => {
    if (closing) return Promise.resolve();
    const pass = reconciliationTail.then(() => (closing ? undefined : run(syncRun(callContext))));
    reconciliationTail = pass.catch((error: unknown) =>
      run(Effect.logError("Reporting a failed run failed", error)),
    );
    return pass;
  };
  /** Schedules a pass and logs its failure; the next change, resume, or open runs it again. */
  const scheduleSync = (callContext: typeof context = context) => {
    void reconcile(callContext).catch(() => {});
  };
  yield* pi(() =>
    harness.observeDoc(
      LiveDoc,
      root(),
      { advance: () => scheduleSync(), end: () => undefined },
      context,
    ),
  );
  harness.resume();
  scheduleSync();

  return {
    /** Decide and commit one event; the same `eventId` again returns its first result and changes nothing. */
    deliver: Effect.fn("SessionHost.deliver")(function* (event: SessionEvent, eventId: string) {
      const now = yield* Clock.currentTimeMillis;
      return yield* pi((callContext) =>
        harness.commit(
          (tx) => run(applyEvent(tx, event, eventId, now), { signal: callContext.abortSignal }),
          callContext,
        ),
      );
    }),

    view: Effect.fn("SessionHost.view")(function* () {
      const state = yield* readState();
      const candidate = state.candidate;
      if (candidate === null) return { state, patch: null } satisfies SessionView;
      const patch = yield* workspace.patch(candidate.binding.patchDigest).pipe(Effect.result);
      // Missing/corrupt blobs must not hide authoritative state or prevent cancellation.
      return Result.isFailure(patch)
        ? ({ state, patch: null, patchUnavailable: true } satisfies SessionView)
        : ({ state, patch: patch.success } satisfies SessionView);
    }),

    /** The alarm: due sleeps, work a lost instance left, and failed runs not yet reported. */
    resume: () =>
      Effect.sync(() => {
        harness.resume();
        scheduleSync();
      }),
    wake: () => harness.wake(),
    running: () =>
      pi(async (callContext) => {
        const state = await run(readState(callContext), { signal: callContext.abortSignal });
        return state.status === "running" || state.status === "validating";
      }),

    /** Waits until no task is live and every failed run is reported. For tests and graceful shutdown. */
    drain: Effect.fn("SessionHost.drain")(function* () {
      for (;;) {
        // Shared reconciliation continues on the host context if this drain fiber is interrupted.
        yield* Effect.tryPromise({
          try: () => reconcile(context),
          catch: hostError,
        });
        // `reconcile` may have queued more passes while this one ran; wait for the tail to stop moving.
        let settled: Promise<void>;
        do {
          settled = reconciliationTail;
          yield* Effect.tryPromise({ try: () => settled, catch: hostError });
        } while (settled !== reconciliationTail);
        // Each wait gets this fiber's interruption signal, not the enclosing scope's.
        const inspection = yield* Effect.tryPromise({
          try: (signal) => harness.inspect(withAbortSignal(signal, context)),
          catch: hostError,
        });
        if (inspection.tasks.length === 0) {
          // A pass admitted while inspecting still has to report its failed run.
          if (settled === reconciliationTail) return;
          continue;
        }
        yield* Effect.forEach(
          inspection.tasks,
          (task) =>
            Effect.tryPromise({
              try: (signal) =>
                harness.waitForTask(task.record.id, withAbortSignal(signal, context)),
              catch: hostError,
            }),
          { concurrency: "unbounded" },
        );
      }
    }),
  };
});

export type SessionHost = Effect.Success<ReturnType<typeof openSessionHost>>;
