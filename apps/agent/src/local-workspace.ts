import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PublicCheck } from "@caldero/domain";
import { Layer } from "effect";
import { makeGitWorkspace } from "./git-workspace.ts";
import { Workspace, WorkspaceStore } from "./ports.ts";
import { makeMemoryWorkspaceStore } from "./workspace-store.ts";

/** The workspace as local processes in a directory on this machine: for tests and local runs. */
export const LocalWorkspace = {
  layer: (options: {
    readonly root: string;
    readonly checks: ReadonlyArray<string>;
    readonly publicChecks?: ReadonlyArray<PublicCheck>;
    readonly store?: WorkspaceStore["Service"];
    readonly env?: ExecutionEnv;
  }) =>
    Layer.effect(
      Workspace,
      makeGitWorkspace({
        env: options.env ?? new NodeExecutionEnv({ cwd: `${options.root}/work` }),
        root: options.root,
        checks: options.checks,
        ...(options.publicChecks === undefined ? {} : { publicChecks: options.publicChecks }),
      }),
    ).pipe(
      Layer.provide(
        Layer.succeed(WorkspaceStore, options.store ?? makeMemoryWorkspaceStore().service),
      ),
    ),
};
