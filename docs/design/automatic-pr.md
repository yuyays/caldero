# Automatic pull requests with optional approval

The agent should open a PR after validation by default. Human approval before opening the PR is optional.
Merging remains a separate action. This changes the earlier milestone's mandatory publication gate.

## Approach

Extend the existing session policy with `auto`, alongside `observe` (approval required) and `off` (no admission).
`PUCHERO_POLICY` defaults to `auto` in local development. Real-service mode requires an explicit policy; set `auto`
when connecting the GitHub App for automatic PR creation. Configure `observe` to keep the existing exact-binding
review workflow. The policy is captured in the session when it is created; changing configuration does not change
an existing session, including one already awaiting approval. `off` blocks new admissions; it is not a global kill
switch for existing sessions. Stop is available only in eligible pre-publication states and is refused once
publication starts, since a PR may already have landed. Auto mode deliberately removes the approval pause. There is no in-flight policy toggle in this change.

The domain reducer owns the decision. After a successful `Validated` event for the current run, it freezes the
candidate binding and evidence as usual. In `auto`, it commits `publishing` plus the existing `Publish` instruction
in that same decision. It does not invent an `Approve` event or a human actor; `decidedBy` remains null. In `observe`,
it keeps `awaitingApproval`. Failed validation and stale results cannot trigger publication.

Publication uses the existing Pi task, per-candidate journal, create-only branch, and reconciliation path. Ambiguous
responses reconcile rather than issuing another publication. Input during publication still queues; every later
candidate is validated again and has a new version. No merge endpoint or automatic merge is introduced.

The inbox detail displays the session's actual policy and explains automatic PR creation. Automatic sessions do not offer
Approve/Reject controls; Stop and additional instructions retain the reducer's existing eligibility rules. Existing
manual approval and stale-binding behavior remain available through `observe`.

The GitHub App's existing Contents/Issues/Pull requests write and Metadata read permissions are sufficient for
this publication behavior. Its description can say: “Coding agent that opens pull requests, with optional human
approval before publishing.” App registration, credentials, live App checks and deployment are separate tasks.

## Acceptance criteria

- A current successful validation in `auto` atomically produces the frozen candidate, `publishing`, and one bound
  Publish instruction. `decidedBy` is null; repeated/stale validation cannot publish again.
- In `observe`, validation still waits for an exact-binding human approval. `off` still blocks admission.
- Failed validation never publishes; validation/run and publication retry limits remain unchanged.
- A real SessionHost with local workspace, scripted model and FakeGitHub publishes from the issue label without
  any approval event. A lost response reconciles to one PR; replay does not create another.
- Configuration accepts all three modes, defaults local sessions to auto, and requires an explicit production policy. Existing observe sessions keep their policy.
- The inbox identifies automatic sessions and offers no approval/rejection action for them; manual review still works.

## Compatibility

No stored data is rewritten. New code reads existing `off`/`observe` sessions. Once an `auto` session has been saved,
older versions that lack that policy value cannot decode it; rollback needs a version that understands `auto` or
an explicit migration. Changing the new-session default back to `observe` does not convert saved sessions.
