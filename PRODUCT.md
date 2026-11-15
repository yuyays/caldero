# Puchero

Puchero runs an autonomous coding agent from an issue labelled `agent` in one configured GitHub repository. It opens a pull request after validation in automatic mode; approval before publication is optional. Merging remains a separate decision.

The inbox is initially a personal desk for following agent work and reviewing candidates. It lists sessions needing attention first and shows the proposed diff, validation evidence, exact candidate version/base/digest, progress, and decisions. In approval-required mode, Approve publishes that exact candidate and Reject declines it. Automatic sessions publish after validation without a human approval event. Cancel stops an eligible session before publishing begins. Additional instructions can replace a candidate; its stored policy determines whether another review is required. The detail view shows the actual publication mode.

The session is authoritative. The inbox list is a delayed index and may temporarily disagree with the detail view. Reviewer identity comes from Cloudflare Access; explicit local development supports a token. No team management or deployment controls belong in this screen.
