# Agent local development

From the repository root:

```sh
pnpm install
pnpm --filter @puchero/web build
PUCHERO_MODE=dev PUCHERO_DEV_TOKEN=local-check GITHUB_WEBHOOK_SECRET=fixture-secret \
  sg docker -c 'pnpm --filter @puchero/agent dev'
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

The session reaches `awaitingApproval` after writing and checking `notes.txt`. The inbox shows its diff, digest,
base, version and validation evidence. Approve opens a fake PR. Repeating the delivery ID does not change the
session. Reject/Stop ask for confirmation; sending instructions while awaiting approval explicitly replaces the
candidate. A stale decision returns HTTP 409 with the fresh session; the page displays it before another decision.
The unauthenticated `/s/:name/deliver` development route has been removed.

`pnpm dev:web` supports frontend editing on port 5173, proxying `/api` to the agent on 1337. Set
`PUCHERO_ORIGIN=http://localhost:5173` in the agent environment for that workflow. The built app uses the same origin
as the Worker and needs no `VITE_API_URL`. Local tokens stay in page memory, never browser storage or build output.

## Production configuration (no deployment performed)

Production is the default mode. Set these environment inputs before running Alchemy; the Worker declares each as
an explicit binding and marks credentials redacted. Keep secrets out of git and the sandbox.

| Setting                                   | Value                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `PUCHERO_ORIGIN`                          | Exact HTTPS inbox origin, no trailing slash                                     |
| `PUCHERO_REPO_OWNER`, `PUCHERO_REPO_NAME` | One configured repository                                                       |
| `PUCHERO_POLICY`                          | `observe` (default) or `off`                                                    |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | Installed GitHub App identity                                                   |
| `GITHUB_PRIVATE_KEY`                      | Secret PEM App key                                                              |
| `GITHUB_WEBHOOK_SECRET`                   | Secret matching GitHub's webhook configuration                                  |
| `ACCESS_ISSUER`                           | Team issuer, e.g. `https://team.cloudflareaccess.com`                           |
| `ACCESS_AUDIENCE`                         | This Access application's audience                                              |
| `ACCESS_APPROVERS`                        | JSON map of verified email to GitHub login, e.g. `{"ann@example.com":"ann"}`    |
| `OPENAI_API_KEY`, `PUCHERO_MODEL`         | Secret API key and explicit OpenAI model ID                                     |
| `PUCHERO_CHECKS`                          | Nonempty JSON array of validation commands baked into the sandbox's environment |

Configure an Access application for the inbox/API. Exclude `/webhooks/github` from Access so GitHub can reach it;
the Worker authenticates that route with HMAC on the original bytes. Subscribe to issue events. Only `labeled`,
label exactly `agent`, the configured repository/installation, and non-PR issues are admitted. Other verified events
return 204. The first successful admission fixes the hydrated base and records delivery/sender/label provenance.
Unknown RPC failures return 503 without acknowledging admission; this does not classify them as transient.
Identity/schema corruption requires operator repair, and permanent-vs-transient RPC error classification is deferred
before deployment. A caller must not retry indefinitely. Acknowledgement waits for the durable admission commit; a lost response can be retried with the same delivery ID.

API identity comes only from a cryptographically verified Access JWT (RS256, issuer, audience, expiry/not-before).
The email header and request-body actor are never trusted. Unmapped identities get 403; invalid tokens or JWKS
failures get 401. All decisions require same-origin JSON. `PUCHERO_DEV_TOKEN` is accepted only in explicit dev mode
with no Access configuration. Missing production authentication, webhook or App/model configuration fails closed.

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
returns file bytes, never credentials, to `Workspace`. Explicit local mode uses FakeGitHub; production connects this adapter to verified admission and the review API.

`fetchIssueContext` returns the issue, paginated comments, root `AGENTS.md`, default branch name and its captured
commit. Pass these into `IssueLabeled`. Approvals now include `baseRef`; previously saved development sessions without
that field are incompatible and must use a fresh session name. Source fetches use the Git tree/blob APIs with bounded
concurrency; truncated trees, symlinks and submodules fail explicitly. Tarball streaming remains future work.

Publishing requires a `PublishJournal`. SessionHost supplies a Pi document with one entry per candidate version.
The adapter freezes commit metadata before calling GitHub and stores each stage's receipt before advancing. It never
force-updates a branch. An ambiguous result is reconciled against the expected commit and open **or closed** PRs;
an expected branch with no PR finishes only the PR stage. A moved base branch ends the session as `failed`; there is
no restart transition for failed sessions in milestone 1. Start a fresh session from updated context and approve its
new candidate. The adapter checks the base before creating a branch and again before opening a missing PR. A base
that moves between those checks may still leave an unused branch; the adapter never deletes or overwrites it.

### Live scratch contract check (opt-in)

Ordinary tests use an HTTP peer and faux models. The live check creates a branch and PR in an existing scratch
repository using **GitHub App installation credentials**, verifies binary bytes and executable modes, and checks
reconciliation returns the same PR. It leaves the branch/PR for inspection and prints their URL. It does not merge.
The scratch repository must have a default branch, an issue, and no unsupported symlinks or submodules.

Set these environment variables outside the sandbox:

```sh
export PUCHERO_GITHUB_CONTRACT=1
export PUCHERO_GITHUB_OWNER=your-owner
export PUCHERO_GITHUB_REPO=your-scratch-repo
export PUCHERO_GITHUB_ISSUE=1
export PUCHERO_GITHUB_APP_ID=your-app-id
export PUCHERO_GITHUB_INSTALLATION_ID=your-installation-id
export PUCHERO_GITHUB_PRIVATE_KEY_FILE=/secure/path/app.pem
export PUCHERO_GITHUB_JOURNAL_FILE=/secure/path/contract-journal.json
pnpm exec vp test run apps/agent/src/github-app.contract.integration.test.ts
```

The App must be installed on that repository with Contents, Pull requests and Issues write permissions. Reuse the
journal file to re-check the same publication after a restart; use a new filename for a separate check. The SDK
also accepts `apiUrl` for GitHub Enterprise or a local contract peer; no credentials are copied into the workspace.
