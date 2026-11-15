import { Effect, Layer } from "effect";
import { WorkspaceError, WorkspaceStore } from "./ports.ts";

/** Keep the store across LocalWorkspace instances to simulate a process restart. */
export const makeMemoryWorkspaceStore = () => {
  const blobs = new Map<string, string>();
  const service = WorkspaceStore.of({
    put: Effect.fn("MemoryWorkspaceStore.put")(function* (key, value) {
      blobs.set(key, value);
    }),
    get: Effect.fn("MemoryWorkspaceStore.get")(function* (key) {
      const value = blobs.get(key);
      if (value === undefined)
        return yield* new WorkspaceError({ message: `Missing workspace blob: ${key}` });
      return value;
    }),
  });
  return { blobs, service, layer: Layer.succeed(WorkspaceStore, service) };
};
