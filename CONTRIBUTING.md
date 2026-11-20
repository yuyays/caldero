# Contributing

Caldero is alpha and maintained by one person, so small pull requests are much easier
to review than large ones. For anything structural — a new adapter, a state-machine
transition, a rule change — open an issue first so the design can be agreed before the
code exists. Read [`docs/architecture.md`](docs/architecture.md) before changing
behavior: it records which module owns each decision.

Setup, requirements and the check commands live in the [README](README.md#verify-changes).
This file covers only what those don't: the conventions lint enforces, and how the
rule tests work.

## Conventions

Most of this is mechanical: `pnpm lint` reports it, and `AGENTS.md` is the full list in
the form coding agents read. Three rules explain almost every review comment:

- **Compose in Effect.** Backend workflows belong in Effect directly — wrapping a
  first-party async workflow in `Effect.promise` is not enough — with owned scopes for
  resources and background fibers. When extending a legacy Promise-based operation,
  migrate that operation rather than rewriting its neighbors.
- **Cross workspaces by package name only.** Share contracts through
  `packages/contracts`; never import another workspace by source path.
- **Tests observe contracts.** Synchronize with `TestClock` or an event signal rather
  than sleeping, and derive expectations independently of the implementation. A test
  that restates a mock's output proves nothing, and tests for removed features go away
  with them.

A suppression needs a reason: `// oxlint-disable-next-line rule -- why`.

## How the lint policy tests work

`tools/effect-policy.test.js` writes throwaway fixture directories _inside_ real source
trees — `apps/agent/src`, `packages/contracts/src`, `apps/web/src`, `tools` — because
rules are scoped by path overrides in `vite.config.ts`. A fixture has to sit where the
override applies or the test proves nothing.

Two consequences: if you add or change a rule, add a fixture that **fails without it**
(removing the override must make the test fail), and never leave a fixture behind —
they are created and deleted within the run, so don't name real files
`policy-fixture-*`.

Changes touching inbox authorization, webhook admission, publication, credentials or
workspace isolation deserve a note in the pull request; [`SECURITY.md`](SECURITY.md)
describes those boundaries and the known gaps, including that the local runner is not a
sandbox.

## Pull requests

Describe what changed and why, and show how you verified it — a failing-then-passing
test, or the exact commands you ran. Keep commits scoped so the diff reads as one idea.
