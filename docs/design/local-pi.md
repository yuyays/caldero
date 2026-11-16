# Use this machine's Pi profile

See the [architecture overview](../architecture.md) for how this local adapter
shares the session core with the Cloudflare path.

Puchero's local runner uses Pi's official `pi-coding-agent` SDK `ModelRuntime` and `SettingsManager`.
They load the existing agent directory (including `PI_CODING_AGENT_DIR`), provider configuration, saved login,
default model and its per-model or global thinking level. The SDK owns OAuth refresh, file locking and persistence; Puchero does not parse,
export, copy or reimplement tokens. Supported SDK providers can be selected in Pi as usual. No separate API key is required
when the selected provider supports the saved subscription login.

The CLI is a new Node entrypoint. Cloudflare workers cannot read this machine's Pi profile and remain unchanged.
`--check-connection` validates configuration and resolves login readiness without starting an issue or calling a model.
A missing default or failed login exits with a sanitized error before admitting work. It does not silently change models.
Workspace Pi settings are not trusted. Only model/provider/auth settings are reused; interactive Pi extensions, tools,
skills and prompts are not imported. Puchero retains its durable tools and issue/AGENTS.md task context.

The Linux runner uses util-linux `flock` to hold an OS lock on each state directory with Pi SQLite state and an immutable disk workspace store.
Reopening resumes committed tasks and publication receipts. Credentials are loaded on the host and never copied into
workspace snapshots or model prompts. Tool subprocesses get a small environment and a separate HOME, but local tools
still have the current user's filesystem permissions. This runner is for trusted local repositories; it is not the
isolated Cloudflare container adapter. No deployment or webhook is needed to run an explicitly selected issue.

The first Ctrl-C requests Stop and drains work. Stop is refused once publishing starts, since a PR may already exist;
the runner waits for that outcome. A second Ctrl-C exits immediately; reopening the same directory recovers durable state.
The kernel lock has no stale timeout: suspending the runner cannot allow another process to take over. The small
lock holder releases ownership on normal shutdown or when its parent dies (stdin closes). SDK credential locking
remains Pi-owned.

Acceptance:

- Use the SDK to load the saved provider/model/thinking and login without an API-key-only path or custom refresh.
- Propagate the saved thinking level into the durable agent's model request.
- Persist SQLite state and frozen workspace data across local runner processes, without duplicate publication.
- Fail checks without opening a PR; retain existing retry and reconciliation behavior.
- Require explicit checks and valid issue selection; fail login readiness before issue admission.
- Keep the cloud Worker entrypoint and its authentication unchanged.
