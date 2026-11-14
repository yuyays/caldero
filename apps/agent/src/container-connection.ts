// A pi-env `Connection` whose daemon runs inside the Durable Object's container: it starts
// `pi-env serve` with `ctx.container.exec` instead of `child_process.spawn`, which Workers lack.
// Ported from @earendil-works/pi-env 1.5.2 `dist/connection.js` (MIT, Earendil); the framing,
// sync line, ping and request logic are unchanged. `RemoteExecutionEnv` uses only `info`,
// `session`, `request`, `kill` and `close`, so it accepts this class in place of its own.
import type { NativeDurableObjectState } from "@alchemy.run/cloudflare";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Buffer } from "node:buffer";
import { Schema } from "effect";
import {
  Connection,
  RemoteError,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
} from "@earendil-works/pi-env";

type Json = Record<string, unknown>;

const decodeJson = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeInfo = Schema.decodeUnknownSync(
  Schema.Struct({
    protocol: Schema.Number,
    version: Schema.String,
    os: Schema.String,
    arch: Schema.String,
    home: Schema.String,
    tmpdir: Schema.String,
    separator: Schema.String,
    cwd: Schema.String,
    driveCwds: Schema.Record(Schema.String, Schema.String),
    pid: Schema.Number,
    features: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  }),
);

const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;
const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
const SILENCE_LIMIT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const ABORT_GRACE_MS = 1000;

/** The native workerd container and process, structurally typed for the Workers transport. */
export type NativeContainer = NonNullable<NativeDurableObjectState["container"]>;
type NativeProcess = Awaited<ReturnType<NativeContainer["exec"]>>;
type NativeWriter = ReturnType<NonNullable<NativeProcess["stdin"]>["getWriter"]>;

type Pending = {
  resolve: (reply: Reply) => void;
  reject: (error: unknown) => void;
  onEvent?: (json: Json, payload: Uint8Array) => void;
};

class Session {
  pending = new Map<number, Pending>();
  chunks: Buffer[] = [];
  buffered = 0;
  synced = false;
  lastSeen = Date.now();
  timer: ReturnType<typeof setInterval> | undefined;
  live = true;
  readonly id: number;
  readonly process: NativeProcess;
  readonly writer: NativeWriter;
  readonly token: string;
  constructor(id: number, process: NativeProcess, writer: NativeWriter, token: string) {
    this.id = id;
    this.process = process;
    this.writer = writer;
    this.token = token;
  }
  peek(length: number): Buffer {
    if (this.chunks[0]!.length < length) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!.subarray(0, length);
  }
  consume(length: number): void {
    this.buffered -= length;
    while (length > 0) {
      const first = this.chunks[0]!;
      if (first.length <= length) {
        this.chunks.shift();
        length -= first.length;
      } else {
        this.chunks[0] = first.subarray(length);
        length = 0;
      }
    }
  }
}

function frame(
  type: number,
  id: number,
  json: Json,
  payload: Uint8Array = new Uint8Array(0),
): Buffer {
  const body = Buffer.from(
    JSON.stringify(json, (_k, v: unknown) => (typeof v === "string" ? v.toWellFormed() : v)),
    "utf8",
  );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(9 + body.length + payload.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(id, 5);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body, payload]);
}
const lost = (message: string) => new RemoteError({ code: "unknown", message, lost: true });
const aborted = () => new RemoteError({ code: "aborted", message: "aborted" });

/** One pi-env daemon in the container: started on the first request, started again after it is lost. */
export class ContainerConnection extends Connection {
  #container: () => NativeContainer;
  #startContainer: () => Promise<void>;
  #onLog: (text: string) => void;
  #session: Session | undefined;
  #ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
  #sessions = 0;
  #nextId = 1;
  #closed = false;

  constructor(
    container: () => NativeContainer,
    startContainer: () => Promise<void>,
    onLog: (text: string) => void = () => {},
  ) {
    super({ command: [] }); // All transport methods below replace the subprocess transport.
    this.#container = container;
    this.#startContainer = startContainer;
    this.#onLog = onLog;
  }

  override async info(signal?: AbortSignal): Promise<RemoteInfo> {
    return (await this.#connect(signal)).info;
  }
  override async session(): Promise<number> {
    return (await this.#connect()).session.id;
  }
  override async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (options.session !== undefined) {
      const current = this.#session;
      if (current === undefined || current.id !== options.session || !current.live)
        throw lost("pi-env connection lost");
      return this.#send(current, op, json, options);
    }
    const { session } = await this.#connect(options.signal);
    return this.#send(session, op, json, options);
  }
  override close(): void {
    this.#closed = true;
    if (this.#session)
      this.#teardown(
        this.#session,
        new RemoteError({ code: "unknown", message: "Connection closed" }),
      );
  }
  override kill(id: number, session: number): void {
    const current = this.#session;
    if (current?.id === session && current.live)
      this.#write(current, frame(CANCEL, id, { mode: "kill" }));
  }

  #connect(signal?: AbortSignal) {
    if (this.#closed)
      return Promise.reject(new RemoteError({ code: "unknown", message: "Connection closed" }));
    if (this.#ready === undefined) {
      const ready = this.#start();
      this.#ready = ready;
      ready.catch(() => {
        if (this.#ready === ready) this.#ready = undefined;
      });
    }
    return signal === undefined
      ? this.#ready
      : awaitWithContext(this.#ready, withAbortSignal(signal, BACKGROUND_CONTEXT));
  }

  #send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(lost("pi-env connection lost"));
    const id = this.#nextId++;
    return new Promise<Reply>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.#write(session, frame(CANCEL, id, {}));
        grace = setTimeout(() => {
          if (session.pending.get(id) !== pending) return;
          session.pending.delete(id);
          pending.reject(aborted());
        }, ABORT_GRACE_MS);
      };
      const done = () => {
        clearTimeout(grace);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const pending: Pending = {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      };
      session.pending.set(id, pending);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.onStart?.(id, session.id);
      this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
      if (options.signal?.aborted) onAbort();
    });
  }

  #write(session: Session, data: Uint8Array): void {
    if (session.live)
      session.writer
        .write(data)
        .catch(() => this.#teardown(session, lost("pi-env connection lost")));
  }

  async #start(): Promise<{ info: RemoteInfo; session: Session }> {
    const container = this.#container();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    let process: NativeProcess | undefined;
    for (let attempt = 0; process === undefined; attempt++) {
      if (this.#closed) throw lost("Connection closed");
      try {
        // Alchemy's start names this Container's image and is a no-op once it runs; calling it on every
        // attempt restarts a container that died with a lost instance while still reported as running.
        await this.#startContainer();
        process = await container.exec(["pi-env", "serve", "--token", token], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: "/workspace",
        });
      } catch (error) {
        if (attempt >= 30)
          throw new RemoteError({ code: "spawn_error", message: String(error), lost: true });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (this.#closed) {
      process.kill(9);
      throw lost("Connection closed");
    }
    if (process.stdin === null || process.stdout === null || process.stderr === null) {
      process.kill(9);
      throw lost("pi-env did not attach its streams");
    }
    const writer = process.stdin.getWriter();
    const session = new Session(++this.#sessions, process, writer, token);
    this.#session = session;
    void this.#pump(session, process.stdout, (chunk) => this.#onData(session, Buffer.from(chunk)));
    void this.#pump(session, process.stderr, (chunk) =>
      this.#onLog(new TextDecoder().decode(chunk)),
    );
    void process.exitCode.then(
      () => this.#teardown(session, lost("pi-env exited")),
      () => this.#teardown(session, lost("pi-env connection lost")),
    );
    session.timer = setInterval(() => {
      this.#write(session, frame(PING, 0, {}));
      if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS)
        this.#teardown(session, lost("pi-env connection timed out"));
    }, PING_INTERVAL_MS);
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, reject) => {
      startTimer = setTimeout(
        () => reject(lost("pi-env did not answer in time")),
        START_TIMEOUT_MS,
      );
    });
    try {
      const { json } = await Promise.race([
        this.#send(session, "hello", { protocol: 1 }, {}),
        timeout,
      ]);
      if (json.protocol !== 1) throw lost(`Unsupported protocol ${String(json.protocol)}`);
      return { info: decodeInfo(json), session };
    } catch (error) {
      this.#teardown(session, error);
      throw error;
    } finally {
      clearTimeout(startTimer);
    }
  }

  async #pump(
    session: Session,
    stream: NonNullable<NativeProcess["stdout"]>,
    onChunk: (chunk: Uint8Array) => void,
  ) {
    const reader = stream.getReader();
    try {
      while (session.live) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(value);
      }
    } catch {
      // The stream ends with the process; the exit handler tears the session down.
    }
  }

  #teardown(session: Session, error: unknown): void {
    if (!session.live) return;
    session.live = false;
    clearInterval(session.timer);
    if (this.#session === session) {
      this.#session = undefined;
      this.#ready = undefined;
    }
    session.writer.close().catch(() => {});
    try {
      session.process.kill(9);
    } catch {
      // Already gone.
    }
    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const request of pending) request.reject(error);
  }

  #onData(session: Session, chunk: Buffer): void {
    if (!session.live) return;
    session.lastSeen = Date.now();
    session.chunks.push(chunk);
    session.buffered += chunk.length;
    if (!session.synced) {
      const marker = Buffer.from(`PI-ENV ${session.token}\n`, "utf8");
      const all = session.peek(session.buffered);
      const index = all.indexOf(marker);
      if (index === -1) return;
      session.consume(index + marker.length);
      session.synced = true;
    }
    while (session.live && session.buffered >= 4) {
      const length = session.peek(4).readUInt32BE(0);
      if (length < 9 || length > MAX_FRAME)
        return this.#teardown(session, lost("Corrupt frame from pi-env"));
      if (session.buffered < 4 + length) return;
      const body = session.peek(4 + length).subarray(4);
      const type = body.readUInt8(0);
      const id = body.readUInt32BE(1);
      const jsonLength = body.readUInt32BE(5);
      if (jsonLength > length - 9)
        return this.#teardown(session, lost("Corrupt frame from pi-env"));
      let json: Json;
      try {
        json = decodeJson(JSON.parse(body.subarray(9, 9 + jsonLength).toString("utf8")));
      } catch {
        return this.#teardown(session, lost("Corrupt frame from pi-env"));
      }
      const payload = new Uint8Array(body.subarray(9 + jsonLength));
      session.consume(4 + length);
      const pending = session.pending.get(id);
      if (type === EVENT) {
        pending?.onEvent?.(json, payload);
        continue;
      }
      if ((type !== RESULT && type !== ERROR) || pending === undefined) continue;
      session.pending.delete(id);
      if (type === RESULT) pending.resolve({ json, payload, session: session.id });
      else pending.reject(new RemoteError(json));
    }
  }
}
