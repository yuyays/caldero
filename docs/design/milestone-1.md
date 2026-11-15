2026-11-14 · Draft 2, revised after review by Codex (`gpt-6.1-sol`). Not yet approved.

# puchero milestone 1: issue → patch → approval → PR

The later [automatic PR change](automatic-pr.md) adds `auto` alongside approval-required `observe`. That update
supersedes the mandatory gate in the original milestone below; existing sessions keep their stored policy.

**Goal.** A GitHub issue labeled `agent` gets one durable session. An agent works on it in a sandbox and produces a
validated, immutable patch. In `auto`, it opens the PR immediately after validation. In `observe`, it waits for a
human to approve that exact patch in the inbox. Everything survives deploys, evictions, and container resets.

Built on the spike's verdict ([spike-pi-do-container.md](../research/spike-pi-do-container.md)) and the
[Open SWE comparison](../research/open-swe-comparison.md). Vocabulary follows `codebase-design`: module,
interface, seam, adapter, depth.

**Out of scope:** Slack, cron, CI and review follow-ups as new runs, multiple users, ChatGPT sign-in, the audience
model, a scheduler, preview environments, and deleting `apps/api` (a separate cleanup).

## Shape

```
GitHub ──webhook──▶ Edge Worker ──deliver(event)──▶ SessionDO (one per issue)
                    │ verify signature                 │ Session reducer (packages/domain, pure)
                    │ ack after deliver commits        │ Pi Durable harness on DO SQLite
Inbox (apps/web) ──▶│ inbox API, Access auth           │ instructions → Pi durable tasks
                    ▼                                  ▼
                   D1 (session index, audit) ◀── project task   Sandbox container ◀── Workspace
                                                                 R2 (checkpoints, patches)
```

## Durability rule (applies everywhere)

**Commit intent, then act, then commit the outcome.** Every external action is an _instruction_ stored in the same
Pi commit as the reducer state that produced it. Each instruction runs as a **Pi durable task**, so pending work
keeps Pi's wake scheduling (and the DO alarm) active; nothing depends on an outbox drain finding work after
`resume()`. A task executes the external call, then commits its receipt together with the resulting reducer event.
A crash between the call and the receipt re-runs the task, so **every instruction must be idempotent or
reconcilable on its own terms**; a stable key alone is not enough (see each instruction below).

## Modules

### 1. `Session` reducer: `packages/domain` (the deep module)

```ts
decide(state: SessionState, event: SessionEvent, now: Instant): { state: SessionState; instructions: Instruction[] }
```

- **Events:** `IssueLabeled`, `UserInput`, `RunAnswered(runId)`, `Validated(runId, candidate, evidence)`,
  `ValidationFailed(runId, evidence)`, `RunFailed(runId, reason)`, `Approve(actor, binding)`, `Reject(actor, binding)`,
  `Cancel(actor)`, `PublishSucceeded(pr)`, `PublishFailed(kind: "retryable" | "permanent" | "ambiguous")`.
- **Instructions** (data, each with a unique `instructionId`): `Submit(draft)`, `Validate(runId)`, `AbortRun`,
  `Publish(binding)`, `Reconcile(binding)`, `Project(revision, snapshot)`, `Comment(key, text)`.
- **States:** `idle → running → validating → awaitingApproval → publishing → published` in observe; auto skips
  `awaitingApproval` and commits Publish with the validated candidate. Also `rejected`,
  `cancelled`, `failed`. `version` increments with every proposed candidate; `runId` identifies each Pi run.
- **Rules it owns:**
  - Policy `off | observe | auto`, resolved by `SessionDO` for the repo and label when the session is
    created; the reducer enforces it.
  - **Approval binding** `(sessionId, version, runId, repo, baseRef, baseSha, patchDigest)`. A mismatch, a repeat of a
    decided approval, or any state but `awaitingApproval` is rejected as stale; a duplicate of the winning approval
    is a no-op.
  - **Results are bound to their run:** `Validated` for anything but the current `runId` is ignored, so queued input
    can never make an old result approvable.
  - **Input while `running` steers; while `validating` or `awaitingApproval` it invalidates the candidate** and
    starts a new run (`version + 1` on its proposal); **while `publishing` it queues** until the publish settles, then starts the next run.
  - `PublishFailed("ambiguous")` yields `Reconcile`, never `Publish`.
  - Attempt limits per phase (run and validation share one counter; publishing and reconciling share another);
    exhaustion yields `failed` with a reason.
  - Records who approved, rejected or cancelled (`decidedBy`) for the audit trail.

Policy, approval and queuing rules interact, so they stay in one module. **Test surface:** table-driven tests of
`decide`, in-process. `now` is epoch milliseconds from Effect's `Clock` (`TestClock` in tests); no clock seam.

### 2. `SessionDO`: `apps/agent` (Alchemy Effect Durable Object)

**Interface:** `deliver(event & { eventId })` (idempotent per `eventId`) and `view()`.

- **State:** reducer state, processed `eventId`s, and the instruction journal live in a Pi document
  (`puchero.session`). `deliver` runs `decide` and commits, in **one** `root.commit()`: the dedupe record, new
  state, new instructions as Pi tasks, and any Pi input admission (`submit(tx, draft)`, with
  `requestId = instructionId`). The Worker acknowledges the webhook only after that commit.
- **Alarm:** Pi owns it (spike). Activation and alarm arm, then `resume()`.
- **Run end:** Pi's `afterRun` hook only requests a `runEndTask` (`Validate(runId)`); it runs after the answer
  commits. Pi skips `afterRun` after failure or abort and when the hook throws, so a **separate failure path** maps
  Pi's run-failure/abort outcome to `RunFailed`. The model never decides that validation passed.
- **Context hydration before the first run** (Open SWE): issue title, body and comments, the repo's `AGENTS.md`,
  base SHA, and trigger provenance form the first input.

### 3. `Workspace` seam: the sandbox

```ts
interface Workspace {
  env(): ExecutionEnv; // guarded: see below
  prepare(repo: RepoRef, baseSha: string): Effect<void, WorkspaceError>;
  validate(commands: string[]): Effect<Validation, WorkspaceError>; // frozen candidate: { patch, digest, evidence }
  quiesce(): Effect<void, WorkspaceError>; // kill running commands; used by abort and cancel
}
```

- **The guard lives inside `env()`:** before every tool call and after every reconnection, it compares the
  container's boot ID with the last one recorded. On a mismatch it restores the latest checkpoint first and records
  a reset notice, which the session delivers to the model as a steer: "Your workspace was restored to checkpoint N;
  re-check files before continuing." Callers never coordinate boot checks.
- **Checkpoints:** a `wrapTool` around `write`, `edit` and `bash` awaits a checkpoint upload to R2 before returning,
  and commits the checkpoint pointer through `api.commit()`. That commit is separate from Pi's tool-result commit,
  so recovery tolerates a stored checkpoint whose tool result reads "interrupted". **The loss window is a mutation
  that happened before its checkpoint reached R2.** Mutating tools run **serially** in milestone 1 (Pi runs tools
  in parallel by default, and per-file edit locks don't protect whole-workspace snapshots). A checkpoint is the full
  change set against `baseSha`: untracked, binary, deleted files, and modes.
- **Validation freezes the candidate:** `validate` snapshots the workspace, runs the commands against that
  snapshot, and returns its digest, so later edits cannot change what gets approved.
- **No credentials in the sandbox.** `prepare` fetches the repo tarball at `baseSha` in the Worker with the GitHub
  App token and writes it into the container in chunks (pi-env frames are at most 16 MiB).
- **Containers start through Alchemy's `sandbox.start()` before every `exec`** (spike findings 1–2). Internet is
  off. Package installs for validation come from dependency caches baked into the image, not registry egress;
  revisit if that proves impractical.
- **Adapters:** `ContainerWorkspace` (Container, pi-env connection, R2) and `LocalWorkspace` (temp dir,
  `NodeExecutionEnv`, in-memory checkpoint store). Both pass Pi's `registerEnvConformance()` **and our own
  checkpoint/restore/validate contract tests**, which conformance doesn't cover.

### 4. `GitHub` seam (true external, so a fake adapter)

```ts
interface GitHub {
  fetchIssueContext(repo: Repo, issue: number): Effect<IssueContext, GitHubError>;
  fetchSource(repo: Repo, sha: string): Effect<ReadonlyArray<SourceFile>, GitHubError>;
  publish(
    issue: number,
    binding: ApprovalBinding,
    patch: Patch,
    journal: PublishJournal,
  ): Effect<PullRequest, PublishError>;
  reconcile(
    issue: number,
    binding: ApprovalBinding,
    journal: PublishJournal,
  ): Effect<ReconcileResult, GitHubError>;
  comment(repo: Repo, issue: number, key: string, text: string): Effect<void, GitHubError>; // key in a hidden marker
}
```

- **Publish is journaled by stage** (`blobs → tree → commit → ref → pr`); each stage's result is committed before
  the next. Binary files go as base64 blobs, deletions as tree entries with `sha: null`, modes preserved.
  `base_tree` is the **tree SHA** of `baseSha`. Commit metadata (author, committer, dates, message) is frozen in the
  publish journal before the first request, so a retry produces the same commit SHA.
- **Reconciliation** checks the branch `puchero/<issue>-v<version>` against the journaled commit SHA, then searches
  open **and closed** PRs from that branch. A branch at the expected commit without a PR resumes at the `pr` stage;
  a branch at a different commit fails as `permanent` ("branch conflict"). A 422 counts as success only after
  reconciliation confirms the expected state.
- **Comments** carry a hidden marker with their key; a retry first looks for the marker.
- **Adapters:** `GitHubApp` (installation token minted in the Worker) and `FakeGitHub` (in memory; can drop
  responses and pre-seed conflicting branches).

### 5. Edge Worker, inbox, projection

- `POST /webhooks/github`: verify `X-Hub-Signature-256`, map the delivery to an event with
  `eventId = X-GitHub-Delivery`, call `deliver`, acknowledge after it resolves. Unmapped events → 204.
- Inbox API (schemas in `packages/contracts`): list sessions (D1), get one (`view`), approve/reject with the
  binding shown, cancel. Auth: a fully validated Cloudflare Access JWT plus a mapping of verified emails to GitHub logins who may
  approve. Local dev uses a static dev token.
- **D1 projection:** `Project(revision, snapshot)` upserts `sessions(..., revision)` only when its revision is newer, and
  inserts `audit` rows keyed by `instructionId`. The instruction carries its immutable reducer-state snapshot. No decision reads D1. A global rebuild is deferred because DO namespaces cannot enumerate sessions; recovery requires independently known session IDs.

### Model access

No seam in milestone 1: `SessionDO` receives Pi's `Models` directly (faux in tests, an OpenAI key from a Worker
secret in deployment). The per-owner `ModelAccess` seam arrives with ChatGPT sign-in.

## Repository changes

- Add `packages/domain` (pure Effect, no Cloudflare imports) and `apps/agent` (Alchemy Worker, `SessionDO`,
  `Sandbox` container, adapters). Extend the `starter/runtime-boundary` lint override to `apps/agent`.
- `apps/web` becomes the inbox, served as static assets by the Worker.
- Promote the spike's `ContainerConnection` into `apps/agent`, with typed Effect errors at the Pi boundary.

## Acceptance criteria (observable)

Against `alchemy dev` with `LocalWorkspace` or the container, `FakeGitHub`, and faux models, unless noted.

**Happy path**

1. Labeling an issue `agent` creates exactly one session; redelivering the same delivery ID changes nothing.
2. A session reaches `awaitingApproval` only after validation passes; the inbox shows the patch, digest, base SHA
   and validation output.
3. Publishing (automatically in auto, after approval in observe) opens exactly one PR on `puchero/<issue>-v<version>`,
   the session becomes `published`, and the issue
   gets exactly one linking comment.
4. A patch with a binary file, a deletion, and a mode change round-trips into the PR unchanged.

**Approval and input**

5. A stale binding, a repeated decided approval, and approval outside `awaitingApproval` change nothing; a
   duplicate of the winning approval is a no-op.
6. Input during `validating` or `awaitingApproval` invalidates the candidate; the next proposal is `version + 1`,
   and the old run's late `Validated` is ignored.
7. Validation failure and run abort each produce a visible state (`running` retry or `failed`), never a stuck one.

**Crashes** (DO aborted at each point; the session recovers with no further request)

8. Between `deliver`'s commit and the webhook acknowledgement: the redelivery is deduplicated.
9. After a checkpoint upload but before its pointer commit, and after the pointer commit but before the tool result.
10. After each publish stage, and after the PR is created but before its receipt commits: exactly one PR exists.
11. Mid-tool: the transcript records the interruption and the run continues.
12. Container destroyed mid-run: the workspace is restored from the latest checkpoint and the model gets the notice.

**Publishing edge cases**

13. A pre-existing branch at a different commit fails as a visible branch conflict, not a second PR.
14. Cancel during `running` stops the run and its commands; cancel during `publishing` is refused.

**Deployed (manual)**

15. **One real GitHub contract check**: publish against a scratch repo with the GitHub App.
16. **Deployed to Cloudflare** with `ContainerWorkspace` and a real model: a redeploy mid-run resumes it, and a run
    with CPU-heavy work in the DO (large transcripts, compaction) stays within the Workers CPU limit. A sleeping
    tool proves elapsed time only, not CPU budget.

## Build order

1. `packages/domain` reducer with its tests.
2. `SessionDO` with the instruction-as-task protocol, `LocalWorkspace`, `FakeGitHub`, faux models: criteria 1–3,
   5–11, 14.
3. `ContainerWorkspace` (checkpoints, guard, validation): criteria 4, 12.
4. `GitHubApp` publisher with the stage journal: criteria 10, 13, 15.
5. Inbox UI, then the deployed check (16).

### Step 2 as built

`SessionDO`'s logic is the `SessionHost` deep module in `apps/agent/src/session-host.ts`, tested in Node against
Pi's `MemoryStorage`, `LocalWorkspace`, `FakeGitHub` and faux models; crashes are simulated by cutting one host off
from its storage and ports, then opening the next. Changes from the design above:

- **`Submit` runs as a task too.** A start prepares the workspace first (a failure becomes `RunFailed`), and the
  admission commit re-checks the run: an obsolete start is dropped, and a steer that missed its run is decided again
  as `UserInput`. No instruction is admitted inside `deliver`'s commit.
- **Run end.** `afterRun` asks for a `RunAnswered` task, which waits while puchero input is queued behind the run.
  A failed run is found from `pi.live.runFailure` (its inputs map to their run) and reported in a commit: at open,
  on `resume`, on every `pi.live` change, and inside every input admission, so new input cannot hide it. Because a failed run may leave no task to wake the object, the DO shell must keep a heartbeat
  alarm while the session is `running` or `validating`.
- **Unexpected failures** of `Validate`, `Publish` and `Reconcile` become their failure events (a publish as
  `ambiguous`), so the reducer's attempt limits apply. Comments and projections retry on their own with durable
  backoff (five attempts); no session event waits on them. A task Pi faults after repeated crashes still reports no
  event; handle that with the DO shell's `onReport` in step 3.
- **`Workspace.validate()` takes no commands**: the checks are adapter configuration. Validations run one at a time,
  a stale `Validate` is skipped, and `patch(digest)` re-verifies the digest. `GitWorkspace` implements the seam over
  any Pi `ExecutionEnv`, so `ContainerWorkspace` reuses it.
- **`GitHub.fetchSource`** (files) stands in for `fetchTarball` until the container needs chunked transfer.
- **Moved to step 3:** the Alchemy DO shell (with the heartbeat above), criterion 9 (checkpoints), patches in R2
  (they live on the workspace disk until then), and forwarding cancellation into Pi calls.

### Step 3 as built

`ContainerWorkspace` reuses `makeGitWorkspace` over pi-env's `RemoteExecutionEnv`. The promoted `ContainerConnection`
uses the native container transport and calls Alchemy's idempotent `sandbox.start({ enableInternet: false })` before
starting each daemon with native `exec`. Pi's Promise operations map into typed `WorkspaceError` / `SessionHostError`
Effects; invocation cancellation flows into Pi contexts, environment calls and transport startup waits.

- **Recovery journal.** `Workspace.env(recovery)` accepts Pi journal callbacks, keeping boot detection and restoration
  inside the workspace. The host binds this once when opening; checkpoint and validation also check the guard. The
  separate `puchero.workspace` Pi document holds the last boot ID and `{ number, digest }` checkpoint pointer.
  Only a changed `/workspace/.boot` means reset; opening another DO process with the same marker preserves its disk.
  Restore commits the new boot ID and the required steer in one transaction. Before the first checkpoint, reset
  restores the base and names it checkpoint 0.
- **Checkpoint protocol.** Coding tools run sequentially (including reads, a simpler restriction than serializing only
  mutations). After `write`, `edit` and `bash`, the wrapper uploads the full `FileChange[]` against the base, then
  commits its pointer with `api.commit()`, before returning the tool result. An uploaded blob without a committed
  pointer is an orphan and is ignored; after a committed pointer, recovery accepts Pi's interrupted tool result.
  The known loss window remains mutation before checkpoint upload/pointer commit.
- **Stores.** Checkpoints and validated patches are content-addressed JSON outside the sandbox: namespaced R2 for the
  container, a retained in-memory store for local tests. Both verify file digests on retrieval/restoration. R2 writes
  use create-only conditions. Frozen validation directories remain disposable sandbox data. `LocalWorkspace` moved
  to its own file so the Worker doesn't bundle the Node process adapter.
- **DO shell.** `SessionDO` opens Pi on DO SQLite and exposes `deliver` / `view`. Pi wake scheduling and a roughly
  30-second heartbeat while running or validating share one alarm. The container connection and Pi host belong to
  the instance scope. Faulted instruction tasks become visible reducer failures; `onReport` triggers synchronization,
  and opening/resuming also checks durable task records, covering a crash before report handling. Faulted answer
  reporting tasks are checked too. Comment/projection faults have no waiting session transition to unblock.
- **Development scope.** `apps/agent/alchemy.run.ts` and its minimal Worker route use faux models, FakeGitHub, an
  in-memory projection, and fixed demo issue metadata; webhook verification, real GitHub credentials, the inbox and
  D1 remain later work. `fetchSource` is still a file list rather than a tarball; pi-env's file writer already chunks
  transfers below its frame limit. The image has git/bash/coreutils, with no project dependency cache yet; validation
  requiring other packages must extend the image. See `apps/agent/README.md` for local commands.

Verification: the reusable Workspace contract runs against LocalWorkspace; SessionHost integration tests cover
criteria 4, both criterion 9 crash windows, criterion 12 restoration and steer, and faulted-task failure reporting.
The existing session criteria remain covered. Local `alchemy dev` with Docker reached `awaitingApproval` through
DO SQLite, container tools, checkpoint upload and R2 patch retrieval. Cloudflare deployment, real eviction/CPU limits,
and reset/reconnect recovery on the deployed platform remain unverified; no deployment was performed.

### Step 4 as built

`GitHubApp` implements the GitHub seam with Effect workflows over GitHub REST. App credentials remain outside the
sandbox; each operation mints a fresh token restricted to the configured repository and required permissions.

- **Approval identity:** `baseRef` travels from `IssueLabeled` into the candidate binding. A changed base branch is
  refused before creating a ref and again before opening a new PR. It is a permanent publication failure, so the
  session ends as `failed` under the existing reducer. Restart from updated issue context in a fresh session and
  approve its new candidate; automatic rebase/re-proposal is outside this milestone. A race between the two base
  checks may leave an unused branch, which the adapter never deletes. This is a schema change: use a fresh development session rather than loading old
  sessions without `baseRef`.
- **Publish journal:** SessionHost supplies read/save callbacks backed by the `puchero.publish` Pi document. Entries
  are keyed by candidate version and verify the full binding and issue. Intent metadata, base tree, the complete blob
  map, tree, commit, reference and PR receipts each commit before advancing. Interrupted uploads may leave unreachable
  Git objects; replay uses the same content and commit metadata. No credentials or patch payloads enter the journal.
- **Recovery:** reference creation is create-only. Existing refs must equal the journaled commit. PR lookup includes
  closed PRs and checks head SHA and base branch. Reconciliation can finish the PR stage when the expected branch
  exists, rather than reporting a retry that rebuilds the publication. A 422 is accepted only after checking remote
  state; conflicts fail visibly.
- **Read path:** issue context includes paginated comments and root `AGENTS.md` at the captured base SHA. `fetchSource`
  remains a file-list interface, using Git tree/blob reads with concurrency 8; truncated trees and unsupported
  symlink/submodule entries fail rather than silently changing the repository. Tarball streaming is deferred. Actual
  trigger provenance (delivery ID, sender and label) must be appended by the later webhook admission layer; fetching
  an issue alone cannot infer the event that caused this session.
- **Checks:** HTTP contract tests cover stage receipts/restarts, lost responses, ref/PR races, binary/deletion/mode
  payloads, base movement, comment deduplication and App token scoping. A SessionHost integration check exercises
  Pi-backed publication receipts across a process restart. The opt-in live scratch App check is documented in
  `apps/agent/README.md`; it requires an existing App installation and has not yet run. The dev Worker still uses
  fake GitHub/models; webhook admission, the inbox and production deployment remain later work.

## Remaining questions

- Validation dependencies: are baked caches enough for typical repos, or do we need an egress allowlist?
- Throughput of tarball upload through pi-env chunks for large repositories.

### Step 5 as built

The Worker admits only signed `issues/labeled/agent` deliveries for its configured repository and installation,
hydrates context and provenance, then acknowledges the durable admission. Named sessions use `owner/repo#issue`;
reads never initialize one. Access JWT verification maps a verified email to a configured GitHub reviewer. Local
static tokens require explicit dev mode with no Access configuration. Mutation requests require same-origin JSON;
actors are derived on the server. The arbitrary development delivery route is removed.

Shared contracts expose list, detail, viewer, approve/reject/cancel and additional input. Applied/duplicate decisions
return the authoritative view; stale decisions return 409 with the current view. The inbox shows exact approval
identity, diff and evidence; blocks decisions in flight; and confirms candidate replacement by additional input.

D1 receives a transactional newer-revision-only summary upsert and an instruction-keyed audit insert. Project
instructions now freeze their own state snapshot, preserving audit identity across delayed/replayed execution.
The list is bounded to 100 summaries, detail history to 200 rows; neither API pagination nor global index rebuild
is included. Decisions use DO state regardless of index lag. See `apps/agent/README.md` for configuration, local
fixtures, schema compatibility and remaining deployment/live-App checks.

Step-5 review corrections: production repository, installation ID and validation commands must be explicitly
configured; fixture defaults apply only in dev. A failed D1 audit read or missing patch blob no longer hides session
state. Detail carries availability flags, the UI explains degradation, and cancellation remains possible; approving
requires the matching displayed patch. Hydration still precedes delivery dedupe per the admission design: a duplicate
can fail during hydration without changing durable state. Opening independently known session IDs remains available
through the API; a direct-open UI shortcut and global index recovery remain deferred.

### Automatic publication follow-up

`auto` publishes a validated current-run candidate immediately through the existing durable Publish/Reconcile path.
`observe` preserves the original approval gate, and `off` blocks new admissions. Real-service mode requires an
explicit choice; development defaults to auto. The policy is stored at session creation, so existing sessions are
not silently converted. There is no synthetic human approval, and `decidedBy` stays null for auto publication.
The inbox detail shows the saved mode. PR creation is automatic; merging remains separate. See
[automatic-pr.md](automatic-pr.md) for stop behavior, validation/replay criteria and rollback considerations.
