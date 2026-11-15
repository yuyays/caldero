import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { readAgentSettings } from "./agent-settings.ts";

const settings = (env: Record<string, string>) =>
  readAgentSettings().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
describe("Agent configuration", () => {
  it.effect(
    "requires explicit repository, installation and validation commands in production",
    () =>
      Effect.gen(function* () {
        const production = {
          PUCHERO_ORIGIN: "https://inbox.example.com",
          PUCHERO_REPO_OWNER: "team",
          PUCHERO_REPO_NAME: "product",
          GITHUB_INSTALLATION_ID: "123",
          PUCHERO_CHECKS: '["pnpm test"]',
          GITHUB_WEBHOOK_SECRET: "secret",
          ACCESS_ISSUER: "https://team.cloudflareaccess.com",
          ACCESS_AUDIENCE: "inbox",
          ACCESS_APPROVERS: '{"ann@example.com":"ann"}',
        };
        expect(yield* settings(production)).toMatchObject({
          repo: { owner: "team", name: "product" },
          installationId: 123,
          checks: ["pnpm test"],
        });
        expect(yield* settings({ ...production, PUCHERO_POLICY: "off" })).toMatchObject({
          repo: { owner: "team", name: "product" },
          installationId: 123,
          checks: ["pnpm test"],
        });
        for (const key of [
          "PUCHERO_REPO_OWNER",
          "PUCHERO_REPO_NAME",
          "GITHUB_INSTALLATION_ID",
          "PUCHERO_CHECKS",
        ]) {
          const missing = Object.fromEntries(
            Object.entries(production).filter(([name]) => name !== key),
          );
          expect(yield* settings(missing).pipe(Effect.flip)).toMatchObject({
            _tag: "InboxUnavailable",
          });
        }
        expect(
          yield* settings({ ...production, PUCHERO_CHECKS: '["   "]' }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InboxUnavailable" });
      }),
  );

  it.effect(
    "fails closed in production and permits local credentials only in explicit development",
    () =>
      Effect.gen(function* () {
        const local = {
          PUCHERO_MODE: "dev",
          PUCHERO_DEV_TOKEN: "local",
          GITHUB_WEBHOOK_SECRET: "fixture-secret",
        };
        expect(yield* settings(local)).toMatchObject({
          auth: { mode: "dev", token: "local" },
        });
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
            PUCHERO_REPO_OWNER: "owner",
            PUCHERO_REPO_NAME: "repo",
            GITHUB_INSTALLATION_ID: "12",
            PUCHERO_CHECKS: '["pnpm test"]',
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
