import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
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
  type Wake,
} from "@earendil-works/pi-durable";
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
import { Cause, Clock, Effect, Exit, Schema } from "effect";
import {
  errorMessage,
  GitHub,
  type Patch,
  Projection,
  PublishError,
  Workspace,
  WorkspaceError,
} from "./ports.ts";

const context = BACKGROUND_CONTEXT;
const stateJson = Schema.fromJsonString(SessionState);
const decodeState = Schema.decodeSync(stateJson);
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
}>({
  kind: "puchero.session",
  version: 1,
  scope: "session",
  initial: () => ({ state: "", seen: {}, runs: {} }),
  checkpointWhen: () => true,
});

export class SessionHostError extends Schema.TaggedError<SessionHostError>()("SessionHostError", {
  message: Schema.String,
}) {}

const hostError = (error: unknown) => new SessionHostError({ message: errorMessage(error) });

/** What the inbox shows of one session. */
export interface SessionView {
  readonly state: SessionState;
  /** The candidate's frozen patch, while there is one. */
  readonly patch: Patch | null;
}

export interface SessionHostOptions {
  readonly storage: Storage;
  /** The session to create on first open; ignored once it exists. */
  readonly session: Parameters<typeof initialSession>[0];
  readonly models: Models;
  readonly model: ModelRef;
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
    for (const instruction of decision.instructions)
      await tx.createTask(Instructions, instruction, {
        ownership: { kind: "conversation" },
        conversationId: root(),
        // Instructions outlive runs: aborting the conversation must not abort the abort itself.
        background: true,
      });
    return decision.result;
  };

  const readState = async () => {
    const doc = await harness.snapshot(SessionDoc, context);
    return decodeState(doc?.state ?? "");
  };

  /** The event an instruction's action produced, if any. Expected failures become events; others fail the task. */
  const perform = (instruction: Instruction, state: SessionState) =>
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
          Effect.flatMap((patch) => github.publish(state.issue, binding, patch)),
          Effect.map((pullRequest): SessionEvent => Events.PublishSucceeded.make(pullRequest)),
          Effect.catchTag("PublishError", (error) =>
            Effect.succeed(Events.PublishFailed.make({ kind: error.kind, message: error.message })),
          ),
        ),
      Reconcile: ({ binding }) =>
        github.reconcile(state.issue, binding).pipe(
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
      Project: () => projection.project(state).pipe(Effect.as(undefined)),
      // Both act on Pi itself, in the task.
      AbortRun: () => Effect.succeed(undefined),
      Submit: () => Effect.succeed(undefined),
    });

  /** Runs one instruction, then commits its outcome; a crash before that commit runs it again. */
  const Instructions = defineTask<Instruction, { phase: "run"; attempt: number }, null>({
    name: "puchero.instruction",
    version: 1,
    initial: () => ({ phase: "run", attempt: 0 }),
    phases: {
      run: async (task, runtime) => {
        const instruction = task.input;
        const eventId = `instruction:${instruction.instructionId}`;
        const handle = await runtime.conversation(runtime.conversationId, context);
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
              }, context);
              return;
            }
          }
          await runtime.commit(async (tx) => {
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
          }, context);
          return;
        }

        if (Instruction.guards.AbortRun(instruction)) {
          // The run first, so it starts no command after the workspace is quiet.
          await handle.abort(context);
          await run(workspace.quiesce());
          await runtime.commit(() => done, context);
          return;
        }

        const outcome = await run(Effect.exit(perform(instruction, await readState())));
        if (Exit.isFailure(outcome)) {
          // Only comments and projections fail here. Nothing in the session waits for them, so they retry alone.
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
        await runtime.commit(async (tx) => {
          if (outcome.value !== undefined)
            await applyEvent(tx, outcome.value, eventId, runtime.now());
          return done;
        }, context);
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
        }, context);
      },
    },
    abort: (_task, runtime) => runtime.commit(() => aborted, context),
  });

  const Puchero = defineExtension({
    name: "puchero",
    tasks: [Instructions, RunAnswered],
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

  const harness: Harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          options.storage,
          {
            models: options.models,
            registry,
            env: () => workspace.env(),
            // Queued input behind a failed run is withdrawn; the session decides what runs next.
            settings: { afterFailedRun: "withdraw" },
            ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
            ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
          },
          context,
        ),
      catch: hostError,
    }),
    (opened) =>
      Effect.tryPromise({ try: () => opened.close(context), catch: hostError }).pipe(
        Effect.catch((error) => Effect.logWarning("Closing the session host failed", error)),
      ),
  );

  const pi = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: hostError });

  const conversation = yield* pi(() =>
    harness.root(context, {
      agent: { model: options.model, extensions: [CodingTools, Puchero] },
    }),
  );
  rootId = conversation.id;
  yield* pi(() =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(SessionDoc);
      if (doc.state === "") doc.state = encodeState(initialSession(options.session));
    }, context),
  );

  /**
   * Pi skips `afterRun` when a run fails or is aborted, so a failed run is found here instead: `pi.live` names the
   * failed run's inputs, and the inputs name their run. Runs at open and after every change of `pi.live`.
   */
  const syncRun = async () => {
    const live = await harness.snapshot(LiveDoc, root(), context);
    const failure = live?.runFailure;
    if (failure === undefined || live?.run !== undefined) return;
    const doc = await harness.snapshot(SessionDoc, context);
    let runId: number | undefined;
    for (const id of failure.inputs) {
      const submission = await (await harness.submission(id, context))?.status(context);
      const requestRun =
        submission?.requestId === undefined ? undefined : doc?.runs[submission.requestId];
      if (requestRun !== undefined) runId = Math.max(runId ?? 0, requestRun);
    }
    if (runId === undefined) return;
    const reason =
      failure.detail === undefined ? failure.reason : `${failure.reason}: ${failure.detail}`;
    const now = await run(Clock.currentTimeMillis);
    await harness.commit(
      (tx) =>
        applyEvent(
          tx,
          Events.RunFailed.make({ runId, reason }),
          `run-failed:${failure.taskId}`,
          now,
        ),
      context,
    );
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
      return yield* pi(() => harness.commit((tx) => applyEvent(tx, event, eventId, now), context));
    }),

    view: Effect.fn("SessionHost.view")(function* () {
      const state = yield* pi(readState);
      const candidate = state.candidate;
      const patch =
        candidate === null
          ? null
          : yield* workspace.patch(candidate.binding.patchDigest).pipe(Effect.mapError(hostError));
      return { state, patch } satisfies SessionView;
    }),

    /** The alarm: due sleeps, work a lost instance left, and failed runs not yet reported. */
    resume: () =>
      Effect.sync(() => {
        harness.resume();
        scheduleSync();
      }),
    wake: () => harness.wake(),

    /** Waits until no task is live and every failed run is reported. For tests and graceful shutdown. */
    drain: () =>
      pi(async () => {
        for (;;) {
          await syncing;
          const inspection = await harness.inspect(context);
          if (inspection.tasks.length === 0) return;
          await Promise.all(
            inspection.tasks.map((task) => harness.waitForTask(task.record.id, context)),
          );
        }
      }),
  };
});

export type SessionHost = Effect.Success<ReturnType<typeof openSessionHost>>;
