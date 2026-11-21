# Automatic pull requests

The agent makes the requested change, runs the configured sandbox checks, and opens a PR when they pass.
There is no pre-publication approval mode or policy environment setting. Review and merging happen on GitHub;
Caldero never merges automatically. GitHub CI may run after the PR opens.

## Approach

The domain reducer owns publication. A successful `Validated` event for the current run freezes the candidate
binding and validation evidence and atomically commits `publishing` plus one bound `Publish` instruction.
Failed, repeated, and stale validation cannot start another publication. No synthetic human event or actor is recorded.

All new sessions use this flow. `CALDERO_POLICY` is removed from deployment settings, admission, and the inbox.
The approve/reject HTTP routes, client actions, and domain events are removed. The inbox shows progress, changes,
validation evidence and the PR link; it retains additional instructions and Stop in eligible pre-publication states.

Publication reuses the Pi durable task, per-candidate journal, create-only branch, and reconciliation path. Lost
responses reconcile instead of republishing. Input during publication queues, and the next candidate must validate
again. Stop is refused after publishing starts because the remote outcome may already have landed.

For a single local issue, an operator can designate check labels and commands for
the new PR with `--pr-check LABEL=COMMAND`. They run in the candidate workspace
and must pass. The successful candidate stores the opted-in checks separately
from private validation output. Initial publication freezes the rendered
verification text in the existing journal, so reconciliation uses the same body.
Existing PRs and candidates without a saved public check have their original
publication behavior. Review covers any criteria or later changes beyond the
recorded checks.

## Compatibility

Keep historical `policy`, `awaitingApproval`, `rejected`, and `decidedBy` fields readable in stored session JSON and
D1 summaries. No stored state, active task, or publication journal is rewritten or reset. These legacy fields no
longer select a publication mode. New sessions store `auto`; old environment policy values are ignored.

An old `awaitingApproval` candidate stays paused and cannot publish from a replayed validation event. New instructions
start run + 1 with a new candidate version; its successful validation publishes automatically. Stop can cancel the
paused session. A legacy run already running or validating publishes its next successfully validated candidate.
Already committed Publish/Reconcile tasks resume unchanged. Removing HTTP approval routes is a breaking client change;
the bundled client is updated together. Every new session stores `auto`, so rollback requires a build that can decode `auto` for all new sessions.

## Acceptance criteria

- Without a policy environment variable, a labeled issue runs checks and opens exactly one PR, with no human approver.
- Failed checks never publish; late/repeated validation, retry limits, and reconciliation retain their guards.
- A durable publish interrupted after a saved receipt resumes to one PR with the same receipt.
- The inbox exposes progress, diff, evidence, PR link, instructions and eligible Stop; there is no approval action.
- A legacy paused candidate stays inert; explicit new instructions create a fresh validated candidate that publishes.
- Production still requires repository, installation, webhook/auth/model credentials and explicit check commands.

The existing GitHub App permissions suffice: Contents, Issues and Pull requests write, Metadata read.
App description: “Coding agent that opens pull requests after making changes and passing checks.”
Live App checks, credentials and deployment remain separate tasks.
