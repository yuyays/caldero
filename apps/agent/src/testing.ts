import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SessionState } from "@caldero/domain";
import { Effect, Layer } from "effect";
import { Projection } from "./ports.ts";

type Transcript = Parameters<FauxResponseFactory>[0];

/** The newest user message's text, and how many tool results followed it. */
const position = (transcript: Transcript) => {
  const messages = transcript.messages;
  const last = messages.findLastIndex((message) => message.role === "user");
  const user = messages[last];
  const text =
    user?.role !== "user"
      ? ""
      : typeof user.content === "string"
        ? user.content
        : user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const results = messages
    .slice(last + 1)
    .flatMap((message) => (message.role === "toolResult" ? [message] : []));
  return { text, results };
};

/** The default agent: writes the newest instruction into `notes.txt` until a write succeeds, then answers. */
export const writesInstruction: FauxResponseFactory = (transcript) => {
  const { text, results } = position(transcript);
  if (!results.some((result) => !result.isError))
    return fauxAssistantMessage(
      fauxToolCall("write", { path: "notes.txt", content: `${text}\n` }),
      {
        stopReason: "toolUse",
      },
    );
  return fauxAssistantMessage("Done.");
};

/** An agent that starts a command that runs until it is killed. */
export const runsForever: FauxResponseFactory = () =>
  fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 600" }), { stopReason: "toolUse" });

/** An agent whose every request fails, as a provider outage would. */
export const failing: FauxResponseFactory = () =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" });

/** Faux models whose behaviour a test can swap at any point; the model decides from the transcript alone. */
export const scriptedModels = () => {
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
  const control = { script: writesInstruction };
  const step: FauxResponseFactory = (...args) => control.script(...args);
  faux.setResponses(Array.from({ length: 1000 }, () => step));
  models.setProvider(faux.provider);
  return { models, model: { provider: "faux", modelId: "script" }, control } as const;
};

/** A session index in memory that keeps each session's newest revision. */
export const makeMemoryProjection = () => {
  const sessions = new Map<string, SessionState>();
  const layer = Layer.succeed(
    Projection,
    Projection.of({
      project: Effect.fn("MemoryProjection.project")(function* (state: SessionState) {
        const current = sessions.get(state.sessionId);
        if (current === undefined || current.revision < state.revision)
          sessions.set(state.sessionId, state);
      }),
    }),
  );
  return { sessions, layer };
};

/**
 * A process that can crash: `gate` passes a service through while the process is alive and fails every call after
 * `crash()`, so a crashed host cannot act on the world any more, as a dead process cannot.
 */
export const makeProcess = () => {
  let alive = true;
  const { promise: crashed, resolve } = Promise.withResolvers<void>();
  const dead = () => new Error("The process crashed");
  const gate = <S extends object>(service: S): S =>
    new Proxy(service, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          if (!alive) return Promise.reject(dead());
          const result: unknown = Reflect.apply(value, target, args);
          if (!Effect.isEffect(result)) return result;
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a transparent proxy keeps the service's own types
          return Effect.suspend(() => (alive ? result : Effect.die(dead())));
        };
      },
    });
  return {
    gate,
    alive: () => alive,
    crash: () => {
      alive = false;
      resolve();
    },
    /** Settles once the process crashed. */
    crashed,
  };
};
