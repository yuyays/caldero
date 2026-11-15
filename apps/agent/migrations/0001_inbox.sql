CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX sessions_attention ON sessions(status, updated_at);
CREATE TABLE audit (
  instruction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  actor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX audit_session ON audit(session_id, revision);
