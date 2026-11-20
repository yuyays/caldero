import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { InboxUnavailable } from "@caldero/contracts/inbox";
import { Config, Effect, Redacted, Schema } from "effect";
import { GitHubApp } from "./github-app.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import type { AuthOptions } from "./inbox-auth.ts";
import { GitHub } from "./ports.ts";
import { scriptedModels } from "./testing.ts";

/** Explicit bindings keep production configuration independent of the local process environment. */
export const agentEnvironment = {
  CALDERO_MODE: Config.String("CALDERO_MODE").pipe(Config.withDefault("production")),
  CALDERO_ORIGIN: Config.String("CALDERO_ORIGIN").pipe(Config.withDefault("http://localhost:1337")),
  CALDERO_REPO_OWNER: Config.String("CALDERO_REPO_OWNER").pipe(Config.withDefault("")),
  CALDERO_REPO_NAME: Config.String("CALDERO_REPO_NAME").pipe(Config.withDefault("")),
  CALDERO_DEV_TOKEN: Config.Redacted("CALDERO_DEV_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  CALDERO_DEV_LOGIN: Config.String("CALDERO_DEV_LOGIN").pipe(Config.withDefault("reviewer")),
  GITHUB_WEBHOOK_SECRET: Config.Redacted("GITHUB_WEBHOOK_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  GITHUB_APP_ID: Config.String("GITHUB_APP_ID").pipe(Config.withDefault("")),
  GITHUB_INSTALLATION_ID: Config.Int("GITHUB_INSTALLATION_ID").pipe(Config.withDefault(0)),
  GITHUB_PRIVATE_KEY: Config.Redacted("GITHUB_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  ACCESS_ISSUER: Config.String("ACCESS_ISSUER").pipe(Config.withDefault("")),
  ACCESS_AUDIENCE: Config.String("ACCESS_AUDIENCE").pipe(Config.withDefault("")),
  ACCESS_APPROVERS: Config.String("ACCESS_APPROVERS").pipe(Config.withDefault("{}")),
  OPENAI_API_KEY: Config.Redacted("OPENAI_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  CALDERO_MODEL: Config.String("CALDERO_MODEL").pipe(Config.withDefault("")),
  CALDERO_CHECKS: Config.String("CALDERO_CHECKS").pipe(Config.withDefault("")),
};
const decodeApprovers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeChecks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
);
const invalid = (message: string) => new InboxUnavailable({ message });

/** Missing production credentials fail closed; fake GitHub and models require an explicit development mode. */
export const readAgentSettings = Effect.fn("readAgentSettings")(function* () {
  const mode = yield* agentEnvironment.CALDERO_MODE;
  const origin = yield* agentEnvironment.CALDERO_ORIGIN;
  const repo = {
    owner: (yield* agentEnvironment.CALDERO_REPO_OWNER) || (mode === "dev" ? "acme" : ""),
    name: (yield* agentEnvironment.CALDERO_REPO_NAME) || (mode === "dev" ? "app" : ""),
  };
  const configuredInstallation = yield* agentEnvironment.GITHUB_INSTALLATION_ID;
  const installationId =
    configuredInstallation === 0 && mode === "dev" ? 42 : configuredInstallation;
  const webhookSecret = Redacted.value(yield* agentEnvironment.GITHUB_WEBHOOK_SECRET);
  const configuredChecks = yield* agentEnvironment.CALDERO_CHECKS;
  const checks = yield* decodeChecks(
    configuredChecks || (mode === "dev" ? '["test -f notes.txt"]' : ""),
  ).pipe(Effect.mapError(() => invalid("CALDERO_CHECKS must be a JSON array of commands")));
  if (
    !["dev", "production"].includes(mode) ||
    !repo.owner ||
    !repo.name ||
    !webhookSecret ||
    checks.length === 0 ||
    checks.some((command) => !command.trim()) ||
    installationId <= 0
  )
    return yield* invalid(
      "Configure the agent mode, repository, webhook secret, installation and validation checks",
    );
  const parsedOrigin = yield* Effect.try({
    try: () => new URL(origin),
    catch: () => invalid("CALDERO_ORIGIN must be an absolute origin"),
  });
  if (
    parsedOrigin.origin !== origin ||
    (mode === "production" && parsedOrigin.protocol !== "https:")
  )
    return yield* invalid("CALDERO_ORIGIN must be an exact HTTPS origin in production");
  const issuer = yield* agentEnvironment.ACCESS_ISSUER;
  const audience = yield* agentEnvironment.ACCESS_AUDIENCE;
  const approvers = yield* decodeApprovers(yield* agentEnvironment.ACCESS_APPROVERS).pipe(
    Effect.mapError(() => invalid("ACCESS_APPROVERS must map verified emails to GitHub logins")),
  );
  let auth: AuthOptions;
  if (mode === "dev") {
    if (issuer || audience || Object.keys(approvers).length > 0)
      return yield* invalid("Do not combine development authentication with Access configuration");
    auth = {
      mode: "dev",
      token: Redacted.value(yield* agentEnvironment.CALDERO_DEV_TOKEN),
      login: yield* agentEnvironment.CALDERO_DEV_LOGIN,
    };
  } else {
    if (!issuer.startsWith("https://") || !audience || Object.keys(approvers).length === 0)
      return yield* invalid("Production requires Access issuer, audience and approver mapping");
    auth = { mode: "access", issuer, audience, approvers };
  }
  return {
    mode,
    origin,
    repo,
    installationId,
    webhookSecret,
    checks,
    auth,
  };
});

export const makeAgentRuntime = Effect.fn("makeAgentRuntime")(function* () {
  const settings = yield* readAgentSettings();
  if (settings.mode === "dev") {
    const github = makeFakeGitHub({
      source: [
        {
          path: "README.md",
          content: new TextEncoder().encode("# Development fixture\n"),
          executable: false,
        },
      ],
    });
    return {
      settings,
      github: yield* GitHub.pipe(Effect.provide(github.layer)),
      ...scriptedModels(),
    };
  }
  const privateKey = Redacted.value(yield* agentEnvironment.GITHUB_PRIVATE_KEY);
  const appId = yield* agentEnvironment.GITHUB_APP_ID;
  const modelId = yield* agentEnvironment.CALDERO_MODEL;
  const key = Redacted.value(yield* agentEnvironment.OPENAI_API_KEY);
  if (!privateKey || !appId || !modelId || !key)
    return yield* invalid("Production requires GitHub App and model credentials");
  const github = yield* GitHubApp.make({
    repo: settings.repo,
    installationId: settings.installationId,
    appId,
    privateKey,
    author: { name: "caldero", email: "caldero@users.noreply.github.com" },
  });
  const models = createModels({
    authContext: {
      env: async (name) => (name === "OPENAI_API_KEY" ? key : undefined),
      fileExists: async () => false,
    },
  });
  models.setProvider(openaiProvider());
  return { settings, github, models, model: { provider: "openai", modelId } };
});
