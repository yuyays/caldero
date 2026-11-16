import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { WorkspaceError, WorkspaceStore } from "./ports.ts";

/** Immutable checkpoints and candidates survive independent local runner processes. */
export const makeDiskWorkspaceStore = (root: string) => {
  const path = (key: string) => join(root, createHash("sha256").update(key).digest("hex"));
  return WorkspaceStore.of({
    put: Effect.fn("DiskWorkspaceStore.put")(function* (key, value) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(root, { recursive: true, mode: 0o700 });
          const temporary = `${path(key)}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
            try {
              await link(temporary, path(key));
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
                throw error;
              if ((await readFile(path(key), "utf8")) !== value)
                throw new Error("Immutable workspace blob conflict", { cause: error });
            }
          } finally {
            await rm(temporary, { force: true });
          }
        },
        catch: () => new WorkspaceError({ message: "Could not save the local workspace blob" }),
      });
    }),
    get: Effect.fn("DiskWorkspaceStore.get")(function* (key) {
      return yield* Effect.tryPromise({
        try: () => readFile(path(key), "utf8"),
        catch: () => new WorkspaceError({ message: "Could not read the local workspace blob" }),
      });
    }),
  });
};
