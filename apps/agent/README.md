# Agent local development

From the repository root:

```sh
pnpm install
sg docker -c 'pnpm --filter @puchero/agent dev'
```

This starts Alchemy's local workerd, Docker sandbox and local R2 emulator. The image builds the pinned public
`pi-env` 1.5.2 daemon; no binary or credential is copied from this machine. It contains git, bash and coreutils.
Container internet is disabled. Projects needing other validation dependencies must bake those into the image.

The development transport uses faux models, FakeGitHub, an in-memory projection and fixed `acme/app#7` metadata.
Each URL name still selects a separate DO, SQLite history, sandbox and R2 namespace. It has no webhook verification
or inbox authentication; those belong to later steps.

```sh
curl -X POST localhost:1337/s/demo/deliver -H 'Content-Type: application/json' \
  --data '{"eventId":"label-1","event":{"_tag":"IssueLabeled","context":"Write the notes.","baseSha":"base-1","baseRef":"main"}}'
curl localhost:1337/s/demo/view
```

The view eventually reaches `awaitingApproval`, with a patch and validation output. Repeating the delivery ID is
idempotent. To approve, send an `Approve` event with `actor` and the exact `state.candidate.binding` from that view,
using a new `eventId`.

`registerWorkspaceContract` in `src/workspace-contract.integration.ts` accepts a prepared adapter fixture, its raw
environment, store and a disk/boot reset operation. The Node fixture runs it in the ordinary suite; a container
fixture can reuse the same checks. Session recovery tests use Pi MemoryStorage and `makeProcess` gates at the two
checkpoint crash windows. No test or dev command deploys Cloudflare resources.

## GitHub App adapter

`GitHubApp.layer` / `GitHubApp.make` in `src/github-app.ts` implements the GitHub seam. Configure one repository,
App ID, installation ID, PEM private key, and commit author. Installation tokens are minted per operation with
repository-scoped Contents, Pull requests and Issues write permissions. Keep the private key in the host; the adapter
returns file bytes, never credentials, to `Workspace`. The local DO demo still uses FakeGitHub; webhook wiring and
production configuration are later work.

`fetchIssueContext` returns the issue, paginated comments, root `AGENTS.md`, default branch name and its captured
commit. Pass these into `IssueLabeled`. Approvals now include `baseRef`; previously saved development sessions without
that field are incompatible and must use a fresh session name. Source fetches use the Git tree/blob APIs with bounded
concurrency; truncated trees, symlinks and submodules fail explicitly. Tarball streaming remains future work.

Publishing requires a `PublishJournal`. SessionHost supplies a Pi document with one entry per candidate version.
The adapter freezes commit metadata before calling GitHub and stores each stage's receipt before advancing. It never
force-updates a branch. An ambiguous result is reconciled against the expected commit and open **or closed** PRs;
an expected branch with no PR finishes only the PR stage. A moved base branch requires a new candidate and approval.

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
