import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { makeFakeGitHub } from "./fake-github.ts";
import { LocalWorkspace } from "./local-workspace.ts";
import { Workspace } from "./ports.ts";
import { makeMemoryWorkspaceStore } from "./workspace-store.ts";
import {
  registerWorkspaceContract,
  workspaceContractSource,
} from "./workspace-contract.integration.ts";

registerWorkspaceContract(
  "LocalWorkspace",
  Effect.fn("prepared")(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "caldero-ws-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const store = makeMemoryWorkspaceStore();
    const workspace = yield* Workspace.pipe(
      Effect.provide(
        LocalWorkspace.layer({ root, checks: ["test -f logo.bin"], store: store.service }).pipe(
          Layer.provide(makeFakeGitHub({ source: workspaceContractSource }).layer),
        ),
      ),
    );
    yield* workspace.prepare({ owner: "acme", name: "app" }, "base-1");
    return {
      workspace,
      env: workspace.env(),
      corruptPatch: (digest: string, json: string) => store.service.put(`patches/${digest}`, json),
      reset: Effect.promise(async () => {
        await rm(join(root, "work"), { recursive: true });
        await writeFile(join(root, ".boot"), "replacement-container");
      }),
    };
  }),
);
