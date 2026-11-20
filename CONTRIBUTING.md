# Contributing

Caldero is alpha and maintained by one person, so small, focused pull requests are
much easier to review than large ones. For anything structural — a new adapter, a
state-machine transition, a rule change — open an issue first so the design can be
agreed before the code exists.

Read [`docs/architecture.md`](docs/architecture.md) before changing behavior: it
records which module owns a decision, and several boundaries (the reducer, the
validation gate, publication) exist on purpose.

## Set up

Requirements: Node.js 24.11+, pnpm 12.21, Docker for Cloudflare local development,
`flock` (util-linux) for the local runner, and a Pi profile if you want to run the
agent against a real repository.

```sh
pnpm install
```

`prepare` patches the TypeScript and Oxlint binaries through `@effect/tsgo`. That is
expected, not a broken install. pnpm may also ask you to approve dependency-provided
agent skills — `pnpm approve` if you want them, otherwise ignore it.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test:browser` runs the component tests in Chromium and needs a one-time
`pnpm browser:install`. CI runs all of the above on every pull request.

There is no `pnpm format`; run `pnpm exec vp fmt .` to rewrite files.

## Toolchain rough edges

Being aware of these saves you a confusing hour:

- **TypeScript 7** with the native compiler, and `vite-plus` (`vp`) driving lint,
  format, test and build. Neither is the conventional setup you may expect.
- **`unstable-api-usage` warnings** on Effect and `@effect/vitest` APIs are
  expected and do not fail the build.
- **Integration tests** are named `*.integration.test.ts`. They spawn real processes
  and open SQLite files, so they run against a 30 s ceiling rather than 5 s.
- **Windows is untested.** The local runner assumes Linux semantics.

## House rules

These are enforced by lint where possible; `tools/effect-policy.test.js` proves the
rules actually fire.

**Effect.** Compose backend workflows directly in Effect — wrapping a first-party
async workflow in `Effect.promise` is not enough. Give resources and background
fibers an owning scope, cleanup, and failure reporting, and forward cancellation to
external SDKs where they support it. When you extend a legacy Promise-based
operation, migrate that operation to Effect without rewriting its neighbors.

**Workspace imports.** Share API contracts through `packages/contracts` and call the
API through its typed client. Use relative imports inside a workspace, and import
across workspaces by package name and public export only — never by source path.

**Tests.** Synchronize with `TestClock`, event signals, or retry assertions instead
of sleeping; lint rejects direct timer waits outside `*.integration.test.ts`. Test
observable contracts and plausible failures, and derive expectations independently of
the implementation — a test that restates a mock's output proves nothing. Avoid
pinning private structure, source text, or wording, and delete tests for features
that no longer exist.

**Comments.** Explain why a function or class exists; skip narrating each line. A
suppression needs a reason: `// oxlint-disable-next-line rule -- why` is enforced.

## How the lint policy tests work

`tools/effect-policy.test.js` writes throwaway fixture directories _inside_ real
source trees — `apps/agent/src`, `packages/contracts/src`, `apps/web/src`, `tools` —
because the rules are scoped by path overrides in `vite.config.ts`. A fixture has to
sit where the override applies, or the test proves nothing.

Two consequences:

- If you add or change a rule, add a fixture that **fails without it**. Removing the
  override must make the test fail; check that once locally.
- The fixture directories are created and deleted within the run. Never leave one
  behind, and don't name real files `policy-fixture-*`.

## Where things live

```
apps/agent/src/session-host.ts   durable execution over the session model
apps/agent/src/SessionDO.ts      Cloudflare Durable Object adapter
apps/agent/src/git-workspace.ts  checkpoint, restore and frozen candidates
apps/agent/src/github-app.ts     App credentials, branches, PR publication
apps/agent/src/local-*.ts        local runner, watcher, status and retry CLIs
packages/domain/src/session.ts   the reducer: transitions, limits, publication
packages/contracts/src/          shared wire schemas
apps/web/src/                    React inbox
tools/oxlint/                    local lint rules
```

## Security-sensitive changes

Changes touching inbox authorization, webhook admission, publication, credentials,
or workspace isolation deserve a note in the PR body. [`SECURITY.md`](SECURITY.md)
describes the trust boundaries and the known gaps, including the deliberate fact that
the local runner is not a sandbox.

## Pull requests

Describe what changed and why, and show how you verified it — a failing-then-passing
test, or the exact commands you ran. Keep commits scoped so the diff reads as one
idea. `AGENTS.md` holds the same rules in the shorter form AI coding agents read.
