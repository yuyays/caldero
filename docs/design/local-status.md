# Read-only local status

`pnpm status` reports saved sessions and watch-lock ownership without opening a
session host. It does not need Pi authentication, a GitHub token or a private key.
The default GitHub configuration is read only for `repo.owner` and `repo.name`;
`--repo OWNER/REPO` bypasses that file entirely.

```sh
pnpm status
pnpm status --issue 11
pnpm --silent --filter @puchero/agent status --repo OWNER/REPO --json
```

`--state-root` selects the same repository state root used by watch mode; issue
databases are `<root>/<issue>/session.sqlite`. The command also discovers manual
runs in numeric issue directories. It does not create missing roots or sessions.
An arbitrary single-issue `--state-dir` outside that layout is not discovered.

## Observation contract

- SQLite owns saved phase, attempts, queued follow-ups, failure, candidate
  validation evidence and PR identity. Watch receipts do not override those fields.
- A pending receipt without a database is `queued`. Missing databases from settled
  receipts or an explicitly requested issue are `missing`, never assumed complete.
- A valid initialized database without a committed session state is `uninitialized`,
  not a failed or corrupt run.
- One unreadable, mismatched-identity or incompatible database reports `unavailable`
  without hiding healthy siblings. Malformed watch receipts produce a warning and
  numeric directory discovery still works.
- `held` means the OS reports a FLOCK matching this root's `.watch.lock` device and
  inode, with its owning
  PID. The owner is the lock helper, not necessarily the watcher process. `free`
  means no owner was found; `unknown` means inspection failed. This is not a
  heartbeat, health check or proof that a saved `running` phase is making progress.
- Evidence is opaque saved command output for the candidate's run/version. Text
  shows an excerpt for `--issue`; JSON retains the full value. There is no invented
  per-check progress, fresh CI status or model-token telemetry.
  Text mode removes terminal escapes and control bytes; JSON retains saved evidence.

The result has a pure [shared schema](../../packages/contracts/src/schemas/local-status.ts)
for reuse by a future authenticated UI; CLI snapshots are validated through it.
There is no new HTTP server or React
connection in this change. Exit status 1 indicates invalid arguments/configuration,
unreadable sessions, warnings, or a missing explicitly requested issue; an ordinary
saved `failed` session is data and does not itself make the inspection fail.
Unknown lock ownership remains visible without discarding the session snapshot.

## Storage adapter

`pnpm status --issue N --ci` adds GitHub's check rollup for the current head
of the saved PR. It uses the operator's GitHub CLI login and adds up to 100
check details alongside the full count. A response for a different head or a
GitHub error leaves the saved snapshot available and marks CI unavailable.
CI results describe reported checks. GitHub evaluates merge requirements.

Pi Durable 1.5.2's normal SQLite initializer attempts migration writes even for an
existing store. The status reader instead uses Chord's SQLite facade in
`read-only` mode, with a deferred read transaction and its normal busy timeout.
It checks the pinned Pi SQLite schema version and reads the current session-scoped
`puchero.session` document's latest revision. The owning `SessionDoc` definition
always checkpoints; the reader requires its base revision and document version,
then decodes the inner state with the domain schema and validates repository,
issue and session identity. Unsupported layouts fail closed, never migrate or
fall back to a stale base. SDK/document-format changes must update this adapter
and its real-store integration tests together.

No Harness, ModelRuntime or GitHub adapter is opened. No runner/watch lock is
acquired, no tasks are resumed and no credentials are loaded. SQLite read-only
WAL connections can create or touch `-wal`/`-shm` bookkeeping sidecars in an
existing issue directory. They do not write session data or schema; these files
must not be deleted while another process may be using them. A filesystem that
cannot support the read reports an unavailable session.

## Observable acceptance

1. Real runner output is readable while its SQLite/runner lock is still owned and
   after it closes, with unchanged database bytes and no additional publication.
2. Watch-lock held/free ownership is observable; missing `lslocks` reports unknown.
3. Queued, missing, corrupt and unsupported stores are distinguished without
   creating sessions, migrating data or hiding healthy manual runs.
4. CLI JSON works with an empty HOME/Pi profile and a config containing no usable
   credentials, and exposes the same saved state as the reader.

See the [architecture overview](../architecture.md) and
[watch recovery rules](local-watch.md) for execution ownership.
