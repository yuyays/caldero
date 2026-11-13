# Spike: Pi Durable in an Alchemy Durable Object with a Container sandbox

PROTOTYPE, throwaway. Lives on branch `spike/pi-do-container`, not `main`. Run 2026-11-14, locally only.

**Question:** can Pi Durable run inside an Alchemy v2 Cloudflare Durable Object on its SQLite storage, execute its
tools in a Cloudflare Container, and recover on its own after crashes, long turns and container resets?

**Verdict: yes, locally.** All five checks passed under `alchemy dev` (workerd + Docker). Deployed Cloudflare
behavior, especially CPU limits, is still unproven.

## Run it

```sh
pnpm install
sg docker -c "pnpm dev"   # or plain `pnpm dev` once your shell has the docker group
curl -X POST "localhost:1337/s/demo/submit?text=go&requestId=r1"
curl localhost:1337/s/demo/status | jq   # full state: wake, alarm, container, tasks, transcript
curl -X POST localhost:1337/s/demo/crash # instance reset mid-work
curl -X POST localhost:1337/s/demo/reset # destroy the container (wipes its disk)
```

The model is Pi's faux provider, scripted from the transcript (`src/pi-host.ts`): write a file, sleep 90 s in the
container, read the boot marker and progress file back, answer. No API key is needed.

## Pieces

| File | Role |
|---|---|
| `src/Session.ts` | Alchemy Effect Durable Object; opens the Pi host in its per-instance init, exposes `submit`/`status`/`alarm` |
| `src/pi-host.ts` | Pi Durable Harness on `openDurableObjectSqliteStorage(state.raw.storage)`; README `onWake` alarm pattern |
| `src/container-connection.ts` | Port of pi-env's MIT `Connection`: starts `pi-env serve` through `ctx.container.exec` instead of `spawn` |
| `src/Sandbox.ts`, `sandbox-image/` | Container: Debian, git, the `pi-env` daemon, a per-boot marker in `/workspace/.boot` |
| `src/worker.ts` | Routes `/s/:id/...` to the session object |

Pinned: `@earendil-works/pi-durable`/`pi-env`/`pi-ai`/`chord` 1.5.2, `alchemy`/`@alchemy.run/cloudflare`
2.0.0-beta.87, `effect` 4.1.4.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Pi opens on DO SQLite and runs a turn | ✅ A repeated `requestId` returned the same submission (8) |
| 2 | Pi's tools run in the Container via `ExecutionEnv` | ✅ `RemoteExecutionEnv` over the ported connection; the boot marker came back as the tool result |
| 3 | Crash mid-tool → resumes by itself | ✅ Instance aborted 28 s into a 90 s `bash`; on reconstruction Pi recorded `bash was interrupted and may have partially run`, the model continued, the run finished, the alarm cleared |
| 4 | A turn longer than one invocation completes | ✅ locally: a 90 s tool with 30 s alarm heartbeats completed. ⚠️ Local workerd does not enforce Cloudflare CPU limits; prove it deployed |
| 5 | A container reset is detectable | ✅ After `destroy`, the boot marker changed and the earlier run's files were gone. Telling the model is not implemented yet |

## Findings for the real design

1. **Start containers through Alchemy's `sandbox.start()`.** It passes the Container's own image reference
   (`ctx.container.images[key]`); the native `start()` without an image starts nothing.
2. **An instance abort also kills its container**, and Alchemy may still report it as running for a moment. Call
   the idempotent `start()` before each `exec` attempt.
3. **Pi can own the single alarm** as long as Alchemy's `makeCallback` scheduler is unused in that object.
4. **The local sandbox is privileged:** Alchemy's local containers get `SYS_ADMIN`, `/dev/fuse` and an unconfined
   AppArmor profile for FUSE mounts. Don't treat `alchemy dev` as a security boundary.
5. **Workspace durability remains open.** Pi's transcript survived; the container's disk did not. The design's
   checkpoint-to-R2 and "workspace reset" notice are still needed (a `beforeRun` hook comparing the boot marker
   stored in a Pi document is the simple first version).
6. **Effect/Promise boundary:** Pi's Promise API sits behind `Effect.promise` in the object, and the container
   start crosses back with `Effect.runPromiseWith(context)`. It works, but the real code needs typed errors there.

## Not tested

Deployed Cloudflare (CPU limits, real eviction, container cold start), a real model or ChatGPT sign-in and token
refresh, steering while busy, concurrent sessions, and `pi-env` daemon reconnects after the connection drops.
