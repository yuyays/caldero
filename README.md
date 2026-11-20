# caldero

Caldero turns a GitHub issue into a reviewed pull request. Label an issue `agent`,
and a durable session works in a workspace, runs your checks against a frozen
candidate, and opens a PR only if they pass. Merging stays yours.

```
issue labeled "agent" ──► session ──► change ──► validate ──► pull request
                           durable              the gate      you review
```

The model cannot declare its own work valid: only the workspace's check result
starts publication. Caldero never merges, never force-updates a branch, and never
overwrites an existing ref during initial publication. Explicit CI repair can
append one checked commit to the existing PR branch.

## Status

Alpha. The local path is exercised end to end; the Cloudflare path is implemented but
has never been validated as a deployment. Slack, cron, a scheduler and automatic CI
repair are future work. The [full status table](docs/architecture.md#implementation-and-deployment-status)
tracks each piece and says what is unbuilt.

## Requirements

- Node.js 24.11 or newer, pnpm 12.21 (see `engines` and `packageManager`)
- Linux with `flock` for the local runner, plus a [Pi](https://github.com/earendil-works/pi)
  profile and login
- A GitHub App installed on **one** repository, with Contents, Pull requests and
  Issues write permission
- Docker for Cloudflare local development

See [CONTRIBUTING.md](CONTRIBUTING.md) before reporting a setup problem.

## Run a single issue

Create `~/.config/caldero/github-app.json` (keep the private key outside this repo):

```json
{
  "appId": "YOUR_APP_ID",
  "installationId": 123456,
  "repo": { "owner": "YOUR_OWNER", "name": "YOUR_REPO" },
  "privateKeyFile": "/absolute/path/to/app-private-key.pem"
}
```

Then check the connection and run one issue:

```sh
pnpm --filter @caldero/agent local --check-connection
pnpm --filter @caldero/agent local --issue 123 --check 'pnpm install --frozen-lockfile && pnpm test'
```

The checks must be the ones that repository actually uses. Each issue gets a locked
SQLite session and disk-backed checkpoints under `~/.local/state/caldero/OWNER/REPO/ISSUE`;
rerunning the same command resumes non-terminal work instead of starting over.

## Watch labeled issues

```sh
pnpm --filter @caldero/agent local --watch --check 'pnpm test'
```

The watcher polls the configured repository and runs one issue at a time. It is a
foreground command, not an installed daemon: the first `Ctrl-C` finishes the current
issue and stops admitting new ones.

## Inspect, retry, and steer

```sh
pnpm status                     # saved phases, evidence, failures, PRs
pnpm status --issue 123 --ci    # add real check results from the PR's current head
pnpm retry --issue 123 --check 'pnpm test'
pnpm repair --issue 123 --check 'pnpm test'
```

`pnpm status` reads saved state and lock ownership only. It opens no session, loads
no credentials, and does not prove a worker is alive. `pnpm retry` is an explicit
action for failed sessions; rerunning `local` only resumes non-terminal work.
Repair needs a published Caldero session with a failing GitHub Actions job on
the current PR head and a signed-in GitHub CLI. See [repair behavior](docs/design/local-repair.md).

## Cloudflare development

```sh
pnpm --filter @caldero/web build
CALDERO_MODE=dev CALDERO_DEV_TOKEN=local-check GITHUB_WEBHOOK_SECRET=fixture-secret \
  sg docker -c 'pnpm --filter @caldero/agent dev'
```

Open <http://localhost:1337> and enter `local-check`. Those values are local
fixtures, not credentials: dev mode uses faux models and a fake GitHub, and no
command deploys resources. Production configuration is a separate set of bindings,
documented in the [agent guide](apps/agent/README.md#production-configuration-no-deployment-performed).

## Layout

`apps/agent` holds the session host plus the local and Cloudflare adapters, `apps/web`
is the inbox, `packages/domain` is the reducer, and `packages/contracts` holds the wire
schemas. [`docs/architecture.md`](docs/architecture.md) has the full map — which module
owns which decision, both execution paths, and what remains unbuilt — and
[`PRODUCT.md`](PRODUCT.md) describes the inbox.

## Verify changes

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Browser component tests need a one-time download: `pnpm browser:install`, then
`pnpm test:browser`. `pnpm test` also lints deliberately invalid examples, which is how
the custom rules are shown to work rather than merely configured.

## Security

The local runner is **not a sandbox**: tools execute with your user's filesystem
permissions, so run it only against repositories you trust. The Cloudflare path
starts its container with internet disabled and keeps GitHub credentials on the host.

Report vulnerabilities through [private advisories](https://github.com/yuyays/caldero/security/advisories/new);
[`SECURITY.md`](SECURITY.md) lists the trust boundaries and known gaps.

## License

[MIT](LICENSE)
