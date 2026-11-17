import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import type { LocalSessionStatus, LocalStatus } from "@puchero/contracts/local-status";
import { SessionState, type Repo } from "@puchero/domain";
import { Effect, Result, Schema } from "effect";
import { decodeWatchReceipt } from "./local-watch-receipt.ts";
import { SessionDoc } from "./session-document.ts";
import { sessionIssue } from "./session-identity.ts";

export class LocalStatusError extends Schema.TaggedError<LocalStatusError>()("LocalStatusError", {
  message: Schema.String,
}) {}

const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const optionalRead = Effect.fn("LocalStatus.optionalRead")(
  <A>(read: () => Promise<A>, message: string) =>
    Effect.tryPromise({
      try: () =>
        read().catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        }),
      catch: () => new LocalStatusError({ message }),
    }),
);
const decodeDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ state: Schema.String })),
);
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionState));
const exec = promisify(execFile);

/** Read the owning document checkpoint, never opening a Harness or applying SQLite migrations. */
const readSession = Effect.fn("LocalStatus.readSession")(function* (
  path: string,
  repo: Repo,
  issue: number,
) {
  const unavailable = () =>
    new LocalStatusError({
      message: "Session storage is unreadable or incompatible with this reader",
    });
  const snapshot = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteDatabase(path, { mode: "read-only" }),
      catch: unavailable,
    }),
    (database) =>
      Effect.tryPromise({
        // One external read transaction keeps the schema and revision in the same WAL snapshot.
        try: () =>
          database.transaction(async (transaction) => {
            const metadata = await transaction.get<{ version: number }>(
              "SELECT version FROM durable_schema WHERE singleton = 1",
            );
            if (metadata?.version !== CURRENT_SQLITE_SCHEMA_VERSION)
              return { version: metadata?.version, rows: [] };
            const rows = await transaction.all<{
              kind: unknown;
              version: unknown;
              content: unknown;
            }>(
              `
          SELECT r.kind, r.version, r.content
          FROM documents d LEFT JOIN document_revisions r ON r.document_id = d.id
            AND r.seq = (SELECT MAX(seq) FROM document_revisions WHERE document_id = d.id)
          WHERE d.kind = ? AND d.scope_kind = 'session' AND d.family = 0 AND d.retired_at IS NULL
          LIMIT 2`,
              JSON.stringify(SessionDoc.definition.kind),
            );
            return { version: metadata.version, rows };
          }),
        catch: unavailable,
      }),
    (database) => Effect.tryPromise({ try: () => database.close(), catch: unavailable }),
  );
  if (snapshot.version !== CURRENT_SQLITE_SCHEMA_VERSION)
    return yield* new LocalStatusError({
      message: "Unsupported Pi SQLite schema; status did not migrate it",
    });
  const revision = snapshot.rows[0];
  if (snapshot.rows.length === 0) return null;
  // SessionDoc always checkpoints; accepting a delta here would silently report an older state.
  if (
    snapshot.rows.length !== 1 ||
    revision?.kind !== "base" ||
    revision.version !== SessionDoc.definition.version
  )
    return yield* new LocalStatusError({
      message: "Session document is missing or has an unsupported revision",
    });
  const document = yield* decodeDocument(revision.content).pipe(Effect.mapError(unavailable));
  if (document.state === "") return null;
  const state = yield* decodeState(document.state).pipe(Effect.mapError(unavailable));
  if (
    state.repo.owner !== repo.owner ||
    state.repo.name !== repo.name ||
    state.issue !== issue ||
    sessionIssue(repo, state.sessionId) !== issue
  )
    return yield* new LocalStatusError({
      message: "Stored session identity does not match this repository and issue",
    });
  return state;
});

/** Kernel lock ownership is observable; it is not a heartbeat or proof of watcher health. */
const inspectWatcher = Effect.fn("LocalStatus.inspectWatcher")(function* (stateRoot: string) {
  const lockPath = join(stateRoot, ".watch.lock");
  const found = yield* optionalRead(
    () => stat(lockPath, { bigint: true }),
    "Could not inspect the watch lock",
  );
  if (!found) return { lock: "free" as const, pid: null, error: null };
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      exec("lslocks", ["--raw", "--noheadings", "--output", "PID,INODE,MAJ:MIN,TYPE"], {
        signal,
        encoding: "utf8",
      }),
    catch: () =>
      new LocalStatusError({ message: "Could not query OS locks; watcher ownership is unknown" }),
  });
  return yield* Effect.try({
    try: () => {
      // Linux dev_t encoding (sys/sysmacros.h); use IDs because lslocks paths can be unresolved.
      const major = ((found.dev & 0xfff00n) >> 8n) | ((found.dev & 0xfffff00000000000n) >> 32n);
      const minor = (found.dev & 0xffn) | ((found.dev & 0xffffff00000n) >> 12n);
      const device = `${major}:${minor}`;
      for (const line of result.stdout.split("\n").filter((row) => row.trim())) {
        const fields = line.trim().split(/\s+/);
        const [pid, inode, dev, kind] = fields;
        if (fields.length !== 4 || !pid || !inode || !dev || !kind)
          throw new Error("Invalid lock row");
        if (kind !== "FLOCK") continue;
        if (!/^\d+$/.test(inode) || !/^\d+:\d+$/.test(dev) || !/^-?\d+$/.test(pid))
          throw new Error("Invalid flock identity");
        if (BigInt(inode) === found.ino && dev === device) {
          const owner = Number(pid);
          return {
            lock: "held" as const,
            pid: Number.isSafeInteger(owner) && owner > 0 ? owner : null,
            error: null,
          };
        }
      }
      return { lock: "free" as const, pid: null, error: null };
    },
    catch: () => new LocalStatusError({ message: "OS lock output was unreadable" }),
  });
});

/** Collect saved local status without credentials, directory creation, model calls, or resuming work. */
export const collectLocalStatus = Effect.fn("collectLocalStatus")(function* (options: {
  readonly repo: Repo;
  readonly stateRoot: string;
  readonly issue?: number;
}) {
  if (options.issue !== undefined && (!Number.isSafeInteger(options.issue) || options.issue < 1))
    return yield* new LocalStatusError({ message: "Provide a positive --issue NUMBER" });
  const stateRoot =
    (yield* optionalRead(() => realpath(options.stateRoot), "Could not access the state root")) ??
    resolve(options.stateRoot);
  const warnings: string[] = [];
  const pending = new Set<number>();
  const issues = new Set<number>();
  const receipt = yield* optionalRead(
    () => readFile(join(stateRoot, "watch.json"), "utf8"),
    "Could not read watch receipts",
  ).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.undefined
        : decodeWatchReceipt(text).pipe(
            Effect.mapError(
              () => new LocalStatusError({ message: "Watch receipts are unreadable" }),
            ),
          ),
    ),
    Effect.result,
  );
  if (Result.isFailure(receipt)) warnings.push(receipt.failure.message);
  else if (receipt.success) {
    if (
      receipt.success.repo.owner !== options.repo.owner ||
      receipt.success.repo.name !== options.repo.name
    )
      warnings.push("Watch receipts belong to a different repository");
    else {
      receipt.success.pending.forEach((issue) => {
        pending.add(issue);
        issues.add(issue);
      });
      receipt.success.settled.forEach((issue) => issues.add(issue));
    }
  }
  const entries =
    (yield* optionalRead(
      () => readdir(stateRoot, { withFileTypes: true }),
      "Could not list saved sessions",
    )) ?? [];
  entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^[1-9]\d*$/.test(entry.name) &&
        Number.isSafeInteger(Number(entry.name)),
    )
    .forEach((entry) => issues.add(Number(entry.name)));
  const sessions: LocalSessionStatus[] = [];
  for (const issue of options.issue === undefined
    ? [...issues].sort((a, b) => a - b)
    : [options.issue]) {
    const path = join(stateRoot, String(issue), "session.sqlite");
    const exists = yield* optionalRead(() => stat(path), "Could not access session storage").pipe(
      Effect.result,
    );
    if (Result.isSuccess(exists) && exists.success === undefined) {
      sessions.push({
        issue,
        source: pending.has(issue) ? "queued" : "missing",
        state: null,
        error: null,
      });
      continue;
    }
    if (Result.isFailure(exists)) {
      sessions.push({ issue, source: "unavailable", state: null, error: exists.failure.message });
      continue;
    }
    const saved = yield* readSession(path, options.repo, issue).pipe(Effect.result);
    sessions.push(
      Result.isFailure(saved)
        ? { issue, source: "unavailable", state: null, error: saved.failure.message }
        : {
            issue,
            source: saved.success === null ? "uninitialized" : "session",
            state: saved.success,
            error: null,
          },
    );
  }
  const watcher = yield* inspectWatcher(stateRoot).pipe(
    Effect.catch((error) =>
      Effect.succeed({ lock: "unknown" as const, pid: null, error: error.message }),
    ),
  );
  const result: LocalStatus = { repo: options.repo, stateRoot, watcher, sessions, warnings };
  return result;
});
