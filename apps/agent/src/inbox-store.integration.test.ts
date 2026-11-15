import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { initialSession } from "@puchero/domain";
import { Effect } from "effect";
import { makeD1InboxStore, type IndexStatement } from "./inbox-store.ts";

/** The D1 calls used by the index, executed against SQLite and the production migration. */
class SqliteStatement implements IndexStatement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly values: Array<string | number | null>;
  constructor(db: DatabaseSync, sql: string, values: Array<string | number | null> = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: Array<string | number | null>) {
    return new SqliteStatement(this.db, this.sql, values);
  }
  all() {
    return Promise.resolve({ results: this.db.prepare(this.sql).all(...this.values) });
  }
}

describe("Inbox projection", () => {
  it.effect(
    "keeps the newest summary and the exact audit revision through replay and out-of-order delivery",
    () =>
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(":memory:")),
          (connection) => Effect.sync(() => connection.close()),
        );
        db.exec(
          yield* Effect.promise(() =>
            readFile(new URL("../migrations/0001_inbox.sql", import.meta.url), "utf8"),
          ),
        );
        const store = makeD1InboxStore({
          prepare: (sql) => new SqliteStatement(db, sql),
          batch: (statements) => {
            db.exec("BEGIN");
            try {
              for (const statement of statements) {
                if (!(statement instanceof SqliteStatement))
                  throw new Error("Unexpected statement");
                db.prepare(statement.sql).run(...statement.values);
              }
              db.exec("COMMIT");
              return Promise.resolve([]);
            } catch (error) {
              db.exec("ROLLBACK");
              return Promise.reject(error);
            }
          },
        });
        const initial = initialSession({
          sessionId: "acme/app#7",
          repo: { owner: "acme", name: "app" },
          issue: 7,
        });
        const newer = {
          ...initial,
          status: "awaitingApproval" as const,
          revision: 4,
          version: 1,
          updatedAt: 40,
        };
        yield* store.projection.project(newer, "event-4");
        yield* store.projection.project(
          { ...initial, status: "running", revision: 1, updatedAt: 10 },
          "event-1",
        );
        yield* store.projection.project(newer, "event-4");
        const sessions = yield* store.list();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          sessionId: "acme/app#7",
          revision: 4,
          status: "awaitingApproval",
        });
        expect(sessions[0]).not.toHaveProperty("candidate");
        expect(yield* store.audit("acme/app#7")).toEqual([
          {
            instructionId: "event-1",
            sessionId: "acme/app#7",
            revision: 1,
            status: "running",
            actor: null,
            updatedAt: 10,
          },
          {
            instructionId: "event-4",
            sessionId: "acme/app#7",
            revision: 4,
            status: "awaitingApproval",
            actor: null,
            updatedAt: 40,
          },
        ]);
      }),
  );
});
