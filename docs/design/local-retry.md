# Explicit local retry

`pnpm retry --issue N --check COMMAND` explicitly retries a saved failed session.
It uses the same GitHub App, Pi profile, issue directory and exclusive runner lock
as `local`. The watcher never automatically restarts a settled failed session.

## Decision and recovery

A `Retry` event carries the expected saved revision. Only a failed session with
that revision accepts it. Missing, uninitialized, unreadable,
nonfailed sessions are refused before opening the execution
host. Nothing deletes or replaces the database, workspace or publication journal.

For an editing or validation failure (no frozen candidate), increment the run ID,
reset phase attempts and submit a new run containing the previous failure. A failed follow-up may retain an earlier PR; its next candidate uses the next
version, while publication recovery retains the failed candidate version. The
Pi conversation and durable workspace remain; checks run again before publication.
The admitted base commit remains fixed; retry does not silently rebase the task.

For a publication failure (frozen candidate present), retain its run ID, version,
binding and journal. Reset phase attempts and reconcile first. If GitHub has the
PR, adopt it; otherwise the existing recovery protocol may finish publication of
that same frozen candidate. Never start an editing run or mint a replacement
candidate merely because a publish response was lost. Conflicts remain failures.

The committed Retry submission retains the previous failure context. A stable
event ID derived from the expected revision deduplicates delivery; replay of an
old revision cannot restart a later failed run. The normal attempt limit still
bounds each explicit retry. This command does not retry cancelled sessions,
change checks automatically, watch CI, or merge a PR.

## Observable acceptance

- A failed-check session can be retried with corrected checks, reads its previous
  failure in the new run, and opens one checked PR without resetting storage.
- A failed publication whose response was lost recovers the same PR and binding;
  no new model call, candidate version or duplicate PR is introduced.
- Duplicate/stale Retry events do not restart a later failure or active run.
- Missing and nonfailed sessions are refused; missing paths are not created.
- A second runner is refused by the existing lock; restart resumes a committed
  retry through the same durable task protocol.
- Reducer and real local-runner integration tests exercise these contracts. CLI
  argument rejection is checked without credentials or live model requests.
