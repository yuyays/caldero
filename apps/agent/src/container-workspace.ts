import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { Effect, Layer } from "effect";
import { ContainerConnection, type NativeContainer } from "./container-connection.ts";
import { makeGitWorkspace } from "./git-workspace.ts";
import { errorMessage, Workspace, WorkspaceError, WorkspaceStore } from "./ports.ts";

/** A container environment and an R2 store have the same workspace contract as local processes. */
export const ContainerWorkspace = {
  layer: (options: {
    readonly id: string;
    readonly container: () => NativeContainer;
    readonly start: Effect.Effect<void, WorkspaceError>;
    readonly store: WorkspaceStore["Service"];
    readonly checks: ReadonlyArray<string>;
  }) =>
    Layer.effect(
      Workspace,
      Effect.gen(function* () {
        // oxlint-disable-next-line starter/runtime-boundary -- ContainerConnection invokes Alchemy start through a Promise
        const run = Effect.runPromiseWith(yield* Effect.context());
        const connection = yield* Effect.acquireRelease(
          Effect.sync(() => new ContainerConnection(options.container, () => run(options.start))),
          (opened) => Effect.sync(() => opened.close()),
        );
        return yield* makeGitWorkspace({
          env: new RemoteExecutionEnv({ connection, id: options.id, cwd: "/workspace/work" }),
          root: "/workspace",
          checks: options.checks,
        });
      }),
    ).pipe(Layer.provide(Layer.succeed(WorkspaceStore, options.store))),
};

/** Only the native R2 binding crosses the Promise boundary; no credentials enter the sandbox. */
export const makeR2WorkspaceStore = (
  bucket: {
    put(
      key: string,
      value: string,
      options?: { readonly onlyIf: { readonly etagDoesNotMatch: string } },
    ): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  },
  prefix: string,
) =>
  WorkspaceStore.of({
    put: Effect.fn("R2WorkspaceStore.put")(function* (key, value) {
      yield* Effect.tryPromise({
        try: () => bucket.put(`${prefix}/${key}`, value, { onlyIf: { etagDoesNotMatch: "*" } }),
        catch: (error) => new WorkspaceError({ message: errorMessage(error) }),
      });
    }),
    get: Effect.fn("R2WorkspaceStore.get")(function* (key) {
      const object = yield* Effect.tryPromise({
        try: () => bucket.get(`${prefix}/${key}`),
        catch: (error) => new WorkspaceError({ message: errorMessage(error) }),
      });
      if (object === null)
        return yield* new WorkspaceError({ message: `Missing workspace blob: ${key}` });
      return yield* Effect.tryPromise({
        try: () => object.text(),
        catch: (error) => new WorkspaceError({ message: errorMessage(error) }),
      });
    }),
  });
