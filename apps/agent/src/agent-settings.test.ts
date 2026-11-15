import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { readAgentSettings } from "./agent-settings.ts";

const settings = (env: Record<string, string>) =>
  readAgentSettings().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
describe("Agent configuration", () => {
  it.effect(
    "fails closed in production and permits local credentials only in explicit development",
    () =>
      Effect.gen(function* () {
        const local = {
          PUCHERO_MODE: "dev",
          PUCHERO_DEV_TOKEN: "local",
          GITHUB_WEBHOOK_SECRET: "fixture-secret",
        };
        expect((yield* settings(local)).auth).toMatchObject({ mode: "dev", token: "local" });
        for (const env of [
          {},
          { ...local, PUCHERO_MODE: "production", PUCHERO_ORIGIN: "https://inbox.example.com" },
          { ...local, ACCESS_ISSUER: "https://team.cloudflareaccess.com" },
          { ...local, PUCHERO_CHECKS: "[]" },
        ]) {
          expect(yield* settings(env).pipe(Effect.flip)).toMatchObject({
            _tag: "InboxUnavailable",
          });
        }
        expect(
          (yield* settings({
            GITHUB_WEBHOOK_SECRET: "secret",
            PUCHERO_ORIGIN: "https://inbox.example.com",
            ACCESS_ISSUER: "https://team.cloudflareaccess.com",
            ACCESS_AUDIENCE: "inbox",
            ACCESS_APPROVERS: '{"ann@example.com":"ann"}',
          })).auth,
        ).toEqual({
          mode: "access",
          issuer: "https://team.cloudflareaccess.com",
          audience: "inbox",
          approvers: { "ann@example.com": "ann" },
        });
      }),
  );
});
