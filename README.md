# puchero

Puchero runs a durable coding agent from a labeled GitHub issue, checks its changes,
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

The React inbox currently reads the Worker backend, not local-runner SQLite.
The separate Node/PostgreSQL starter API below is not required for the local agent.

## Optional starter API setup

Set `DATABASE_URL` in `apps/api/.env` to a running PostgreSQL database first.

The API loads `.env` through Effect's configuration provider, with environment
variables taking priority. The file is optional; missing required values, invalid
values, and file read errors still fail startup. Restart the API after editing `.env`.

```sh
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev:api
```

`pnpm dev:api` starts the Node starter API. `pnpm dev:web` starts the React inbox;
follow [agent setup](apps/agent/README.md) for its backend. The frontend proxies
`/api` to the agent on 1337 and `/docs` to the separate Node starter API; ports are
set in `apps/web/vite.config.ts` and `apps/api/.env`.

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

The included pnpm lockfile keeps dependencies on the starter's tested versions.

## API production build

Workspace packages export their TypeScript source, so nothing is compiled first. In
development, `node --watch` runs `apps/api/src/main.ts` and restarts the API
when it or a workspace package changes.

`pnpm build` typechecks the API and bundles it with its workspace packages into
`apps/api/dist/main.js`. The API's `dependencies` stay external and everything else is
bundled, so Node.js runs only JavaScript in production.

Start the API with `pnpm start:api` from the project root, with `DATABASE_URL` and
`PORT` set. It runs `dist/main.js` on Node.js with `apps/api` as the working directory.
Deploy `apps/api/dist` with the API's production `dependencies`; workspace packages are
already in the bundle.

Explicitly retry failed local issues with `pnpm retry --issue N --check COMMAND`; see
[retry operations](apps/agent/README.md#retry-a-failed-local-issue).
