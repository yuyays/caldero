// PROTOTYPE, throwaway.
//
// Hosts one Pi Durable Harness inside a Durable Object, following the README's
// "Sleeping and Waking Up" pattern: Pi owns the object's single alarm through `onWake`,
// and every activation (constructor or alarm) arms the alarm before calling `resume()`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { ContainerConnection, type NativeContainer } from "./container-connection.ts";

const context = BACKGROUND_CONTEXT;
const HEARTBEAT_MS = 30_000;
/** Seconds the scripted "long turn" sleeps in the container: far beyond one invocation's CPU budget. */
const LONG_SLEEP_S = Number(90);

/** The parts of the native DurableObjectState this host uses. */
export interface NativeState {
  readonly id: { toString(): string };
  readonly storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  } & Parameters<typeof openDurableObjectSqliteStorage>[0];
  readonly container?: NativeContainer;
  abort(reason?: string): void;
}

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ spike: event, at: new Date().toISOString(), ...data }));

/**
 * Scripted model, decided from the transcript alone so it answers the same after a restart:
 * per input run, step 1 writes a file, step 2 sleeps LONG_SLEEP_S in the container,
 * step 3 reads the boot marker and progress file back, step 4 answers.
 */
const script: FauxResponseFactory = (transcript) => {
  const messages = transcript.messages;
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "toolResult");
  const step = results.length;
  log("model.request", { step });
  if (step === 0)
    return fauxAssistantMessage(
      fauxToolCall("bash", { command: "echo step1 >> /workspace/progress.txt && cat /workspace/.boot" }),
      { stopReason: "toolUse" },
    );
  if (step === 1)
    return fauxAssistantMessage(
      fauxToolCall("bash", { command: `sleep ${LONG_SLEEP_S} && echo step2 >> /workspace/progress.txt && echo slept` }),
      { stopReason: "toolUse" },
    );
  if (step === 2)
    return fauxAssistantMessage(
      fauxToolCall("bash", { command: "echo boot=$(cat /workspace/.boot); cat /workspace/progress.txt" }),
      { stopReason: "toolUse" },
    );
  const last = results.at(-1);
  const text = last && last.role === "toolResult" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
  return fauxAssistantMessage(`done. last tool said: ${text.trim()}`);
};

export class PiHost {
  private constructor(
    private readonly state: NativeState,
    private readonly harness: Harness,
    private readonly root: Conversation,
  ) {}

  /** Open the Harness on the object's SQLite and resume whatever a lost instance left. */
  static async open(state: NativeState, startContainer: () => Promise<void>): Promise<PiHost> {
    // A fallback before anything can throw: an object whose open or recovery fails is started again.
    const fallback = Date.now() + 60_000;
    const current = await state.storage.getAlarm();
    if (current === null || current > fallback) await state.storage.setAlarm(fallback);

    const models = createModels();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
    faux.setResponses(Array.from({ length: 1000 }, () => script));
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(CodingTools);

    const connection = new ContainerConnection(
      () => {
        if (!state.container) throw new Error("No container is attached to this Durable Object");
        return state.container;
      },
      startContainer,
      (text) => log("pi-env.stderr", { text: text.trim() }),
    );
    const envId = `container:${state.id.toString()}`;

    let harness!: Harness;
    const arm = async (wake: Wake) => {
      const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
      const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
      if (at === undefined) await state.storage.deleteAlarm();
      else await state.storage.setAlarm(at);
    };
    const storage = await openDurableObjectSqliteStorage(state.storage);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: () => new RemoteExecutionEnv({ connection: connection as never, id: envId, cwd: "/workspace" }),
        onWake: (wake) => void arm(wake).catch(() => state.abort("Alarm write failed")),
      },
      context,
    );
    await arm(harness.wake());
    harness.resume();
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "script" }, extensions: [CodingTools], cwd: "/workspace" },
    });
    log("host.opened", { wake: harness.wake() });
    return new PiHost(state, harness, root);
  }

  /** The alarm: due sleeps and work a lost instance left. */
  async alarm(): Promise<void> {
    log("alarm", { wake: this.harness.wake() });
    await this.arm({ ...this.harness.wake(), active: true });
    this.harness.resume();
  }

  /** Durably admit input; a repeated `requestId` returns the original submission. */
  async submit(text: string, requestId: string): Promise<{ submissionId: string }> {
    await this.arm({ ...this.harness.wake(), active: true });
    const submission = await this.root.submit({ type: "input", content: text, requestId }, context);
    log("submit", { requestId, submissionId: submission.id });
    return { submissionId: String(submission.id) };
  }

  /** The full relevant state, printed after every action. */
  async status() {
    const view = await this.root.context(context);
    const transcript = view.messages.map((m) => {
      if (m.role === "user") return { role: "user", text: typeof m.content === "string" ? m.content : "[content]" };
      if (m.role === "assistant")
        return {
          role: "assistant",
          content: m.content.map((c) =>
            c.type === "text" ? c.text : c.type === "toolCall" ? `toolCall ${c.name} ${JSON.stringify(c.arguments)}` : c.type,
          ),
        };
      if (m.role === "toolResult")
        return {
          role: "toolResult",
          isError: m.isError,
          text: m.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim().slice(0, 300),
        };
      return { role: m.role };
    });
    const inspection = await this.harness.inspect(context);
    const tasks = inspection.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status, scheduler: t.state.kind }));
    return {
      objectId: this.state.id.toString(),
      wake: this.harness.wake(),
      alarm: await this.state.storage.getAlarm(),
      containerRunning: this.state.container?.running ?? null,
      scheduling: inspection.scheduling,
      liveTasks: tasks,
      transcript,
    };
  }

  private async arm(wake: Wake): Promise<void> {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
    const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
    if (at === undefined) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(at);
  }
}
