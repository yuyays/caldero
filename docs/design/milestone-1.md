2026-11-14 · Draft 2, revised after review by Codex (`gpt-6.1-sol`). Not yet approved.

# puchero milestone 1: issue → patch → approval → PR

**Goal.** A GitHub issue labeled `agent` gets one durable session. An agent works on it in a sandbox, produces a
validated, immutable patch, and waits. A human approves that exact patch in the inbox, and puchero opens the PR.
Everything survives deploys, evictions, and container resets.

Built on the spike's verdict ([spike-pi-do-container.md](../research/spike-pi-do-container.md)) and the
[Open SWE comparison](../research/open-swe-comparison.md). Vocabulary follows `codebase-design`: module,
interface, seam, adapter, depth.

**Out of scope:** Slack, cron, CI and review follow-ups as new runs, multiple users, ChatGPT sign-in, the audience
model, the `auto` policy, a scheduler, preview environments, and deleting `apps/api` (a separate cleanup).

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

**Commit intent, then act, then commit the outcome.** Every external action is an *instruction* stored in the same
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
  `Publish(binding)`, `Reconcile(binding)`, `Project(revision)`, `Comment(key, text)`.
- **States:** `idle → running → validating → awaitingApproval → publishing → published`, plus `rejected`,
  `cancelled`, `failed`. `version` increments with every proposed candidate; `runId` identifies each Pi run.
- **Rules it owns:**
  - Policy per repo + label: `off | observe` (milestone 1).
  - **Approval binding** `(sessionId, version, runId, repo, baseSha, patchDigest)`. A mismatch, a repeat of a
    decided approval, or any state but `awaitingApproval` is rejected as stale; a duplicate of the winning approval
    is a no-op.
  - **Results are bound to their run:** `Validated` for anything but the current `runId` is ignored, so queued input
    can never make an old result approvable.
  - **Input while `running` steers; while `validating` or `awaitingApproval` it invalidates the candidate** and
    starts a new run (`version + 1` on its proposal); **while `publishing` it queues** until the publish settles.
  - `PublishFailed("ambiguous")` yields `Reconcile`, never `Publish`.
  - Attempt limits for runs, validation, and publishing; exhaustion yields `failed` with a reason.

Policy, approval and queuing rules interact, so they stay in one module. **Test surface:** table-driven tests of
`decide`, in-process. Time comes from Effect's `Clock` (`TestClock` in tests); no clock seam.

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
  env(): ExecutionEnv                                       // guarded: see below
  prepare(repo: RepoRef, baseSha: string): Effect<void, WorkspaceError>
  validate(commands: string[]): Effect<Validation, WorkspaceError>   // frozen candidate: { patch, digest, evidence }
  quiesce(): Effect<void, WorkspaceError>                  // kill running commands; used by abort and cancel
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
  fetchIssueContext(issue: IssueRef): Effect<IssueContext, GitHubError>
  fetchTarball(repo: RepoRef, sha: string): Effect<ReadableStream, GitHubError>
  publish(binding: ApprovalBinding, patch: Patch, journal: PublishJournal): Effect<PullRequest, PublishError>
  reconcile(binding: ApprovalBinding, journal: PublishJournal): Effect<ReconcileResult, GitHubError>
  comment(issue: IssueRef, key: string, text: string): Effect<void, GitHubError>   // key in a hidden marker
}
```

- **Publish is journaled by stage** (`blobs → tree → commit → ref → pr`); each stage's result is committed before
  the next. Binary files go as base64 blobs, deletions as tree entries with `sha: null`, modes preserved.
  `base_tree` is the **tree SHA** of `baseSha`. Commit metadata (author, committer, dates, message) is fixed in the
  binding, so a retry produces the same commit SHA.
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
  binding shown, cancel. Auth: a fully validated Cloudflare Access JWT plus an allowlist of GitHub logins who may
  approve. Local dev uses a static dev token.
- **D1 projection:** `Project(revision)` upserts `sessions(..., revision)` only when its revision is newer, and
  inserts `audit` rows keyed by `instructionId`. D1 is rebuildable from the DOs; no decision reads it.

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
3. Approving opens exactly one PR on `puchero/<issue>-v<version>`, the session becomes `published`, and the issue
   gets exactly one linking comment.
4. A patch with a binary file, a deletion, and a mode change round-trips into the PR unchanged.

**Approval and input**
5. A stale binding, a repeated decided approval, and approval outside `awaitingApproval` change nothing; a
   duplicate of the winning approval is a no-op.
6. Input during `validating` or `awaitingApproval` invalidates the candidate; the next proposal is `version + 1`, and
   the old run's late `Validated` is ignored.
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

## Open questions

- Validation dependencies: are baked caches enough for typical repos, or do we need an egress allowlist?
- Throughput of tarball upload through pi-env chunks for large repositories.
