import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { Base64 } from "effect/encoding";
import type { Workspace, WorkspaceError } from "./ports.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

const repo = { owner: "acme", name: "app" };
const text = (content: string) => new TextEncoder().encode(content);
export const workspaceContractSource = [
  { path: "README.md", content: text("# app\n"), executable: false },
  { path: "bin/run", content: text("#!/bin/sh\n"), executable: true },
];
const binary = new Uint8Array([0, 255, 1, 254]);

const edit = <A>(operation: () => Promise<A>) => Effect.promise(operation);

export interface WorkspaceContractFixture {
  readonly workspace: Workspace["Service"];
  readonly env: ExecutionEnv;
  readonly corruptPatch: (digest: string, json: string) => Effect.Effect<void, WorkspaceError>;
  readonly reset: Effect.Effect<void, WorkspaceError>;
}

/** Run the same contract against a prepared local or container adapter; reset replaces its boot and disk. */
export const registerWorkspaceContract = (
  name: string,
  prepared: () => Effect.Effect<WorkspaceContractFixture, WorkspaceError, Scope.Scope>,
) =>
  // oxlint-disable-next-line vitest/valid-title -- the same named contract runs against multiple adapters
  describe(name, () => {
    it.effect("freezes binary files, deletions and modes into the patch", () =>
      Effect.gen(function* () {
        const { workspace, env } = yield* prepared();
        yield* edit(() => env.writeFile("logo.bin", binary, BACKGROUND_CONTEXT));
        yield* edit(() => env.exec(["rm", "README.md"], undefined, BACKGROUND_CONTEXT));
        yield* edit(() => env.exec(["chmod", "644", "bin/run"], undefined, BACKGROUND_CONTEXT));

        const { passed, patch } = yield* workspace.validate();

        expect(passed).toBe(true);
        expect(patch.files).toEqual([
          { path: "README.md", change: "delete" },
          {
            path: "bin/run",
            change: "write",
            content: Base64.encode("#!/bin/sh\n"),
            executable: false,
          },
          { path: "logo.bin", change: "write", content: Base64.encode(binary), executable: false },
        ]);
      }),
    );

    it.effect("keeps a validated patch unchanged by later edits and disk loss", () =>
      Effect.gen(function* () {
        const { workspace, env, reset } = yield* prepared();
        yield* edit(() => env.writeFile("logo.bin", binary, BACKGROUND_CONTEXT));
        const { patch } = yield* workspace.validate();

        yield* edit(() => env.writeFile("logo.bin", "changed", BACKGROUND_CONTEXT));
        yield* reset;

        expect(yield* workspace.patch(patch.digest)).toEqual(patch);
      }),
    );

    it.effect("refuses a stored patch that no longer matches its digest", () =>
      Effect.gen(function* () {
        const { workspace, env, corruptPatch } = yield* prepared();
        yield* edit(() => env.writeFile("logo.bin", binary, BACKGROUND_CONTEXT));
        const { patch } = yield* workspace.validate();

        const tampered = { ...patch, files: [] };
        yield* corruptPatch(patch.digest, JSON.stringify(tampered));

        const error = yield* Effect.flip(workspace.patch(patch.digest));
        expect(error.message).toContain("changed after validation");
      }),
    );

    it.effect(
      "restores the committed full checkpoint only after a changed boot, including binary, deletion and mode",
      () =>
        Effect.gen(function* () {
          const { workspace, env: raw, reset } = yield* prepared();
          let bootId: string | null = null;
          let checkpoint: { number: number; digest: string } | null = null;
          const notices: Array<string> = [];
          const env = workspace.env({
            read: async () => ({ repo, baseSha: "base-1", bootId, checkpoint }),
            restored: async (boot, notice) => {
              bootId = boot;
              if (notice !== undefined) notices.push(notice);
            },
          });
          const context = BACKGROUND_CONTEXT;
          yield* edit(() => env.writeFile("logo.bin", binary, context));
          yield* edit(() => env.exec(["rm", "README.md"], undefined, context));
          yield* edit(() => env.exec(["chmod", "644", "bin/run"], undefined, context));
          checkpoint = yield* workspace.checkpoint(1);
          // A new environment / DO process with the same boot must preserve uncheckpointed disk changes.
          yield* edit(() => raw.writeFile("scratch", "survives a DO restart", BACKGROUND_CONTEXT));
          const scratch = yield* edit(() => env.readTextFile("scratch", context));
          expect(scratch).toEqual({ ok: true, value: "survives a DO restart" });
          expect(notices).toEqual([]);
          yield* reset;
          const restored = yield* edit(() => env.readBinaryFile("logo.bin", context));
          expect(restored.ok ? Array.from(restored.value) : restored.error.message).toEqual([
            0, 255, 1, 254,
          ]);
          expect(notices).toEqual([
            "Your workspace was restored to checkpoint 1; re-check files before continuing.",
          ]);
          const { patch } = yield* workspace.validate();
          expect(patch.files).toEqual([
            { path: "README.md", change: "delete" },
            {
              path: "bin/run",
              change: "write",
              content: Base64.encode("#!/bin/sh\n"),
              executable: false,
            },
            {
              path: "logo.bin",
              change: "write",
              content: Base64.encode(binary),
              executable: false,
            },
          ]);
        }),
    );

    it.effect("restores a checkpoint that replaces a directory with a file", () =>
      Effect.gen(function* () {
        const { workspace, reset } = yield* prepared();
        let bootId: string | null = null;
        let checkpoint: { number: number; digest: string } | null = null;
        const env = workspace.env({
          read: async () => ({ repo, baseSha: "base-1", bootId, checkpoint }),
          restored: async (boot) => {
            bootId = boot;
          },
        });
        yield* edit(() => env.remove("bin", { recursive: true }, BACKGROUND_CONTEXT));
        yield* edit(() => env.writeFile("bin", "flat file\n", BACKGROUND_CONTEXT));
        checkpoint = yield* workspace.checkpoint(1);
        yield* reset;
        const restored = yield* edit(() => env.readTextFile("bin", BACKGROUND_CONTEXT));
        expect(restored).toEqual({ ok: true, value: "flat file\n" });
        const { patch } = yield* workspace.validate();
        expect(patch.files).toEqual([
          {
            path: "bin",
            change: "write",
            content: Base64.encode("flat file\n"),
            executable: false,
          },
          { path: "bin/run", change: "delete" },
        ]);
      }),
    );

    it.effect("prepares once: a second prepare keeps the agent's edits", () =>
      Effect.gen(function* () {
        const { workspace, env } = yield* prepared();
        yield* edit(() => env.writeFile("logo.bin", binary, BACKGROUND_CONTEXT));

        yield* workspace.prepare(repo, "base-1");

        const { patch } = yield* workspace.validate();
        expect(patch.files.map((file) => file.path)).toEqual(["logo.bin"]);
      }),
    );
  });
