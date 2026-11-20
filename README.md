# caldero

Caldero runs a durable coding agent from a labeled GitHub issue, checks its changes,
and opens a pull request automatically when the checks pass. Review and merging
happen on GitHub.

Start with the [current architecture](docs/architecture.md) for the shared session
core, local and Cloudflare execution diagrams, and implementation/deployment status.
See `engines` in `package.json` for required versions. [MIT License](LICENSE).

## Run the agent

- [Local Pi setup and GitHub App configuration](apps/agent/README.md#run-locally-with-your-installed-pi-profile)
- [Watch labeled issues locally](apps/agent/README.md#watch-labeled-issues-locally)
- [Inspect saved local status](apps/agent/README.md#inspect-local-progress-and-results) with `pnpm status`
- [Cloudflare local development](apps/agent/README.md#agent-local-development) and
  [production configuration](apps/agent/README.md#production-configuration-no-deployment-performed)

The local runner keeps its own SQLite sessions; the React inbox reads the Worker
backend, not local-runner state. `pnpm dev:web` starts the inbox on 5173 and proxies
`/api` to the agent on 1337.

## Verify changes

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Component tests that need a real browser (`*.browser.test.tsx`) run in Chromium:
`pnpm browser:install` once per machine, then `pnpm test:browser`.

The checks enforce the Effect rules in `AGENTS.md`, and `pnpm test` proves that
invalid examples fail. Select the workspace TypeScript version in your editor to
see Effect diagnostics there.

The included pnpm lockfile pins the dependency versions the checks run against.

Explicitly retry failed local issues with `pnpm retry --issue N --check COMMAND`; see
[retry operations](apps/agent/README.md#retry-a-failed-local-issue).
