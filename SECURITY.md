# Security policy

Caldero runs model-generated code against real repositories and holds a GitHub App
private key, so security reports are taken seriously. This project is alpha: it has
not had an independent security audit, and the deployed Cloudflare path is unverified.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting, not a public issue, pull request or
discussion:

<https://github.com/yuyays/caldero/security/advisories/new>

Also, the Security tab → **Report a vulnerability**.

Please include the path you were on (local runner or Cloudflare), the commit you
tested, which trust boundary below is crossed, and a minimal reproduction. Redact
credentials — never send a live key, token or webhook secret.

## What to expect

One maintainer, best effort. Acknowledgment target is seven days; there is no
guaranteed fix or response timeline. We will say whether we consider the report in
scope, fix it on `main`, and coordinate disclosure — 90 days by default, sooner if a
fix ships. Credit on request.

## How the current design limits damage

Please check these before reporting; some apparent issues are deliberate boundaries.

- **The model cannot declare success.** Publication starts only from the workspace's
  validation outcome. Caldero never merges.
- **App credentials stay on the host.** Workspaces, checkpoints and snapshots are
  secret-free. Installation tokens are minted per operation with repository-scoped
  Contents, Pull requests and Issues write permission.
- **Branch writes are constrained.** Initial publication creates a new ref. Explicit
  local repair can append one validated commit to a saved open PR authored by the
  configured App, with a head branch in the same repository. GitHub checks the
  expected head as part of the append. Refs are never force-updated. An ambiguous
  result is reconciled against the journal.
- **CI logs are model input.** Local repair passes a bounded log excerpt to Pi as
  untrusted data. The local runner has the operator's filesystem and network access.
  Use it only for repositories whose CI output you trust with that access.
- **Inbox authorization is Access-only.** Requests require a verified Access JWT:
  signature, issuer, audience, expiry and not-before. The JWKS is derived from the
  configured issuer, so token-supplied `jku`/`x5u` are never used. The email header
  and request-body actor are never trusted. `CALDERO_DEV_TOKEN` is accepted only in
  explicit dev mode with no Access configuration; production configuration fails
  closed.
- **Webhook admission verifies before parsing.** HMAC-SHA256 over the original
  request bytes, compared timing-safe, then only `labeled` / `agent` events for the
  configured repository and installation are admitted.
- **Projections are summaries.** D1 holds bounded session summaries and revision
  activity, never file contents or validation output.

## Local runner is not a sandbox

This is the most important thing to understand before running it. On the local path,
tools execute with your user's filesystem permissions. The runner gives child
processes a minimal environment (`PATH` plus a separate `HOME`) and keeps Pi login
files and the App key out of snapshots and prompts — but a non-sandboxed process can
still read anything your account can reach. Run it only against repositories you
trust, on a machine you control.

`alchemy dev` containers are privileged (`SYS_ADMIN`, `/dev/fuse`, unconfined
AppArmor). They are a local development convenience, not a security boundary. The
Cloudflare path starts its container with internet disabled
(`enableInternet: false`) and expects validation dependencies to be baked into the
image.

## In scope

- Webhook signature bypass, or admission of an event that should be rejected.
- Inbox authorization bypass, including a dev-token path reachable in production
  mode, or a cross-origin decision.
- Credentials or App material reaching a workspace, checkpoint, snapshot, model
  prompt, projection or log.
- A publication path that opens a PR without passing validation, overwrites an
  existing branch, or force-updates a ref.
- Sandbox escape on the Cloudflare path.
- Path traversal, symlink or submodule handling in repository fetches and tree walks.
- Injection into GitHub API calls, or SSRF from the agent host.

## Out of scope

- The model writing insecure or incorrect code. Reviewing the pull request is the
  control; no merge happens automatically.
- Prompt injection on its own. Issue text and repository files are untrusted input by
  design. Report it when it crosses one of the boundaries above.
- Deliberately pointing the local runner at a repository or machine you do not trust.
- The quality of the checks you configure. Validation is only as good as those.
- Secrets you place in your own environment, config or repository.
- Cost or resource exhaustion from an unusually large repository, unless the trigger
  is trivial.
- Anything that requires an already-compromised host or account.

## Supported versions

Only `main`, at its latest commit. Alpha: no backports and no patch releases.

## Known gaps

Documented limitations, not vulnerabilities:

- The deployed Cloudflare path is unverified; local development is the exercised path.
- No global run-slot limiter or scheduler, so concurrency is unbounded across issues.
- No automatic CI or review repair, and no auto-merge.
- Withholding secrets from a workspace does not prevent network exfiltration when
  that workspace has network access. The cloud path closes this by disabling
  internet; the local path does not.
- The inbox list returns up to 100 sessions and detail up to 200 activity rows, with
  no pagination or rate limiting.

Architecture, trust boundaries and the execution paths are described in
[docs/architecture.md](docs/architecture.md).
