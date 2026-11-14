2026-11-14
Assessment, not an approved plan.

# Open SWE compared with puchero

## 1. Architecture and evidence

The [March announcement](https://www.langchain.com/blog/open-swe-an-open-source-framework-for-internal-coding-agents) describes Deep Agents on LangGraph, isolated per-thread sandboxes, Slack/Linear/GitHub triggers, deterministic conversation IDs, repository instructions, queued steering, and automatic PR completion. The repository has since become **Robin**. This assessment pins inspected code to `444ab3bf577d6b9c61f8becb4145cae411b202f1`; announcement behavior is not necessarily current behavior. The [current README][readme] confirms this runtime shift; the customization guide’s trigger section still describes older backend webhook routing, so code takes precedence here.

Current deployment combines a FastAPI integration/dashboard backend with LangGraph infrastructure and a separate Managed Deep Agents runtime. PostgreSQL stores application records and thread indexes; standalone Agent Server also requires Redis. The model loop, checkpoints, and tool execution live in MDA, while the backend supplies run-specific tools, models, credentials, and policies ([installation guide][install], [`mda/agent.py`][agent], [`openswe/threads/store.py`][store]).

GitHub deliveries enter MDA's channel, which forwards them to a backend event log before answering GitHub. Backend work subsequently runs through background tasks and delivery claims: this establishes logged admission, not proof of crash-safe completion. Issue mentions and PR comments route to conversation threads; newer PR comments can interrupt existing work ([`mda/channels/github.py`][trigger], [`openswe/github/channel.py`][channel], [`mda/rt/github.py`][follow]).

Coding threads reuse Linux sandboxes. Unlike the announcement's automatic recreation description, current code refuses silent replacement of an unreachable workspace because uncommitted work could disappear. MDA owns sandbox recovery ([`openswe/sandboxes/lifecycle.py`][sandbox]). Multi-user identity and private threads exist, but deployment explicitly assumes shared repository trust: sandbox App access normally spans the installation, regardless of the initiating user's personal permissions ([installation trust model][install]).

## 2. Layer comparison

Puchero entries describe the supplied proposal, not verified implementation.

| Layer           | Open SWE / current Robin                                                    | Puchero                                                                                             |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hosting         | Python backend, LangGraph/MDA; PostgreSQL/Redis [1]                         | Effect v4 TypeScript; Cloudflare/Alchemy v2; `alchemy dev` with workerd/Docker; no PostgreSQL       |
| Intake          | Slack, Linear, GitHub channels; logged deliveries [2]                       | Worker signature verification, delivery dedupe, durable admission; inbox API/React SPA; Slack later |
| Thread/run      | Runtime checkpoints; PostgreSQL thread index [3]                            | SessionDO SQLite state machine; persisted alarm wakeups; serialized steering/follow-ups             |
| Harness         | Deep Agents plus deterministic loop middleware [4]                          | Pi Durable in DO; ExecutionEnv delegates tools to Container                                         |
| Workspace       | Persistent thread sandbox; explicit recovery boundary [5]                   | One secret-free Container/session; R2 checkpoint after mutations; restore notification              |
| Publication     | Backend PR tool; requester OAuth or system App token [6]                    | Digest-bound approval; App-token publication; reconciliation; DO outbox/D1 projections              |
| Verification    | Tooling and CI/review follow-ups [7]                                        | Sandbox typecheck/tests; CI creates runs; Alchemy PR previews later                                 |
| Identity/policy | Registered users, shared-trust deployment; scoped personal integrations [8] | CredentialDO per-owner model access; later D1 identities, SchedulerDO, policy and visibility        |

Sources: [1][install]; [2][channel]; [3][store]; [4][loop]; [5][sandbox]; [6][pr]; [7][github]; [8][custom].

## 3. Adopt concretely

- **Hydrate context before execution:** ticket history, repository instructions, base SHA, and trigger provenance. Preserve conversation identity across surfaces; avoid parallel sessions accidentally fixing the same PR. This follows the [announcement's context/thread approach](https://www.langchain.com/blog/open-swe-an-open-source-framework-for-internal-coding-agents).
- **Keep required steps deterministic:** validation evidence, approval checks, publication, and status updates belong around the model loop. Borrow the separation in [`mda/rt/loop.py`][loop], not its entire orchestration stack.
- **Make publication failures actionable:** record repository, branch, credential actor, failed stage, and GitHub response. Robin preflights access and branches, and finds existing PRs after a 422; puchero should reconcile ambiguous transport failures too ([`openswe/tools/open_pull_request.py`][pr]).

## 4. Deliberate differences

**DO ownership without a workflow engine looks justified for milestone 1**, provided recovery is demonstrable. It avoids duplicating SessionDO authority. As secondary context, [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) also uses per-session SQLite Durable Objects, although that does not validate Pi Durable integration.

**Secret-free sandboxes and approval-bound App publication are justified.** They establish a narrower write boundary than Robin's documented shared-trust environment. Repository checkout still needs an authorized broker; withholding secrets alone does not prevent network exfiltration.

**Per-mutation R2 persistence is justified but expensive and incomplete alone.** Robin's refusal to replace unreachable workspaces confirms the loss problem; it does not prove puchero's checkpoint protocol solves it.

**CI as new runs and deferred previews look reasonable.** Preserve causal links and validation SHA. [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) provides secondary support for deterministic validation and CI feedback, not evidence for puchero's runtime choices.

## 5. Exposed gaps and risks

1. **Crash consistency:** mutation can succeed before R2 upload. Journal tool intent/result and checkpoint generations; reconcile before retrying. Include binary/untracked files, modes, deletions, and committed changes. Robin's [recovery-patch script][patch] handles binary/untracked content, but is not an every-tool durability protocol.
2. **Approval lifecycle:** define new-run transitions after `published`, approval invalidation on steering/base movement, cancellation during publishing, and alarm/outbox retry ownership. Publish only the validated digest.
3. **Authority and disclosure:** establish who may steer, approve, spend another owner's model budget, or receive results before adding Slack. Session audiences must constrain summaries, logs, and projections as well as tool output.
4. **Unverified:** Pi Durable's DO SQLite/alarm recovery, ExecutionEnv behavior, DO model-call limits, and ChatGPT token eligibility/refresh were not established by these sources. Neither was end-to-end exactly-once recovery in Robin. Require targeted compatibility/crash experiments before implementation approval. No independent reviewer was used, as this research brief forbids delegation.

[install]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/docs/INSTALLATION.md
[agent]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/mda/agent.py
[store]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/threads/store.py
[trigger]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/mda/channels/github.py
[channel]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/github/channel.py
[follow]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/mda/rt/github.py
[sandbox]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/sandboxes/lifecycle.py
[loop]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/mda/rt/loop.py
[pr]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/tools/open_pull_request.py
[github]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/github/webhook.py
[custom]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/docs/CUSTOMIZATION.md
[patch]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/openswe/sandbox_scripts/recovery_patch.py
[readme]: https://github.com/langchain-ai/open-swe/blob/444ab3bf577d6b9c61f8becb4145cae411b202f1/README.md
