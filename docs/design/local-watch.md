# Local issue watch mode

See the [architecture overview](../architecture.md) for the current execution
diagrams and the scope of the shared session core.

Run `local --watch --check COMMAND` with the same installed Pi profile and GitHub
App configuration as the single-issue runner. Watch mode polls the configured
repository for open issues carrying `agent` (overridable with `--label`). GitHub's
issues endpoint is paginated and pull requests are excluded. No webhook or public
server is required.

## Execution and recovery

One watcher owns a repository state root with a kernel flock. It persists pending
issue numbers in `watch.json` before opening a runner. Atomic rename plus file and
directory sync make the scheduling receipt durable. The receipt includes the
repository identity; unreadable or mismatched receipts fail closed without reset.

The watcher runs one issue at a time through `openLocalIssue` and `drain`. SQLite,
workspace blobs, publish journaling and reconciliation stay in the existing
per-issue directory. The watcher does not create a second execution state machine.
Long issues delay both the next scan and later issues.

After a restart, pending receipts reopen the same issue directory. An idle session
is admitted only if the latest successful scan still lists it. Closed or unlabelled
issues with already-admitted work resume: the label selects new work, not cancellation.
If discovery fails, saved work can still resume, but idle sessions remain pending
until eligibility can be checked. Eligibility is a scan-time snapshot, not a lock
on GitHub issue state.

Settled receipts suppress repeated opening of terminal sessions. If the process
dies after publication but before recording settlement, reopening the issue's
SQLite recovers its existing PR. Failed/cancelled sessions stay terminal; changing
labels does not start another attempt. Legacy paused sessions are reported once;
the watcher offers no automatic restart of paused or terminal sessions. Failed
sessions can be retried explicitly with [the local retry command](local-retry.md),
using the same issue directory; no settlement receipt needs removal.

Discovery and transient issue failures log and retry on the next cycle. Permanent
session faults and invalid filesystem/lock configuration are reported and suppressed;
lock contention and unknown spawn/IPC failures remain pending for the next cycle.
Repair/recovery of suppressed issues is explicit through the single-issue runner. Receipt
write failures stop the watcher before further admission. Watch receipts grow by
one entry per issue; no retention/compaction policy is introduced in this version.

## CLI and shutdown

`--watch` is exclusive with `--issue`, `--state-dir` and `--check-connection`.
`--poll-seconds` defaults to 60 and must be at least 1. `--state-root` selects the
watch repository directory (default `~/.local/state/puchero/OWNER/REPO`), with issue
directories underneath. The single-issue `--state-dir` retains its existing meaning.
For a custom watch root, single-issue recovery must use `--state-dir <root>/<issue>`
to address that same session and lock.

First Ctrl-C/SIGTERM stops further polling/admission and lets the current issue
finish normally. Second signal exits immediately; pending receipts and the issue
journal remain for recovery. It does not deliver Cancel. The single-issue command's
existing Stop behavior is unchanged. No automatic merge or system daemon is added.

## Observable acceptance

1. Paginated discovery excludes PRs and admits each eligible issue once.
2. Checked issues publish serially; restart does not republish settled issues.
3. Lost completion receipts recover the same PR, even after label removal.
4. Queued idle issues absent from the latest successful scan produce no PR. Changes
   after a scan are observed by the next scan, not between its serial jobs.
5. Scan failure does not abandon saved work or admit unverified idle issues.
6. Stop finishes the current issue and leaves queued work for restart.
7. Repository/session locks prevent concurrent ownership; malformed receipts are
   retained and reported instead of overwritten.

Tests use the GitHub HTTP adapter and local durable runner seams with fake remote
GitHub/model adapters; no user credentials or live model calls are needed.
