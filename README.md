# puchero

Full-stack TypeScript app with React, TanStack Router/Query, Effect v4, Drizzle,
PostgreSQL, and Vite+, managed with pnpm. The API runs on Node.js.
See `engines` in `package.json` for required versions. [MIT License](LICENSE).

## Setup

Skip the install if the generator already installed dependencies.
Set `DATABASE_URL` in `apps/api/.env` to a running PostgreSQL database first.

The API loads `.env` through Effect's configuration provider, with environment
variables taking priority. The file is optional; missing required values, invalid
values, and file read errors still fail startup. Restart the API after editing `.env`.

```sh
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

`pnpm dev:web` or `pnpm dev:api` starts one server. The web app proxies
`/api` and `/docs` to the API; ports are set in `apps/web/vite.config.ts` and
`apps/api/.env`.

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
