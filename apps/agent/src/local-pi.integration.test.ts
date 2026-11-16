import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { openLocalPi } from "./local-pi.ts";

const profile = Effect.fn("fixturePiProfile")(function* (settings: object) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-pi-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.promise(async () => {
    await writeFile(join(root, "settings.json"), JSON.stringify(settings));
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-only-no-network" } }),
    );
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(root, ".pi/settings.json"),
      JSON.stringify({ defaultProvider: "other", defaultModel: "untrusted" }),
    );
  });
  return root;
});

describe("Installed Pi profile", () => {
  it.effect(
    "uses SDK-owned credentials and saved defaults without trusting workspace settings",
    () =>
      Effect.gen(function* () {
        const root = yield* profile({
          defaultProvider: "openai",
          defaultModel: "gpt-6.1-sol",
          defaultThinkingLevel: "medium",
        });
        const pi = yield* openLocalPi({ cwd: root, agentDir: root });
        expect(pi.model).toEqual({ provider: "openai", modelId: "gpt-6.1-sol" });
        expect(pi.thinkingLevel).toBe("medium");
        expect(yield* Effect.promise(() => pi.models.checkAuth("openai"))).toMatchObject({
          type: "api_key",
        });
      }),
  );
  it.effect("requires a selected default instead of silently choosing a model", () =>
    Effect.gen(function* () {
      const root = yield* profile({});
      expect(yield* openLocalPi({ cwd: root, agentDir: root }).pipe(Effect.flip)).toMatchObject({
        _tag: "LocalPiError",
        message: "Select a default provider and model in Pi first",
      });
    }),
  );
  it.effect("matches Pi's medium reasoning default when the profile does not set one", () =>
    Effect.gen(function* () {
      const root = yield* profile({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol" });
      expect((yield* openLocalPi({ cwd: root, agentDir: root })).thinkingLevel).toBe("medium");
    }),
  );
});
