import { AuditEntry, SessionSummary, summarizeSession } from "@caldero/contracts/inbox";
import { Context, Effect, Schema } from "effect";
import { Projection, ProjectionError } from "./ports.ts";

export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, ProjectionError>;
    readonly audit: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, ProjectionError>;
  }
>()("caldero/InboxStore") {}

/** The D1 surface this adapter uses; SQLite peers exercise the same SQL in contract tests. */
export interface IndexStatement {
  bind(...values: Array<string | number | null>): IndexStatement;
  all(): Promise<{ readonly results: ReadonlyArray<unknown> }>;
}
export interface IndexDatabase {
  prepare(sql: string): IndexStatement;
  batch(statements: Array<IndexStatement>): Promise<unknown>;
}
const rows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ summary: Schema.String })));
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSummary));
const decodeAudit = Schema.decodeUnknownEffect(Schema.Array(AuditEntry));
const failure = () => new ProjectionError({ message: "Session index is unavailable" });

/** D1 is a projection only: state transitions always go to the authoritative session. */
export const makeD1InboxStore = (db: IndexDatabase) => ({
  projection: Projection.of({
    project: Effect.fn("D1Projection.project")(function* (state, instructionId) {
      const summary = summarizeSession(state);
      yield* Effect.tryPromise({
        try: () =>
          db.batch([
            db
              .prepare(`INSERT INTO sessions(session_id, revision, status, updated_at, summary) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision, status=excluded.status,
            updated_at=excluded.updated_at, summary=excluded.summary WHERE excluded.revision > sessions.revision`)
              .bind(
                state.sessionId,
                state.revision,
                state.status,
                state.updatedAt,
                JSON.stringify(summary),
              ),
            db
              .prepare(
                "INSERT OR IGNORE INTO audit(instruction_id, session_id, revision, status, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .bind(
                instructionId,
                state.sessionId,
                state.revision,
                state.status,
                state.decidedBy,
                state.updatedAt,
              ),
          ]),
        catch: failure,
      });
    }),
  }),
  list: Effect.fn("InboxStore.list")(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT summary FROM sessions ORDER BY
      CASE status WHEN 'awaitingApproval' THEN 0 WHEN 'failed' THEN 1 WHEN 'running' THEN 2 WHEN 'validating' THEN 3 ELSE 4 END,
      updated_at DESC, session_id LIMIT 100`)
          .all(),
      catch: failure,
    });
    const values = yield* rows(result.results).pipe(Effect.mapError(failure));
    return yield* Effect.forEach(values, (row) =>
      decodeSummary(row.summary).pipe(Effect.mapError(failure)),
    );
  }),
  audit: Effect.fn("InboxStore.audit")(function* (sessionId: string) {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT instruction_id AS instructionId, session_id AS sessionId,
      revision, status, actor, updated_at AS updatedAt FROM audit WHERE session_id=? ORDER BY revision ASC, instruction_id LIMIT 200`)
          .bind(sessionId)
          .all(),
      catch: failure,
    });
    return yield* decodeAudit(result.results).pipe(Effect.mapError(failure));
  }),
});
