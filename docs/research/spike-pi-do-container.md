2026-11-14

# Spike verdict: Pi Durable in a Durable Object with a Container sandbox

Code and full results: branch `spike/pi-do-container`, `spikes/pi-do-container/README.md` (commit `aceafec`).

**Question:** can Pi Durable run inside an Alchemy v2 Cloudflare Durable Object on its SQLite storage, run its
tools in a Cloudflare Container, and recover on its own after crashes, long turns, and container resets?

**Answer: yes, locally** (`alchemy dev`, workerd + Docker). Deployed CPU limits are still unproven.

| Check | Result |
|---|---|
| Pi on Durable Object SQLite | Passed; a repeated `requestId` returned the same submission |
| Tools in the Container | Passed; pi-env's connection ported to run its daemon through `container.exec` |
| Crash mid-tool | Passed; Pi recorded the call as interrupted, the model continued, the run finished |
| Long turn (90 s tool) | Passed locally with 30 s alarm heartbeats; CPU limits need a deploy |
| Container reset detectable | Passed; boot marker changed and files were gone; notifying the model is not built |

Decisions carried into the design:

- Start containers through Alchemy's `sandbox.start()`, and call it before each `exec` attempt.
- Pi owns the Durable Object's single alarm; don't use Alchemy's `makeCallback` scheduler in the same object.
- `alchemy dev` containers are privileged (`SYS_ADMIN`, `/dev/fuse`, unconfined AppArmor); not a security boundary.
- Workspace durability (checkpoint to R2, reset notice to the model) is still required.
