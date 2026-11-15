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
  --data '{"eventId":"label-1","event":{"_tag":"IssueLabeled","context":"Write the notes.","baseSha":"base-1"}}'
curl localhost:1337/s/demo/view
```

The view eventually reaches `awaitingApproval`, with a patch and validation output. Repeating the delivery ID is
idempotent. To approve, send an `Approve` event with `actor` and the exact `state.candidate.binding` from that view,
using a new `eventId`.

`registerWorkspaceContract` in `src/workspace-contract.integration.ts` accepts a prepared adapter fixture, its raw
environment, store and a disk/boot reset operation. The Node fixture runs it in the ordinary suite; a container
fixture can reuse the same checks. Session recovery tests use Pi MemoryStorage and `makeProcess` gates at the two
checkpoint crash windows. No test or dev command deploys Cloudflare resources.
