import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "@effect/vitest";
import { Events } from "@puchero/domain";
import { Effect, Layer } from "effect";
import { Base64 } from "effect/encoding";
import { makeFakeGitHub } from "./fake-github.ts";
import { LocalWorkspace } from "./local-workspace.ts";
import { GitHub, Projection, PublishError, Workspace } from "./ports.ts";
import { makeMemoryWorkspaceStore } from "./workspace-store.ts";
import { openSessionHost } from "./session-host.ts";
import {
  failing,
  makeMemoryProjection,
  makeProcess,
  runsForever,
  scriptedModels,
} from "./testing.ts";

const repo = { owner: "acme", name: "app" };
const source = [
  { path: "README.md", content: new TextEncoder().encode("# app\n"), executable: false },
  { path: "bin/run", content: new TextEncoder().encode("#!/bin/sh\n"), executable: true },
];
const labeled = Events.IssueLabeled.make({
  context: "Write the notes.",
  baseSha: "base-1",
  baseRef: "main",
});

/** A promise and the function that settles it, for steps a test waits on. */
const signal = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: Effect.promise(() => promise), fire: () => resolve() };
};

/**
 * One session with its own disk, storage and fake GitHub. `open` starts a host process; after it crashes, open the next
 * one, which recovers from what the first committed.
 */
const setup = Effect.fn("setup")(function* (
  options: {
    readonly checks?: (root: string) => ReadonlyArray<string>;
    readonly github?: Omit<Parameters<typeof makeFakeGitHub>[0], "source">;
    /** Runs when a tool starts writing a file, before the write. */
    readonly onWrite?: () => void;
    /** Runs when a validation starts. */
    readonly onValidate?: () => void;
    /** Every validation dies with this defect instead of running. */
    readonly validationDefect?: Error;
    /** A persisted session document whose JSON cannot be decoded on reopen. */
    readonly corruptState?: () => boolean;
    /** A historical JSON fixture returned at the persisted-document read seam. */
    readonly storedState?: () => string | undefined;
    readonly crashAtCheckpoint?: "uploaded" | "committed";
    readonly wrapGitHub?: (
      github: ReturnType<typeof GitHub.of>,
      crash: () => void,
    ) => ReturnType<typeof GitHub.of>;
  } = {},
) {
  const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-")));
  const github = makeFakeGitHub({ source, ...options.github });
  const projection = makeMemoryProjection();
  const scripted = scriptedModels();
  const durable = new MemoryStorage();
  const store = makeMemoryWorkspaceStore();
  let checkpointCrash = options.crashAtCheckpoint;
  let corruptWrites = 0;
  const workspace = LocalWorkspace.layer({
    root,
    store: store.service,
    checks: options.checks?.(root) ?? ["test -f notes.txt"],
  });

  const open = Effect.fn("open")(function* () {
    const process = makeProcess();
    // Everything the host touches goes through the process, so nothing of it outlives a crash.
    const gated = Layer.effect(
      Workspace,
      Effect.gen(function* () {
        const local = yield* Workspace;
        const watched = (recovery: Parameters<typeof local.env>[0]) => {
          const env = process.gate(local.env(recovery));
          return new Proxy(env, {
            get: (target, property, receiver) =>
              property === "writeFile"
                ? (...args: Parameters<typeof env.writeFile>) => {
                    options.onWrite?.();
                    return target.writeFile(...args);
                  }
                : Reflect.get(target, property, receiver),
          });
        };
        const checkpoint = (number: number) =>
          local.checkpoint(number).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (checkpointCrash === "uploaded") {
                  checkpointCrash = undefined;
                  process.crash();
                }
              }),
            ),
          );
        const validate = () => {
          options.onValidate?.();
          const defect = options.validationDefect;
          return defect === undefined ? local.validate() : Effect.die(defect);
        };
        return Workspace.of({ ...process.gate({ ...local, validate, checkpoint }), env: watched });
      }),
    ).pipe(Layer.provide(workspace));
    const rawGitHub = yield* GitHub.pipe(Effect.provide(github.layer));
    const services = Layer.mergeAll(
      gated,
      Layer.succeed(
        Projection,
        process.gate(yield* Projection.pipe(Effect.provide(projection.layer))),
      ),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(
          GitHub,
          process.gate(options.wrapGitHub?.(rawGitHub, process.crash) ?? rawGitHub),
        ),
      ),
    );
    const host = yield* openSessionHost({
      storage: process.gate(
        new Proxy(durable, {
          get(target, property, receiver) {
            if (property === "close") return async () => {};
            if (property === "document")
              return async (...args: Parameters<typeof durable.document>) => {
                const document = await target.document(...args);
                const storedState = options.storedState?.();
                if (storedState !== undefined && document?.record.kind === "puchero.session")
                  return { ...document, value: { ...document.value, state: storedState } };
                return options.corruptState?.() && document?.record.kind === "puchero.session"
                  ? { ...document, value: { ...document.value, state: "{broken stored JSON" } }
                  : document;
              };
            if (property !== "commit") return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof durable.commit>) => {
              // Explicit session-fault acceptance criterion: no document/task writes on an unreadable open.
              // Count the public Pi Storage.commit variants at the persistence seam.
              if (options.corruptState?.())
                corruptWrites += args[0]
                  .flat()
                  .filter(
                    (write) => write.type.startsWith("document.") || write.type === "task",
                  ).length;
              const result = await target.commit(...args);
              const pointer = args[0]
                .flat()
                .some(
                  (write) =>
                    (write.type === "document.create" || write.type === "document.change") &&
                    write.content.kind === "base" &&
                    typeof write.content.value.checkpoint === "object" &&
                    write.content.value.checkpoint !== null,
                );
              if (checkpointCrash === "committed" && pointer) {
                checkpointCrash = undefined;
                process.crash();
                throw new Error("Process crashed after pointer commit");
              }
              return result;
            };
          },
        }),
      ),
      session: { sessionId: "acme/app#7", repo, issue: 7 },
      models: scripted.models,
      model: scripted.model,
    }).pipe(Effect.provide(services));
    return { host, crash: process.crash, crashed: Effect.promise(() => process.crashed) };
  });

  const { host, crash, crashed } = yield* open();
  return {
    host,
    crash,
    crashed,
    open,
    root,
    github,
    projection,
    scripted,
    store,
    corruptWrites: () => corruptWrites,
  };
});

/** Runs the labeled issue through publication and returns the published candidate's binding. */
const publishCandidate = Effect.fn("publishCandidate")(function* (
  host: Effect.Success<ReturnType<typeof setup>>["host"],
) {
  yield* host.deliver(labeled, "delivery-1");
  yield* host.drain();
  const candidate = (yield* host.view()).state.candidate;
  if (candidate === null) return yield* Effect.die(new Error("No candidate was proposed"));
  return candidate.binding;
});

describe("SessionHost", () => {
  it.effect(
    "reads a legacy paused document and supports a fresh run or Stop without publishing the old candidate",
    () =>
      Effect.gen(function* () {
        const legacy = `{
        "sessionId":"acme/app#7","repo":{"owner":"acme","name":"app"},"issue":7,
        "policy":"observe","status":"awaitingApproval","revision":3,"runId":1,"version":1,
        "baseSha":"base-1","baseRef":"main","attempts":0,"queued":[],"pullRequest":null,
        "failure":null,"decidedBy":null,"updatedAt":1000,
        "candidate":{"binding":{"sessionId":"acme/app#7","version":1,"runId":1,
          "repo":{"owner":"acme","name":"app"},"baseSha":"base-1","baseRef":"main",
          "patchDigest":"old-missing-patch"},"evidence":"historical checks passed"}
      }`;
        for (const action of ["input", "stop"]) {
          let stored: string | undefined;
          const first = yield* setup({ storedState: () => stored });
          first.crash();
          stored = legacy;
          const next = yield* first.open();
          stored = undefined;
          yield* next.host.drain();
          const paused = yield* next.host.view();
          expect(paused).toMatchObject({
            state: { policy: "observe", status: "awaitingApproval", version: 1, decidedBy: null },
            patch: null,
            patchUnavailable: true,
          });
          expect(first.github.state.pullRequests).toHaveLength(0);
          const event =
            action === "input"
              ? Events.UserInput.make({ text: "Use bullet points." })
              : Events.Cancel.make({ actor: "ann" });
          expect(yield* next.host.deliver(event, "legacy-control")).toBe("applied");
          yield* next.host.drain();
          const result = yield* next.host.view();
          if (action === "input") {
            expect(result.state).toMatchObject({
              status: "published",
              runId: 2,
              version: 2,
              decidedBy: null,
            });
            expect(first.github.state.pullRequests).toHaveLength(1);
            expect(first.github.state.pullRequests[0]?.patch.digest).not.toBe("old-missing-patch");
          } else {
            expect(result.state).toMatchObject({ status: "cancelled", decidedBy: "ann" });
            expect(first.github.state.pullRequests).toHaveLength(0);
          }
        }
      }),
  );
  it.effect(
    "publishes automatically after validation and reconciles a lost response to one PR",
    () =>
      Effect.gen(function* () {
        const { host, github } = yield* setup({
          github: { dropResponses: { kind: "ambiguous", times: 1 } },
        });
        yield* host.deliver(labeled, "auto-label");
        yield* host.drain();
        const view = yield* host.view();
        expect(view.state).toMatchObject({
          status: "published",
          version: 1,
          runId: 1,
          decidedBy: null,
        });
        expect(view.state.candidate?.binding.patchDigest).toBe(view.patch?.digest);
        expect(view.state.candidate?.evidence).toContain("(exit 0)");
        expect(github.state.pullRequests).toHaveLength(1);
        expect(github.state.pullRequests[0]?.patch.digest).toBe(view.patch?.digest);
        expect(github.state.comments).toHaveLength(1);
        yield* host.deliver(labeled, "auto-label");
        yield* host.drain();
        expect(github.state.pullRequests).toHaveLength(1);
      }),
  );
  it.effect("never automatically publishes a patch that fails validation", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup({ checks: () => ["false"] });
      yield* host.deliver(labeled, "auto-failed-label");
      yield* host.drain();
      expect((yield* host.view()).state).toMatchObject({
        status: "failed",
        candidate: null,
        attempts: 3,
      });
      expect(github.state.pullRequests).toHaveLength(0);
    }),
  );
  it.effect(
    "refuses corrupt persisted state as a permanent fault without replacing the candidate",
    () =>
      Effect.gen(function* () {
        let corrupt = false;
        const { host, crash, open, corruptWrites } = yield* setup({ corruptState: () => corrupt });
        const binding = yield* publishCandidate(host);
        crash();
        corrupt = true;
        expect(yield* open().pipe(Effect.scoped, Effect.flip)).toMatchObject({
          _tag: "SessionFault",
          code: "state_unreadable",
        });
        expect(corruptWrites()).toBe(0);
        corrupt = false;
        const recovered = yield* open();
        expect((yield* recovered.host.view()).state.candidate?.binding).toEqual(binding);
      }),
  );

  it.effect("keeps published session details available when its frozen patch blob is lost", () =>
    Effect.gen(function* () {
      const { host, store, github } = yield* setup();
      const binding = yield* publishCandidate(host);
      store.blobs.clear();
      const missing = yield* host.view();
      expect(missing).toMatchObject({
        state: {
          status: "published",
          candidate: { binding },
          pullRequest: { url: "https://github.test/pull/100" },
        },
        patch: null,
        patchUnavailable: true,
      });
      expect(yield* host.deliver(Events.Cancel.make({ actor: "ann" }), "late-stop")).toBe("stale");
      expect((yield* host.view()).state.status).toBe("published");
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("retains a publish receipt in Pi when its host dies before returning the result", () =>
    Effect.gen(function* () {
      let interrupted = false;
      let resumedCommit: string | null = null;
      const first = yield* setup({
        wrapGitHub: (github, crash) => ({
          ...github,
          publish: (issue, binding, patch, journal) =>
            Effect.gen(function* () {
              const saved = yield* journal.read();
              if (saved === null) {
                yield* journal.save({
                  binding,
                  issue,
                  author: {
                    name: "bot",
                    email: "bot@example.com",
                    date: "2026-01-01T00:00:00Z",
                  },
                  message: "fixed message",
                  title: "fixed title",
                  body: "fixed body",
                  baseTree: "tree",
                  blobs: [],
                  treeSha: "new-tree",
                  commitSha: "committed-on-github",
                  refCreated: false,
                  pullRequest: null,
                });
                interrupted = true;
                crash();
                return yield* Effect.die(new Error("Process died after the durable receipt"));
              }
              resumedCommit = saved.commitSha;
              return yield* github.publish(issue, binding, patch, journal);
            }).pipe(
              Effect.catchTag("GitHubError", (error) =>
                Effect.fail(new PublishError({ kind: "ambiguous", message: error.message })),
              ),
            ),
        }),
      });
      yield* first.host.deliver(labeled, "auto-crash-label");
      yield* first.crashed;
      const next = yield* first.open();
      yield* next.host.drain();
      expect(interrupted).toBe(true);
      expect(resumedCommit).toBe("committed-on-github");
      expect((yield* next.host.view()).state.status).toBe("published");
      expect(first.github.state.pullRequests).toHaveLength(1);
    }),
  );
  for (const crashAtCheckpoint of ["uploaded", "committed"] as const) {
    it.effect(
      `recovers after checkpoint ${crashAtCheckpoint}, before the tool result, and restores on a changed boot`,
      () =>
        Effect.gen(function* () {
          const first = yield* setup({ crashAtCheckpoint });
          const seen: Array<string> = [];
          const reads: Array<string> = [];
          first.scripted.control.script = (transcript) => {
            const messages = transcript.messages;
            seen.push(JSON.stringify(messages));
            const results = messages.filter((message) => message.role === "toolResult");
            for (const result of results)
              if (result.toolName === "read" && !result.isError)
                reads.push(JSON.stringify(result.content));
            if (results.length === 0)
              return fauxAssistantMessage(
                fauxToolCall("write", { path: "notes.txt", content: "durable notes\n" }),
                { stopReason: "toolUse" },
              );
            if (!results.some((result) => result.toolName === "read"))
              return fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), {
                stopReason: "toolUse",
              });
            if (!results.some((result) => result.toolName === "write" && !result.isError))
              return fauxAssistantMessage(
                fauxToolCall("write", { path: "notes.txt", content: "durable notes\n" }),
                { stopReason: "toolUse" },
              );
            return fauxAssistantMessage("Done.");
          };
          yield* first.host.deliver(labeled, "delivery-1");
          yield* first.crashed;
          // Simulate a genuinely new container, rather than treating the DO crash as a reset.
          yield* Effect.promise(() => rm(join(first.root, "work"), { recursive: true }));
          yield* Effect.promise(() => writeFile(join(first.root, ".boot"), "new-container"));
          const recovered = yield* first.open();
          yield* recovered.host.drain();
          const { state, patch } = yield* recovered.host.view();
          expect(state.status).toBe("published");
          expect(patch?.files).toEqual([
            {
              path: "notes.txt",
              change: "write",
              content: Base64.encode("durable notes\n"),
              executable: false,
            },
          ]);
          const transcript = seen.join("\n");
          expect(transcript).toContain("interrupted");
          expect(transcript).toContain(
            `Your workspace was restored to checkpoint ${crashAtCheckpoint === "committed" ? 1 : 0}; re-check files before continuing.`,
          );
          expect(reads.some((content) => content.includes("durable notes"))).toBe(
            crashAtCheckpoint === "committed",
          );
        }),
    );
  }

  it.effect(
    "publishes binary content, deletion and mode changes from the stored patch unchanged",
    () =>
      Effect.gen(function* () {
        const { host, scripted, github } = yield* setup({ checks: () => ["test -f logo.bin"] });
        scripted.control.script = (transcript) =>
          transcript.messages.some((message) => message.role === "toolResult" && !message.isError)
            ? fauxAssistantMessage("Done.")
            : fauxAssistantMessage(
                fauxToolCall("bash", {
                  command:
                    "printf '\\000\\377\\001\\376' > logo.bin; rm README.md; chmod 644 bin/run",
                }),
                { stopReason: "toolUse" },
              );
        yield* publishCandidate(host);
        yield* host.drain();
        expect((yield* host.view()).state.status).toBe("published");
        expect(github.state.pullRequests[0]?.patch.files).toEqual([
          { path: "README.md", change: "delete" },
          {
            path: "bin/run",
            change: "write",
            content: Base64.encode("#!/bin/sh\n"),
            executable: false,
          },
          { path: "logo.bin", change: "write", content: "AP8B/g==", executable: false },
        ]);
      }),
  );

  it.effect("maps a faulted validation task to visible failure and exhausts the retry limit", () =>
    Effect.gen(function* () {
      const { host } = yield* setup({
        onValidate: () => {
          throw new Error("validation task crashed");
        },
      });
      yield* host.deliver(labeled, "delivery-1");
      yield* host.drain();
      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "failed", attempts: 3 });
      expect(state.failure).toContain("validation task crashed");
    }),
  );

  it.effect("runs a labeled issue once, validates it, and publishes its changes", () =>
    Effect.gen(function* () {
      const { host, projection } = yield* setup();

      expect(yield* host.deliver(labeled, "delivery-1")).toBe("applied");
      expect(yield* host.deliver(labeled, "delivery-1")).toBe("applied");
      expect(yield* host.deliver(labeled, "delivery-2")).toBe("duplicate");
      yield* host.drain();

      const { state, patch } = yield* host.view();
      expect(state).toMatchObject({ status: "published", runId: 1 });
      expect(patch?.files).toEqual([
        {
          path: "notes.txt",
          change: "write",
          content: Base64.encode("Write the notes.\n"),
          executable: false,
        },
      ]);
      expect(state.candidate?.binding.patchDigest).toBe(patch?.digest);
      expect(state.candidate?.evidence).toContain("(exit 0)");
      expect(projection.sessions.get("acme/app#7")?.revision).toBe(state.revision);
    }),
  );

  it.effect("ignores the old validation when input arrives while it runs", () =>
    Effect.gen(function* () {
      const validating = signal();
      const { host, root } = yield* setup({
        // Each check waits for the test to release it, so the input lands mid-validation.
        checks: (dir) => [`while [ ! -e ${dir}/release ]; do sleep 0.01; done; test -f notes.txt`],
        onValidate: validating.fire,
      });
      yield* host.deliver(labeled, "delivery-1");
      yield* validating.wait;

      yield* host.deliver(Events.UserInput.make({ text: "Use bullet points." }), "comment-1");
      yield* Effect.promise(() => writeFile(join(root, "release"), ""));
      yield* host.drain();

      const { state, patch } = yield* host.view();
      expect(state.status).toBe("published");
      expect(state.candidate?.binding).toMatchObject({ runId: 2, version: 1 });
      expect(patch?.files[0]).toMatchObject({ content: Base64.encode("Use bullet points.\n") });
    }),
  );

  it.effect("retries a failing validation, then fails the session visibly", () =>
    Effect.gen(function* () {
      const { host } = yield* setup({ checks: () => ["echo 2 tests failed; false"] });
      yield* host.deliver(labeled, "delivery-1");
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "failed", runId: 3, attempts: 3 });
      expect(state.failure).toContain("2 tests failed");
    }),
  );

  it.effect("fails the session visibly when validation breaks unexpectedly", () =>
    Effect.gen(function* () {
      const { host } = yield* setup({ validationDefect: new Error("disk vanished") });
      yield* host.deliver(labeled, "delivery-1");
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "failed", attempts: 3 });
      expect(state.failure).toContain("disk vanished");
    }),
  );

  it.effect("reports a run that ends without an answer, and retries it", () =>
    Effect.gen(function* () {
      const { host, scripted } = yield* setup();
      scripted.control.script = failing;
      yield* host.deliver(labeled, "delivery-1");
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "failed", runId: 3, attempts: 3 });
      expect(state.failure).toContain("provider unavailable");
    }),
  );

  it.effect("fails visibly when the branch already holds something else", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup({
        github: { branches: [["puchero/7-v1", "someone-else"]] },
      });
      yield* publishCandidate(host);
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state.status).toBe("failed");
      expect(state.failure).toContain("branch conflict");
      expect(github.state.pullRequests).toEqual([]);
    }),
  );

  it.effect("resumes a committed explicit retry after a crash without starting another retry", () =>
    Effect.gen(function* () {
      const { host, crash, open, scripted, github } = yield* setup();
      const normal = scripted.control.script;
      scripted.control.script = failing;
      yield* host.deliver(labeled, "first");
      yield* host.drain();
      const failed = (yield* host.view()).state;
      expect(failed).toMatchObject({ status: "failed", runId: 3 });
      scripted.control.script = normal;
      const retry = Events.Retry.make({ expectedRevision: failed.revision });
      const eventId = `retry:${failed.revision}`;
      yield* host.deliver(retry, eventId);
      crash();
      const next = yield* open();
      expect(yield* next.host.deliver(retry, eventId)).toBe("applied");
      yield* next.host.drain();
      expect((yield* next.host.view()).state).toMatchObject({
        status: "published",
        runId: 4,
        version: 1,
      });
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("deduplicates a redelivery after a crash before the acknowledgement", () =>
    Effect.gen(function* () {
      const { host, crash, open } = yield* setup();
      expect(yield* host.deliver(labeled, "delivery-1")).toBe("applied");
      crash();

      const next = yield* open();
      expect(yield* next.host.deliver(labeled, "delivery-1")).toBe("applied");
      yield* next.host.drain();

      expect((yield* next.host.view()).state).toMatchObject({
        status: "published",
        runId: 1,
      });
    }),
  );

  it.effect("opens exactly one PR when the host crashes after GitHub created it", () =>
    Effect.gen(function* () {
      let crashOnPublish = () => {};
      const { host, crash, crashed, open, github } = yield* setup({
        github: { afterPublish: () => crashOnPublish() },
      });
      crashOnPublish = () => {
        crashOnPublish = () => {};
        crash();
      };
      yield* host.deliver(labeled, "delivery-1");
      yield* crashed;

      const next = yield* open();
      yield* next.host.drain();

      expect((yield* next.host.view()).state.status).toBe("published");
      expect(github.state.pullRequests).toHaveLength(1);
      expect(github.state.comments).toHaveLength(1);
    }),
  );

  it.effect("records a tool the crash interrupted, and the run goes on", () =>
    Effect.gen(function* () {
      let crashOnWrite = () => {};
      const { host, crash, crashed, open, scripted } = yield* setup({
        onWrite: () => crashOnWrite(),
      });
      const seen: Array<string> = [];
      const script = scripted.control.script;
      scripted.control.script = (transcript, ...rest) => {
        for (const message of transcript.messages)
          if (message.role === "toolResult")
            for (const part of message.content) if (part.type === "text") seen.push(part.text);
        return script(transcript, ...rest);
      };
      crashOnWrite = () => {
        crashOnWrite = () => {};
        crash();
      };
      yield* host.deliver(labeled, "delivery-1");
      yield* crashed;

      const next = yield* open();
      yield* next.host.drain();

      expect(seen.some((text) => text.includes("interrupted"))).toBe(true);
      expect((yield* next.host.view()).state).toMatchObject({
        status: "published",
        runId: 1,
      });
    }),
  );

  it.effect("cancelling a running session stops the run and its commands", () =>
    Effect.gen(function* () {
      const { host, scripted } = yield* setup();
      const started = signal();
      scripted.control.script = (...args) => {
        started.fire();
        return runsForever(...args);
      };
      yield* host.deliver(labeled, "delivery-1");
      yield* started.wait;

      expect(yield* host.deliver(Events.Cancel.make({ actor: "ann" }), "cancel-1")).toBe("applied");
      yield* host.drain();

      expect((yield* host.view()).state).toMatchObject({ status: "cancelled", decidedBy: "ann" });
    }),
  );
});
