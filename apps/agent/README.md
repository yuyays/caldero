# Agent local development

For the shared core, current local execution, cloud implementation status and
future capabilities, start with the [architecture overview](../../docs/architecture.md).

From the repository root:

```sh
pnpm install
pnpm --filter @caldero/web build
CALDERO_MODE=dev CALDERO_DEV_TOKEN=local-check GITHUB_WEBHOOK_SECRET=fixture-secret \
  sg docker -c 'pnpm --filter @caldero/agent dev'
```

Open http://localhost:1337 and enter `local-check` under “Local development token”. These example values are local
fixtures, not production credentials. Alchemy runs local workerd, D1/SQLite, R2 and the Docker sandbox. No dev
command deploys resources. The image builds the pinned public `pi-env` 1.5.2 daemon and contains git, bash and
coreutils. Container internet is disabled; projects needing validation dependencies must bake those into the image.
The explicit `dev` mode uses faux models and FakeGitHub; production never falls back to them.

To admit the fixture issue, run this from the repository root while the agent is running:

```sh
node --input-type=module <<'JS'
import { createHmac } from 'node:crypto';
const body = JSON.stringify({ action: 'labeled', repository: { full_name: 'acme/app' },
  installation: { id: 42 }, label: { name: 'agent' }, issue: { number: 7 }, sender: { login: 'reviewer' } });
const signature = createHmac('sha256', 'fixture-secret').update(body).digest('hex');
const response = await fetch('http://localhost:1337/webhooks/github', { method: 'POST', body,
  headers: { 'x-hub-signature-256': `sha256=${signature}`, 'x-github-event': 'issues', 'x-github-delivery': 'demo-7' } });
console.log(response.status);
JS
```

A new local session writes and checks `notes.txt`, then opens a fake PR automatically. The inbox shows its diff,
digest, base, version and validation evidence. Repeating the delivery ID does not change the session. Stop asks
for confirmation and is available before publication starts. New instructions steer work; in a legacy paused
session they explicitly replace the old candidate with a fresh run.
The unauthenticated `/s/:name/deliver` development route has been removed.

`pnpm dev:web` supports frontend editing on port 5173, proxying `/api` to the agent on 1337. Set
`CALDERO_ORIGIN=http://localhost:5173` in the agent environment for that workflow. The built app uses the same origin
as the Worker and needs no `VITE_API_URL`. Local tokens stay in page memory, never browser storage or build output.

## Production configuration (no deployment performed)

Production is the default mode. Set these environment inputs before running Alchemy; the Worker declares each as
an explicit binding and marks credentials redacted. Keep secrets out of git and the sandbox.

| Setting                                   | Value                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `CALDERO_ORIGIN`                          | Exact HTTPS inbox origin, no trailing slash                                     |
| `CALDERO_REPO_OWNER`, `CALDERO_REPO_NAME` | One configured repository                                                       |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | Installed GitHub App identity                                                   |
| `GITHUB_PRIVATE_KEY`                      | Secret PEM App key                                                              |
| `GITHUB_WEBHOOK_SECRET`                   | Secret matching GitHub's webhook configuration                                  |
| `ACCESS_ISSUER`                           | Team issuer, e.g. `https://team.cloudflareaccess.com`                           |
| `ACCESS_AUDIENCE`                         | This Access application's audience                                              |
| `ACCESS_APPROVERS`                        | JSON map of verified email to GitHub login, e.g. `{"ann@example.com":"ann"}`    |
| `OPENAI_API_KEY`, `CALDERO_MODEL`         | Secret API key and explicit OpenAI model ID                                     |
| `CALDERO_CHECKS`                          | Nonempty JSON array of validation commands baked into the sandbox's environment |

Configure an Access application for the inbox/API. Exclude `/webhooks/github` from Access so GitHub can reach it;
the Worker authenticates that route with HMAC on the original bytes. Subscribe to issue events. Only `labeled`,
label exactly `agent`, the configured repository/installation, and non-PR issues are admitted. Other verified events
return 204. The first successful admission fixes the hydrated base and records delivery/sender/label provenance.
Known session identity or unreadable-state faults return typed HTTP 500 `SessionFault` and require operator repair.
Their DO instance stops its host and alarm; repeating a start does not clear the fault. Other RPC failures remain 503
with a diagnostic reason (`temporary`, `overloaded`, or `unknown`) and do not prove whether a mutation committed.
The inbox stops polling permanent faults/overloads and does not retry mutations automatically. See
[session fault design](../../docs/design/session-faults.md) for ownership, recovery and residual unknown failures.
A caller must not retry indefinitely. Hydration precedes session dedupe, so even redelivery may fail on GitHub reads; it never changes an already-admitted
session's base. Acknowledgement waits for the durable admission commit; a lost response can be retried with the same delivery ID.

API identity comes only from a cryptographically verified Access JWT (RS256, issuer, audience, expiry/not-before).
The email header and request-body actor are never trusted. Unmapped identities get 403; invalid tokens or JWKS
failures get 401. All decisions require same-origin JSON. `CALDERO_DEV_TOKEN` is accepted only in explicit dev mode
with no Access configuration. Missing production authentication, webhook or App/model configuration fails closed.

Session detail degrades independently: a failed audit read returns an empty activity list with an unavailable flag,
and a missing/corrupt patch blob returns the authoritative state with a patch-unavailable flag. The UI explains
these failures and keeps Stop available in eligible pre-publication states.

D1 migrations live in `migrations/`. D1 stores bounded summaries and revision activity, never file contents or
validation output. `Project` carries its committed revision's immutable snapshot, so retries cannot relabel a newer
state. A batch inserts the audit receipt once and updates the list only for a newer revision. No decision reads D1;
list results can lag the authoritative detail. There is no global rebuild command: DO namespaces cannot enumerate
sessions, so recovering a lost index requires an independently known set of session IDs. The list returns up to 100
sessions and detail returns the first 200 activity rows; pagination is deferred.

Use fresh development sessions: the journal now requires a snapshot on `Project`, and the DO identity is the
configured `owner/repo#issue`. Sessions saved by earlier demos are incompatible. Terminal sessions currently have
no public restart action; implementing another attempt for the same issue is deferred.

`registerWorkspaceContract` in `src/workspace-contract.integration.ts` accepts a prepared adapter fixture, its raw
environment, store and a disk/boot reset operation. The Node fixture runs it in the ordinary suite; a container
fixture can reuse the same checks. Session recovery tests use Pi MemoryStorage and `makeProcess` gates at the two
checkpoint crash windows. No test or dev command deploys Cloudflare resources.

## GitHub App adapter

`GitHubApp.layer` / `GitHubApp.make` in `src/github-app.ts` implements the GitHub seam. Configure one repository,
App ID, installation ID, PEM private key, and commit author. Installation tokens are minted per operation with
repository-scoped Contents, Pull requests and Issues write permissions. Keep the private key in the host; the adapter
returns file bytes, never credentials, to `Workspace`. Explicit local mode uses FakeGitHub; production connects this adapter to verified admission and the session API.

`fetchIssueContext` returns the issue, paginated comments, root `AGENTS.md`, default branch name and its captured
commit. Pass these into `IssueLabeled`. Candidate bindings include `baseRef`; previously saved development sessions without
that field are incompatible and must use a fresh session name. Source fetches use the Git tree/blob APIs with bounded
concurrency; truncated trees, symlinks and submodules fail explicitly. Tarball streaming remains future work.

Publishing requires a `PublishJournal`. SessionHost supplies a Pi document with one entry per candidate version.
The adapter freezes commit metadata before calling GitHub and stores each stage's receipt before advancing. It never
force-updates a branch. An ambiguous result is reconciled against the expected commit and open **or closed** PRs;
an expected branch with no PR finishes only the PR stage. A moved base branch ends the session as `failed`; there is
no automatic rebase. Explicit retry reconciles the same frozen candidate; it does not bypass a moved-base conflict.
A genuinely new task needs updated context and validation. The adapter checks the base before creating a branch and again before opening a missing PR. A base
that moves between those checks may still leave an unused branch; the adapter never deletes or overwrites it.

### Live scratch contract check (opt-in)

Ordinary tests use an HTTP peer and faux models. The live check creates a branch and PR in an existing scratch
repository using **GitHub App installation credentials**, verifies binary bytes and executable modes, and checks
reconciliation returns the same PR. It leaves the branch/PR for inspection and prints their URL. It does not merge.
The scratch repository must have a default branch, an issue, and no unsupported symlinks or submodules.

Set these environment variables outside the sandbox:

```sh
export CALDERO_GITHUB_CONTRACT=1
export CALDERO_GITHUB_OWNER=your-owner
export CALDERO_GITHUB_REPO=your-scratch-repo
export CALDERO_GITHUB_ISSUE=1
export CALDERO_GITHUB_APP_ID=your-app-id
export CALDERO_GITHUB_INSTALLATION_ID=your-installation-id
export CALDERO_GITHUB_PRIVATE_KEY_FILE=/secure/path/app.pem
export CALDERO_GITHUB_JOURNAL_FILE=/secure/path/contract-journal.json
pnpm exec vp test run apps/agent/src/github-app.contract.integration.test.ts
```

The App must be installed on that repository with Contents, Pull requests and Issues write permissions. Reuse the
journal file to re-check the same publication after a restart; use a new filename for a separate check. The SDK
also accepts `apiUrl` for GitHub Enterprise or a local contract peer; no credentials are copied into the workspace.

## Run locally with your installed Pi profile

On Linux (with `flock` from util-linux installed), the local entrypoint uses Pi's official `ModelRuntime` and `SettingsManager` SDK. It reuses your saved provider,
model, reasoning level and login from Pi's agent directory (`~/.pi/agent` or `PI_CODING_AGENT_DIR`). OAuth refresh
and credential locking are handled by Pi. You do not need another API key when the provider supports that login.
The SDK version is pinned alongside Caldero's Pi Durable version.

```sh
pnpm --filter @caldero/agent local --check-connection
pnpm --filter @caldero/agent local --issue 123 --check 'pnpm install --frozen-lockfile && pnpm test'
```

Replace `123` and the checks with the issue and validation commands you intend to run. It reads the host-only
GitHub App configuration at `~/.config/caldero/github-app.json`:

```json
{
  "appId": "YOUR_APP_ID",
  "installationId": 123456,
  "repo": { "owner": "YOUR_OWNER", "name": "YOUR_REPO" },
  "privateKeyFile": "/absolute/path/to/app-private-key.pem"
}
```

Use `--github-config`, `--pi-dir` or `--state-dir` to select other paths. Each issue has a locked SQLite session and
disk-backed checkpoints/candidates under `~/.local/state/caldero/OWNER/REPO/ISSUE`. Repeat the same command to resume
nonterminal work; a published session retains its PR instead of starting another. Failed and cancelled sessions are
terminal: rerunning reports their saved outcome and does not restart them. Use explicit retry below for failed sessions. Start a genuinely new task with a new
GitHub issue, which gets its own state directory. Keep old directories for their publication receipts; changing
`--state-dir` selects storage, it does not restart an existing session. The first Ctrl-C requests Stop and drains tools;
once publishing starts it waits for the result. A second Ctrl-C exits immediately. The OS file lock has no stale timeout: a paused runner keeps ownership, and
exiting releases it without a stale-lock wait.

This is a trusted-local runner: tools execute with your user's filesystem permissions. Its minimal subprocess
environment excludes inherited credentials and uses a separate HOME, but it is not a filesystem sandbox. Pi login
files and GitHub keys are not placed in workspace snapshots or model prompts by the runner. Caldero keeps its own
durable tools and issue/AGENTS.md context rather than loading interactive Pi extensions or skills. The Cloudflare
Worker path is unchanged and does not read local Pi files. No webhook, Access setup or cloud deployment is needed
for this explicit local issue run. See [local Pi design](../../docs/design/local-pi.md).

### Retry a failed local issue

```sh
pnpm retry --issue 11 \
  --check 'pnpm install --frozen-lockfile' --check 'pnpm test'
```

Use the configured repository's real checks. Retry is an explicit action: supply the
same GitHub configuration, Pi profile and issue state directory as the original
run (`--state-dir <state-root>/11` for a custom watch root). It refuses missing,
uninitialized, unreadable, running, published and cancelled sessions.

Editing/check failures start a new run with the previous failure in its prompt,
using the saved conversation, workspace and original base. Publication failures
reconcile the same frozen candidate and publication receipts first: an existing
PR is recovered rather than replaced. A failed follow-up run keeps its earlier
PR and uses the next candidate version. Retry does not rebase, remove branch
conflicts or repair credentials; fix the external cause before retrying.

The normal attempt limit still applies. Repeating `pnpm local` only resumes
nonterminal work; it does not request another retry. After an interrupted retry has committed,
resume with the original `local --issue N` command and the same state directory.
If retry had not committed, the session remains failed and needs the retry command again.
The watcher still leaves settled terminal sessions alone. Use `pnpm status
--issue 11` to inspect the result. See [retry design](../../docs/design/local-retry.md).

### Repair a failing PR locally

```sh
pnpm repair --issue 123 --check 'pnpm test'
```

Use a published Caldero session with an open PR from the configured App and a
failed GitHub Actions job on its current head. GitHub CLI supplies the job log
through your login. Caldero runs the supplied local checks and appends one commit
to the same PR only while the pinned head is current. Resume an interrupted repair
with the original local runner and the same checks and state directory.
See [local repair](../../docs/design/local-repair.md).

### Watch labeled issues locally

```sh
pnpm --filter @caldero/agent local --watch \
  --check 'pnpm install --frozen-lockfile' --check 'pnpm test'
```

This polls the configured repository for open issues labeled `agent`, one issue
at a time, using the same Pi login and GitHub App. Checks must match that repository.
Use `--label NAME`, `--poll-seconds 60` and `--state-root PATH` to override discovery
and storage. Repeating the command resumes admitted work; terminal sessions are
not retried. Removing a label stops admission of an idle issue, not work already
in progress. The first Ctrl-C finishes the current issue and stops; the second
exits immediately. Keep the same state root to preserve publication receipts.
To open one of these sessions manually, use `local --issue N --state-dir <state-root>/N`
with the same checks and GitHub configuration. Omitting that flag uses the default
state path, which is a separate session if you selected a custom watch root.
Eligibility is checked at scan time: closing an issue while an earlier issue runs
does not change the current scan's queue. The next successful scan rechecks idle work.
This is a foreground command on this machine, not an installed background daemon.
See [watch design](../../docs/design/local-watch.md) for recovery and failure rules.

### Inspect local progress and results

From the repository root:

```sh
pnpm status
pnpm status --issue 11
pnpm status --issue 11 --ci
pnpm --silent --filter @caldero/agent status --repo OWNER/REPO --json
```

Status reads the existing repository state root; use `--state-root PATH` for a
custom watch root. It reports saved phases, attempts, queued follow-ups, failures,
validation evidence and PR links without opening the agent or requiring a Pi
login/private key. The default GitHub config supplies only repository identity;
use `--repo OWNER/REPO` to avoid reading it. Status runs offline by default.

For an issue with a saved PR, `--ci` uses your signed-in [GitHub CLI](https://cli.github.com/)
to read the aggregate check result on the PR's current head commit. It reports
failing checks and their links when GitHub supplies them, and consolidates runs
of the same check in the returned details. `--json` includes the head SHA, check
details and GitHub's full counts by state. When GitHub reports more than 100
contexts, the terminal directs you to the full PR checks page for individual
failures. If GitHub cannot be reached or your login cannot access the PR,
status still reports the saved session and marks CI as unavailable. GitHub checks
describe the current PR head, which can advance after local validation.

Watch output is **lock ownership**, not a health check. A saved active phase is
not proof of a live worker. Unknown lock inspection and unreadable sessions are
reported explicitly. SQLite may create WAL/SHM bookkeeping sidecars while reading;
session data is never migrated or changed. The React inbox remains disconnected
from local sessions. See [status design](../../docs/design/local-status.md).

## Automatic publication

Every new session opens its PR automatically after the configured `CALDERO_CHECKS` pass in the sandbox. There is
no approval-mode setting or approve/reject action. The model cannot declare validation successful; only the
workspace validation outcome starts publication. GitHub CI can run after the PR opens. Review and merging happen
on GitHub; Caldero never merges automatically.

Stop works before publication begins. Once publishing starts, its remote outcome may already have landed.
Historical state fields remain readable without rewriting stored documents or task journals. A legacy session
paused in `awaitingApproval` stays paused until new instructions create a fresh run, or Stop cancels it. Its old
candidate is never published merely by upgrading. An already running legacy session publishes its next successfully
validated candidate automatically. `CALDERO_POLICY` has been removed and any old environment value is ignored.
See [automatic PR design](../../docs/design/automatic-pr.md) for acceptance criteria and rollback compatibility.
Existing GitHub App permissions remain sufficient; no additional scopes are requested.
