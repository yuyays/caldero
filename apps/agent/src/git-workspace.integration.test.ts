import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Base64 } from "effect/encoding";
import { makeFakeGitHub } from "./fake-github.ts";
import { LocalWorkspace } from "./git-workspace.ts";
import { Workspace } from "./ports.ts";

const repo = { owner: "acme", name: "app" };
const text = (content: string) => new TextEncoder().encode(content);
const source = [
  { path: "README.md", content: text("# app\n"), executable: false },
  { path: "bin/run", content: text("#!/bin/sh\n"), executable: true },
];
const binary = new Uint8Array([0, 255, 1, 254]);

/** A local workspace over a fresh directory, prepared at the base commit. */
const prepared = Effect.fn("prepared")(function* () {
  const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-ws-")));
  const work = join(root, "work");
  const workspace = yield* Workspace.pipe(
    Effect.provide(
      LocalWorkspace.layer({ root, checks: ["test -f logo.bin"] }).pipe(
        Layer.provide(makeFakeGitHub({ source }).layer),
      ),
    ),
  );
  yield* workspace.prepare(repo, "base-1");
  return { workspace, root, work };
});

const edit = (operation: () => Promise<unknown>) => Effect.promise(operation);

describe("GitWorkspace", () => {
  it.effect("freezes binary files, deletions and modes into the patch", () =>
    Effect.gen(function* () {
      const { workspace, work } = yield* prepared();
      yield* edit(() => writeFile(join(work, "logo.bin"), binary));
      yield* edit(() => rm(join(work, "README.md")));
      yield* edit(() => chmod(join(work, "bin/run"), 0o644));

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

  it.effect("keeps a validated patch unchanged by later edits", () =>
    Effect.gen(function* () {
      const { workspace, work } = yield* prepared();
      yield* edit(() => writeFile(join(work, "logo.bin"), binary));
      const { patch } = yield* workspace.validate();

      yield* edit(() => writeFile(join(work, "logo.bin"), "changed"));

      expect(yield* workspace.patch(patch.digest)).toEqual(patch);
    }),
  );

  it.effect("refuses a stored patch that no longer matches its digest", () =>
    Effect.gen(function* () {
      const { workspace, work, root } = yield* prepared();
      yield* edit(() => writeFile(join(work, "logo.bin"), binary));
      const { patch } = yield* workspace.validate();

      const tampered = { ...patch, files: [] };
      yield* edit(() =>
        writeFile(join(root, "patches", `${patch.digest}.json`), JSON.stringify(tampered)),
      );

      const error = yield* Effect.flip(workspace.patch(patch.digest));
      expect(error.message).toContain("changed after validation");
    }),
  );

  it.effect("prepares once: a second prepare keeps the agent's edits", () =>
    Effect.gen(function* () {
      const { workspace, work } = yield* prepared();
      yield* edit(() => writeFile(join(work, "logo.bin"), binary));

      yield* workspace.prepare(repo, "base-1");

      const { patch } = yield* workspace.validate();
      expect(patch.files.map((file) => file.path)).toEqual(["logo.bin"]);
    }),
  );
});
