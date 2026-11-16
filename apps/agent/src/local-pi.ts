import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { join } from "node:path";

export class LocalPiError extends Schema.TaggedError<LocalPiError>()("LocalPiError", {
  message: Schema.String,
}) {}

/** Use Pi's own profile and credential runtime; OAuth refresh and locking remain SDK-owned. */
export const openLocalPi = Effect.fn("openLocalPi")(function* (options: {
  readonly cwd: string;
  readonly agentDir?: string;
}) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settings = yield* Effect.try({
    try: () => SettingsManager.create(options.cwd, agentDir, { projectTrusted: false }),
    catch: () => new LocalPiError({ message: "Could not load the local Pi settings" }),
  });
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (settings.drainErrors().length > 0)
    return yield* new LocalPiError({ message: "Could not load the local Pi settings" });
  if (!provider || !modelId)
    return yield* new LocalPiError({ message: "Select a default provider and model in Pi first" });
  const models = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) =>
        ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          modelsStorePath: join(agentDir, "models-store.json"),
          allowModelNetwork: false,
          signal,
        }),
      catch: () => new LocalPiError({ message: "Could not load the local Pi model runtime" }),
    }),
    (runtime) =>
      Effect.tryPromise({
        try: () => runtime.settleCredentialWrites(),
        catch: () =>
          new LocalPiError({ message: "Could not finish saving refreshed Pi credentials" }),
      }).pipe(Effect.catch((error) => Effect.logError(error.message))),
  );
  if (models.getModel(provider, modelId) === undefined)
    return yield* new LocalPiError({
      message: "The default Pi model is unavailable in its model catalog",
    });
  const auth = yield* Effect.tryPromise({
    try: (signal) => models.getAuth(provider, { signal }),
    catch: () =>
      new LocalPiError({ message: "Could not check the local Pi login; sign in with Pi again" }),
  });
  if (auth === undefined)
    return yield* new LocalPiError({ message: "Sign in to the selected provider with Pi first" });
  return {
    models,
    model: { provider, modelId },
    thinkingLevel: settings.getDefaultThinkingLevel() ?? "off",
  };
});
