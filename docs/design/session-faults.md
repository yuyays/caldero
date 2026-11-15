# Session operational failures

Scope: distinguish known permanent session faults from temporary/unknown RPC outcomes. No new reducer state,
automatic mutation retry, deployment, or live GitHub App check.

## Interface

`SessionFault` is a shared typed HTTP 500 error with two stable codes: `identity_mismatch` and `state_unreadable`.
Unreadable may mean corrupt data or a schema/version mismatch; the message requires operator repair and does not
include stored JSON. It is not a missing session (404), an unavailable patch, or a reducer transition to `failed`.

Alchemy's declared RPC errors transport and revive this class (`SessionDO` declares `errors: [SessionFault]`).
The directory preserves it instead of collapsing it to `InboxUnavailable`. No parallel RPC envelope is added.

Other RPC causes remain HTTP 503. `InboxUnavailable.reason` optionally distinguishes `temporary`, `overloaded`,
and `unknown`. The classifier unwraps Alchemy's `RpcCallError` and reads only Cloudflare's documented flags:
`overloaded === true` takes precedence, then `retryable === true`. Neither error text nor `.remote` proves permanence.
The reason says nothing about whether a decision committed; a caller must inspect current state and retain its event
ID when deliberately retrying an unknown mutation outcome. No automatic application-level redispatch is added.

[Cloudflare's error-handling contract](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
also requires fresh stubs after exceptions and warns against retrying overloads. The directory resolves a fresh stub
per call. The inbox stops background detail polling on known permanent faults and overloads; mutation retries are
explicitly disabled. A permanent fault displays operator-repair guidance, not a Retry button.

## Ownership and recovery

The activation module owns a per-instance fault latch, identity validation, serialized opens, and a child scope for
each activation attempt. The modular DO constructor uses an explicitly retained instance scope, because
Alchemy's constructor layer scope closes when construction returns; failed construction closes the retained scope. Known identity/state faults gate every later open/start in that instance. It closes any
successful host scope on a later permanent fault and deletes the alarm. Failed temporary attempts close their own
scope but do not latch, clear the alarm, or prevent a later attempt. Resources of successful opens live with the DO.

Session state is decoded and its identity checked before initialization writes. Invalid persisted state is never
silently initialized over. Permanent startup faults are retained by the instance and returned from its declared RPC
methods; they do not escape only as generic constructor errors. Alarm writes and fault cleanup share a lock, so an
older queued wake cannot re-arm a faulted instance. If alarm deletion itself fails, it is reported and later calls
attempt cleanup again; no storage-availability guarantee is invented.

A repaired session needs a new DO instance to clear the latch (for example, after a corrective deployment/eviction).
There is no public reset/unlatch endpoint. Pi-internal open/version errors outside our explicitly validated state,
unknown defects, and transport errors without usable flags remain 503 `unknown`. They require observation and may
need operator intervention; they are not guessed permanent from their message.

## Acceptance criteria

- Malformed stored identity and mismatched issue identity fail permanently before host creation or identity writes;
  repeat starts cannot clear the fault.
- Malformed persisted reducer JSON yields `SessionFault` with no document/task writes; the original candidate is
  unchanged when the read fault is removed and a new host opens.
- Temporary activation failure closes its attempt resources; a later open succeeds and reuses the successful host.
- Declared faults survive Alchemy RPC serialization/revival and become typed 500 for webhook, detail and decisions.
- Retryable, overloaded and unknown RPC exceptions yield 503 with the correct diagnostic reason and one dispatch.
  The existing host crash-before-ack test continues to prove event-ID deduplication.
- The inbox explains permanent faults, disables decisions, removes Retry, and stops polling them. Existing healthy,
  stale approval and patch/audit degradation contracts continue to pass.
