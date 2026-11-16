import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi, afterEach } from "vite-plus/test";
import type { Credential } from "@earendil-works/pi-ai";
import { openLocalPi } from "./local-pi.ts";

const profile = Effect.fn("fixturePiProfile")(function* (
  settings: object,
  credential: Credential = { type: "api_key", key: "fixture-only-no-network" },
) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "puchero-pi-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.promise(async () => {
    await writeFile(join(root, "settings.json"), JSON.stringify(settings));
    await writeFile(join(root, "auth.json"), JSON.stringify({ openai: credential }));
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(root, ".pi/settings.json"),
      JSON.stringify({ defaultProvider: "other", defaultModel: "untrusted" }),
    );
  });
  return root;
});

afterEach(() => vi.unstubAllGlobals());

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
  it.effect("uses the saved per-model reasoning level ahead of the global default", () =>
    Effect.gen(function* () {
      const root = yield* profile({
        defaultProvider: "openai",
        defaultModel: "gpt-6.1-sol",
        defaultThinkingLevel: "low",
        modelThinkingLevels: { "openai/gpt-6.1-sol": "high" },
      });
      expect((yield* openLocalPi({ cwd: root, agentDir: root })).thinkingLevel).toBe("high");
    }),
  );
  it.effect("lets the SDK refresh and persist a saved OAuth login without an API key", () =>
    Effect.gen(function* () {
      const root = yield* profile(
        { defaultProvider: "openai", defaultModel: "gpt-6.1-sol" },
        {
          type: "oauth",
          access: "old-fixture-access",
          refresh: "old-fixture-refresh",
          expires: 1,
          clientId: "fixture-client",
        },
      );
      const fetcher = vi.fn<typeof fetch>((url, init) => {
        expect(new URL(String(url)).hostname).toBe("auth.openai.com");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("client_id")).toBe("fixture-client");
        return Promise.resolve(
          Response.json({
            access_token: "new-fixture-access",
            refresh_token: "new-fixture-refresh",
            expires_in: 3600,
            scope: "chatgpt.tokens.use.direct",
          }),
        );
      });
      vi.stubGlobal("fetch", fetcher);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* openLocalPi({ cwd: root, agentDir: root });
          expect(yield* Effect.promise(() => pi.models.checkAuth("openai"))).toMatchObject({
            type: "oauth",
          });
        }),
      );
      const saved: unknown = JSON.parse(
        yield* Effect.promise(() => readFile(join(root, "auth.json"), "utf8")),
      );
      expect(saved).toMatchObject({
        openai: { type: "oauth", access: "new-fixture-access", refresh: "new-fixture-refresh" },
      });
      yield* openLocalPi({ cwd: root, agentDir: root });
      expect(fetcher).toHaveBeenCalledOnce();
    }),
  );
});
