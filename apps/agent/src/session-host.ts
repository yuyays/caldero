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
  type Tx,
  type TaskId,
  wrapTool,
  type ToolRegistration,
  type Wake,
} from "@earendil-works/pi-durable";
import { SessionFault, type SessionView } from "@puchero/contracts/inbox";
export type { SessionView } from "@puchero/contracts/inbox";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  type DecisionResult,
  decide,
  Events,
  initialSession,
  Instruction,
  type SessionEvent,
  SessionState,
} from "@puchero/domain";
import { Cause, Clock, Effect, Exit, Result, Schema } from "effect";
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

/** The kind of the transcript entry every puchero input is placed as; its data names the run it belongs to. */
const inputKind = "puchero.input";

/**
 * The session's own durable state, committed with the transcript: the reducer state, the result of every delivered
 * event (so redelivery is a no-op), and which run each submitted input started or steered.
 */
const SessionDoc = defineDoc<{
  state: string;
  seen: Record<string, string>;
  runs: Record<string, number>;
  tasks?: Array<TaskId>;
}>({
  kind: "puchero.session",
  version: 1,
  scope: "session",
  initial: () => ({ state: "", seen: {}, runs: {}, tasks: [] }),
  checkpointWhen: () => true,
});

const WorkspaceDoc = defineDoc<{ bootId: string | null; checkpoint: Checkpoint | null }>({
  kind: "puchero.workspace",
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
  kind: "puchero.publish",
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

  let rootId: ConversationId | undefined;
  const root = () => {
    if (rootId === undefined) throw new Error("The session host is not open yet");
    return rootId;
  };

  /** Decides `event` and commits its state and instructions in `tx`; a seen `eventId` repeats its first result. */
  const applyEvent = async (
    tx: Tx,
    event: SessionEvent,
    eventId: string,
    now: number,
  ): Promise<DecisionResult> => {
    const doc = await tx.doc(SessionDoc);
    const seen = doc.seen[eventId];
    if (seen === "applied" || seen === "duplicate" || seen === "stale") return seen;
    const decision = decide(decodeState(doc.state), event, now);
    doc.seen[eventId] = decision.result;
    if (decision.result !== "applied") return decision.result;
    doc.state = encodeState(decision.state);
    for (const instruction of decision.instructions) {
      const id = await tx.createTask(Instructions, instruction, {
        ownership: { kind: "conversation" },
        conversationId: root(),
        // Instructions outlive runs: aborting the conversation must not abort the abort itself.
        background: true,
      });
      (doc.tasks ??= []).push(id);
    }
    return decision.result;
  };

  const readState = async (callContext = context) => {
    const doc = await harness.snapshot(SessionDoc, callContext);
    return decodeState(doc?.state ?? "");
  };

  /** The event an instruction's action produced, if any. Expected failures become events; others fail the task. */
  const perform = (instruction: Instruction, state: SessionState, journal: PublishJournal) =>
    Instruction.match(instruction, {
      Validate: ({ runId }) =>
        // A validation the session no longer waits for would only race the next run's edits.
        state.status !== "validating" || state.runId !== runId
          ? Effect.succeed(undefined)
          : workspace.validate().pipe(
              Effect.map((validation): SessionEvent =>
                validation.passed
                  ? Events.Validated.make({
                      runId,
                      patchDigest: validation.patch.digest,
                      evidence: validation.evidence,
                    })
                  : Events.ValidationFailed.make({ runId, evidence: validation.evidence }),
              ),
              Effect.catchTag("WorkspaceError", (error) =>
                Effect.succeed(Events.ValidationFailed.make({ runId, evidence: error.message })),
              ),
            ),
      Publish: ({ binding }) =>
        workspace.patch(binding.patchDigest).pipe(
          // The candidate's frozen patch is gone; publishing it again cannot help.
          Effect.mapError(
            (error) => new PublishError({ kind: "permanent", message: error.message }),
          ),
          Effect.flatMap((patch) => github.publish(state.issue, binding, patch, journal)),
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
      AbortRun: () => Effect.succeed(undefined),
      Submit: () => Effect.succeed(undefined),
    });

  /**
   * Pi skips `afterRun` when a run fails or is aborted, so a failed run is found from `pi.live` instead: its failure
   * names the run's inputs, and each input's request names the session run it belongs to. Reports it as `RunFailed`
   * in `tx`, at most once per failure; true when that changed the session.
   */
  const reportFailedRun = async (tx: Tx, now: number) => {
    const live = await tx.doc(LiveDoc, root());
    const failure = live.runFailure;
    if (failure === undefined || live.run !== undefined) return false;
    const doc = await tx.doc(SessionDoc);
    let runId: number | undefined;
    for (const id of failure.inputs) {
      const requestId = (await tx.submission(id))?.requestId;
      const requestRun = requestId === undefined ? undefined : doc.runs[requestId];
      if (requestRun !== undefined) runId = Math.max(runId ?? 0, requestRun);
    }
    if (runId === undefined) return false;
    const reason =
      failure.detail === undefined ? failure.reason : `${failure.reason}: ${failure.detail}`;
    const event = Events.RunFailed.make({ runId, reason });
    return (await applyEvent(tx, event, `run-failed:${failure.taskId}`, now)) === "applied";
  };

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
    name: "puchero.instruction",
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
            const state = await readState();
            const prepared = await run(
              Effect.exit(
                state.baseSha === null
                  ? Effect.fail(new WorkspaceError({ message: "the base commit is unknown" }))
                  : workspace.prepare(state.repo, state.baseSha),
              ),
              { signal: runtime.signal },
            );
            if (Exit.isFailure(prepared)) {
              // The session retries the run, within its attempt limit.
              const reason = `the workspace could not be prepared: ${errorMessage(Cause.squash(prepared.cause))}`;
              await runtime.commit(async (tx) => {
                await applyEvent(
                  tx,
                  Events.RunFailed.make({ runId: instruction.runId, reason }),
                  eventId,
                  runtime.now(),
                );
                return done;
              }, taskContext);
              return;
            }
          }
          await runtime.commit(async (tx) => {
            // A failed run not reported yet would otherwise be hidden by this input starting a new one.
            await reportFailedRun(tx, runtime.now());
            const doc = await tx.doc(SessionDoc);
            const current = decodeState(doc.state);
            if (current.status !== "running" || current.runId !== instruction.runId) {
              // The session moved on meanwhile. A start is obsolete; a steer is new input for whatever it does now.
              if (instruction.mode === "steer")
                await applyEvent(
                  tx,
                  Events.UserInput.make({ text: instruction.text }),
                  eventId,
                  runtime.now(),
                );
              return done;
            }
            // Admission before the commit's table writes, as Pi requires.
            await handle.submit(tx, {
              type: "input",
              content: instruction.text,
              requestId: instruction.instructionId,
              whenBusy: instruction.mode === "steer" ? "steer" : "followUp",
              entry: { kind: inputKind, data: { runId: instruction.runId } },
            });
            doc.runs[instruction.instructionId] = instruction.runId;
            return done;
          }, taskContext);
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
        const outcome = await run(Effect.exit(perform(instruction, await readState(), journal)), {
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
        await runtime.commit(async (tx) => {
          if (event !== undefined) await applyEvent(tx, event, eventId, runtime.now());
          return done;
        }, taskContext);
      },
    },
    abort: (_task, runtime) => runtime.commit(() => aborted, context),
  });

  /** Reports a run's answer to the session once the answer is committed. */
  const RunAnswered = defineTask<{ runId: number }, { phase: "report" }, null>({
    name: "puchero.run-answered",
    version: 1,
    initial: () => ({ phase: "report" }),
    phases: {
      report: async (task, runtime) => {
        const callContext = withAbortSignal(runtime.signal, context);
        await runtime.commit(async (tx) => {
          // Input that arrived meanwhile starts another run of the same run ID; its answer is the one to validate.
          const inbox = await tx.doc(InboxDoc, runtime.conversationId);
          const pending = inbox.items.some((item) => item.entry?.kind === inputKind);
          if (!pending)
            await applyEvent(
              tx,
              Events.RunAnswered.make({ runId: task.input.runId }),
              `run-answered:${task.id}`,
              runtime.now(),
            );
          return done;
        }, callContext);
      },
    },
    abort: (_task, runtime) => runtime.commit(() => aborted, context),
  });

  const Puchero = defineExtension({
    name: "puchero",
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
  registry.install(Puchero);

  const environment = workspace.env({
    read: async (signal) => {
      const callContext = withAbortSignal(signal, context);
      const saved = await harness.snapshot(WorkspaceDoc, callContext);
      const state = await readState(callContext);
      if (state.baseSha === null) throw new Error("Workspace has no base commit");
      return {
        repo: state.repo,
        baseSha: state.baseSha,
        bootId: saved?.bootId ?? null,
        checkpoint: saved?.checkpoint ?? null,
      };
    },
    restored: async (bootId, notice, signal) =>
      harness.commit(
        async (tx) => {
          const state = decodeState((await tx.doc(SessionDoc)).state);
          if (notice !== undefined && state.status !== "running") {
            // A restore after the answer reopens the run before the model edits again.
            await applyEvent(
              tx,
              Events.UserInput.make({ text: notice }),
              `workspace-reset:${bootId}`,
              await run(Clock.currentTimeMillis),
            );
          } else if (notice !== undefined)
            await conversation.submit(tx, {
              type: "input",
              content: notice,
              requestId: `workspace-reset:${bootId}`,
              whenBusy: "steer",
              entry: {
                kind: inputKind,
                data: { runId: state.runId },
              },
            });
          (await tx.doc(WorkspaceDoc)).bootId = bootId;
        },
        withAbortSignal(signal, context),
      ),
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
      Effect.tryPromise({ try: () => opened.close(context), catch: hostError }).pipe(
        Effect.catch((error) => Effect.logWarning("Closing the session host failed", error)),
      ),
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
        extensions: [CodingTools, Puchero],
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

  const syncRun = async () => {
    const now = await run(Clock.currentTimeMillis);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SessionDoc);
      const processed = new Set(doc.tasks ?? []);
      const tasks = await Promise.all(
        [...processed].map(async (id) => ({ id, task: await tx.task(id) })),
      );
      const answeredFaults = [];
      let cursor;
      do {
        const page = await tx.scanTasks(
          { kind: "puchero.run-answered", status: "terminal" },
          100,
          cursor,
        );
        answeredFaults.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      await reportFailedRun(tx, now);
      for (const task of answeredFaults) {
        if (task.state.status !== "terminal" || task.state.outcome.status !== "faulted") continue;
        const input = task.input;
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          typeof input.runId !== "number"
        )
          continue;
        await applyEvent(
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
        if (event !== undefined) await applyEvent(tx, event, `faulted:${id}`, now);
      }
      // applyEvent can append replacement tasks while handling a fault.
      doc.tasks = [...pending, ...(doc.tasks ?? []).filter((id) => !processed.has(id))];
    }, context);
  };
  let syncing = Promise.resolve();
  /** Runs `syncRun` after the previous one. A failure is logged; the next change, resume, or open runs it again. */
  const scheduleSync = () => {
    syncing = syncing
      .then(syncRun)
      .catch((error: unknown) => run(Effect.logError("Reporting a failed run failed", error)));
  };
  yield* pi(() =>
    harness.observeDoc(LiveDoc, root(), { advance: scheduleSync, end: () => undefined }, context),
  );
  harness.resume();
  scheduleSync();

  return {
    /** Decide and commit one event; the same `eventId` again returns its first result and changes nothing. */
    deliver: Effect.fn("SessionHost.deliver")(function* (event: SessionEvent, eventId: string) {
      const now = yield* Clock.currentTimeMillis;
      return yield* pi((callContext) =>
        harness.commit((tx) => applyEvent(tx, event, eventId, now), callContext),
      );
    }),

    view: Effect.fn("SessionHost.view")(function* () {
      const state = yield* pi(readState);
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
        const state = await readState(callContext);
        return state.status === "running" || state.status === "validating";
      }),

    /** Waits until no task is live and every failed run is reported. For tests and graceful shutdown. */
    drain: () =>
      pi(async () => {
        for (;;) {
          await syncRun();
          const settled = syncing;
          await settled;
          const inspection = await harness.inspect(context);
          if (inspection.tasks.length === 0) {
            if (settled === syncing) return;
            continue;
          }
          await Promise.all(
            inspection.tasks.map((task) => harness.waitForTask(task.record.id, context)),
          );
        }
      }),
  };
});

export type SessionHost = Effect.Success<ReturnType<typeof openSessionHost>>;
