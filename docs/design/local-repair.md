# Local CI repair

`pnpm repair --issue N --check 'COMMAND'` explicitly asks Caldero to make one
repair attempt on a saved PR. The session must be published or have failed a
repair before saving a checked patch. It uses the local Pi
profile, the same issue lock and session directory, the configured GitHub App
to write, and the operator's signed-in GitHub CLI to read Actions logs.

## Admission and validation

- Read the saved PR under the issue's local lock before opening the host. The PR
  must be open with a head branch in the configured repository and must have
  been opened by the configured App.
- Require a current failing GitHub Actions job for that exact head on github.com.
  Read a bounded excerpt of one job's logs as diagnostic data. Fix work starts
  only after admission succeeds. Checks are supplied explicitly just as for
  the initial issue run. Logs can contain text from tests and dependencies.
  Use local repair only for repositories whose CI output you trust with the
  operator's filesystem and network access.
- The repair event records the PR number, branch, base ref and head SHA. The
  workspace starts from the PR head and drops the previous base's checkpoint.
  One edit run can nominate one frozen patch. A failed run, a failed local
  check, or an empty patch ends the attempt.

## Publication and recovery

The original publication still creates new refs only. A repair uses GitHub's
`createCommitOnBranch` mutation on the existing PR branch with `expectedHeadOid`.
A moved head stops publication. Repair supports ordinary file edits and
deletions. Executable edits and mode changes are outside this slice. The App must be allowed to write on the branch
under the repository's existing rules.

The journal records an attempt marker before requesting the append. Recovery
recognizes that marker and the single expected parent on the current head.
If the head remains at the original commit, the same payload may be retried
within the publish attempt limit. If the branch has moved elsewhere, repair
reports a conflict. Resume interrupted work with the usual local command
and the same checks. A failed publication with a frozen candidate can use
`pnpm retry` to reconcile it.

Known Puchero/Metate databases in old default paths or in the selected state
directory are refused. Legacy sessions and branches are outside this slice.

## Automatic repair in local watch

`local --watch --auto-repair` enables the same repair workflow for PRs from
the watcher's settled issues. A new attempt requires an open issue with the
watch label in the current scan. The published session, PR ownership, head
and failing Actions job are checked before admission.

The watcher scans eligible published sessions serially after normal issue work.
It waits at least five minutes between repair scans. Issue discovery continues
at its configured interval. A fresh watcher checks saved work on its first scan.
A single completed failed Actions job can trigger repair while other checks are
pending. Enabling the flag lets Caldero send a bounded log excerpt to Pi and
spend model tokens without asking about each run.

The issue database records the automatic attempt for that PR in the same
transaction that starts repair. A new head, a failed local check, or a
restart cannot reset the attempt. Green CI, missing logs and unsuccessful
admission leave it available. A watcher restarted with the flag resumes an
already admitted automatic repair from the same state root, even if the issue
has since been closed or unlabeled. The ordinary single-issue resume command
also works. After an edit or check failure, use `pnpm repair` to start a manual
attempt against the current PR head. After a publication failure with a frozen
patch, use `pnpm retry` to reconcile the existing attempt.

`pnpm status --issue N --ci` shows the saved automatic attempt for the PR.
Available means the budget is unused and the saved phase permits admission.
Watch settings, issue labels and Actions logs still determine eligibility.
In progress describes the saved run phase. Used means the PR has spent its
attempt, including when the head has changed. Unavailable means the PR has an
unused attempt but the saved phase does not admit one. JSON includes
`automaticRepair.status` and `automaticRepair.nextAction` with `--ci` when a
PR is saved. A manual repair hint depends on current check results and is shown
when the saved session permits manual repair and automatic repair is unavailable
or used. Reconciliation
guidance for a failed publication is available even if live CI cannot be read.

## Acceptance

- A red job on the saved PR head supplies context, while a passing snapshot
  or a log tied to another commit never starts the model.
- A checked fix advances the original branch with one commit and retains the
  same PR number. A concurrent push stops the append. A dropped response is
  reconciled without another commit.
- The first repair validates from the PR head rather than the issue's old
  base, and old workspace files do not enter the checked repair patch.
- Watch with the flag admits one automatic repair for a labeled, open issue
  with an eligible failing job. Without the flag it performs no CI repair
  lookups. A restart resumes interrupted work and the same PR cannot spend
  another automatic attempt.
