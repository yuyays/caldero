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
overwrites an existing ref.

## Status

Alpha. The local path is the one exercised end to end; the Cloudflare path is
implemented but has not been validated as a deployment.

| Path                                             | Status                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Local issue runner and label watcher             | Implemented, run end to end with a real Pi login and GitHub App |
| `pnpm status` (read-only session inspection)     | Implemented; optional GitHub CI lookup on the saved PR          |
| Cloudflare Worker, Durable Object, Container, R2 | Implemented; exercised in local development only                |
| React inbox                                      | Reads the Worker path, not local SQLite sessions                |
| Slack, cron, scheduler, CI repair                | Not built                                                       |

## Requirements

- Node.js 24.11 or newer, pnpm 12.21 (see `engines` and `packageManager`)
- Linux with `flock` for the local runner, plus a [Pi](https://github.com/earendil-works/pi)
  profile and login
- A GitHub App installed on **one** repository, with Contents, Pull requests and
  Issues write permission
- Docker for Cloudflare local development

See the [toolchain rough edges](CONTRIBUTING.md#toolchain-rough-edges) before
reporting a setup problem.

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
```

`pnpm status` reads saved state and lock ownership only. It opens no session, loads
no credentials, and does not prove a worker is alive. `pnpm retry` is an explicit
action for failed sessions; rerunning `local` only resumes non-terminal work.

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

## Repository layout

```
apps/agent      shared session host, local runner/watcher, Cloudflare adapters
apps/web        React inbox for the Worker backend
packages/domain     pure session model and transitions
packages/contracts  shared request/response schemas
docs/           architecture, designs, and time-pinned research
tools/          lint rules and the tests that prove they fire
```

[`docs/architecture.md`](docs/architecture.md) is the map: shared session core, both
execution paths, storage ownership, and what remains unbuilt. [`PRODUCT.md`](PRODUCT.md)
describes the inbox.

## Verify changes

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Browser component tests need a one-time download: `pnpm browser:install`, then
`pnpm test:browser`.

Expect a demanding toolchain: TypeScript 7, `vite-plus`, and an `@effect/tsgo` patch
that `pnpm install` applies to `tsc` and `oxlint` through `prepare`. `pnpm test`
includes tests that lint deliberately invalid examples, which is how the custom rules
are shown to work rather than merely configured. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

The local runner is **not a sandbox**: tools execute with your user's filesystem
permissions, so run it only against repositories you trust. The Cloudflare path
starts its container with internet disabled and keeps GitHub credentials on the host.

Report vulnerabilities through [private advisories](https://github.com/yuyays/caldero/security/advisories/new);
[`SECURITY.md`](SECURITY.md) lists the trust boundaries and known gaps.

## License

[MIT](LICENSE)
