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
import { GitHub, Projection, Workspace } from "./ports.ts";
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
const labeled = Events.IssueLabeled.make({ context: "Write the notes.", baseSha: "base-1" });

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
    readonly crashAtCheckpoint?: "uploaded" | "committed";
  } = {},
) {
  const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-")));
  const github = makeFakeGitHub({ source, ...options.github });
  const projection = makeMemoryProjection();
  const scripted = scriptedModels();
  const durable = new MemoryStorage();
  const store = makeMemoryWorkspaceStore();
  let checkpointCrash = options.crashAtCheckpoint;
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
    const services = Layer.mergeAll(
      gated,
      Layer.succeed(
        Projection,
        process.gate(yield* Projection.pipe(Effect.provide(projection.layer))),
      ),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(GitHub, process.gate(yield* GitHub.pipe(Effect.provide(github.layer)))),
      ),
    );
    const host = yield* openSessionHost({
      storage: process.gate(
        new Proxy(durable, {
          get(target, property, receiver) {
            if (property !== "commit") return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof durable.commit>) => {
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
      session: { sessionId: "acme/app#7", repo, issue: 7, policy: "observe" },
      models: scripted.models,
      model: scripted.model,
    }).pipe(Effect.provide(services));
    return { host, crash: process.crash, crashed: Effect.promise(() => process.crashed) };
  });

  const { host, crash, crashed } = yield* open();
  return { host, crash, crashed, open, root, github, projection, scripted, store };
});

/** Runs the labeled issue to its first candidate and returns that candidate's binding. */
const propose = Effect.fn("propose")(function* (
  host: Effect.Success<ReturnType<typeof setup>>["host"],
) {
  yield* host.deliver(labeled, "delivery-1");
  yield* host.drain();
  const candidate = (yield* host.view()).state.candidate;
  if (candidate === null) return yield* Effect.die(new Error("No candidate was proposed"));
  return candidate.binding;
});

describe("SessionHost", () => {
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
          expect(state.status).toBe("awaitingApproval");
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
        const binding = yield* propose(host);
        yield* host.deliver(Events.Approve.make({ actor: "ann", binding }), "approve");
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

  it.effect("runs a labeled issue once, validates it, and waits for approval", () =>
    Effect.gen(function* () {
      const { host, projection } = yield* setup();

      expect(yield* host.deliver(labeled, "delivery-1")).toBe("applied");
      expect(yield* host.deliver(labeled, "delivery-1")).toBe("applied");
      expect(yield* host.deliver(labeled, "delivery-2")).toBe("duplicate");
      yield* host.drain();

      const { state, patch } = yield* host.view();
      expect(state).toMatchObject({ status: "awaitingApproval", runId: 1 });
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

  it.effect("publishes an approved candidate as exactly one PR and links it once", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup();
      const binding = yield* propose(host);

      const approve = Events.Approve.make({ actor: "ann", binding });
      expect(yield* host.deliver(approve, "approve-1")).toBe("applied");
      expect(yield* host.deliver(approve, "approve-2")).toBe("duplicate");
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state).toMatchObject({ status: "published", decidedBy: "ann" });
      expect(github.state.pullRequests).toHaveLength(1);
      expect(github.state.pullRequests[0]).toMatchObject({
        branch: "puchero/7-v1",
        patch: { digest: binding.patchDigest },
      });
      expect(github.state.comments).toHaveLength(1);
      expect(github.state.comments[0]?.text).toContain(state.pullRequest?.url);
    }),
  );

  it.effect("refuses an approval for anything but the candidate shown", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup();
      const binding = yield* propose(host);

      const stale = Events.Approve.make({
        actor: "ann",
        binding: { ...binding, patchDigest: "other" },
      });
      expect(yield* host.deliver(stale, "approve-1")).toBe("stale");
      yield* host.drain();

      expect((yield* host.view()).state.status).toBe("awaitingApproval");
      expect(github.state.pullRequests).toEqual([]);
    }),
  );

  it.effect("replaces the candidate when input arrives while it awaits approval", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup();
      const first = yield* propose(host);

      yield* host.deliver(Events.UserInput.make({ text: "Use bullet points." }), "comment-1");
      yield* host.drain();

      const { state, patch } = yield* host.view();
      expect(state.status).toBe("awaitingApproval");
      expect(state.candidate?.binding).toMatchObject({ version: 2, runId: 2 });
      expect(patch?.files[0]).toMatchObject({ content: Base64.encode("Use bullet points.\n") });
      const late = Events.Approve.make({ actor: "ann", binding: first });
      expect(yield* host.deliver(late, "approve-1")).toBe("stale");
      expect(github.state.pullRequests).toEqual([]);
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
      expect(state.status).toBe("awaitingApproval");
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

  it.effect("reconciles a publish whose response was lost instead of repeating it", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup({
        github: { dropResponses: { kind: "ambiguous", times: 1 } },
      });
      const binding = yield* propose(host);

      yield* host.deliver(Events.Approve.make({ actor: "ann", binding }), "approve-1");
      yield* host.drain();

      expect((yield* host.view()).state.status).toBe("published");
      expect(github.state.pullRequests).toHaveLength(1);
    }),
  );

  it.effect("fails visibly when the branch already holds something else", () =>
    Effect.gen(function* () {
      const { host, github } = yield* setup({
        github: { branches: [["puchero/7-v1", "someone-else"]] },
      });
      const binding = yield* propose(host);

      yield* host.deliver(Events.Approve.make({ actor: "ann", binding }), "approve-1");
      yield* host.drain();

      const { state } = yield* host.view();
      expect(state.status).toBe("failed");
      expect(state.failure).toContain("branch conflict");
      expect(github.state.pullRequests).toEqual([]);
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
        status: "awaitingApproval",
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
      const binding = yield* propose(host);
      crashOnPublish = () => {
        crashOnPublish = () => {};
        crash();
      };
      yield* host.deliver(Events.Approve.make({ actor: "ann", binding }), "approve-1");
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
        status: "awaitingApproval",
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
