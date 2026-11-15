# Puchero

Puchero runs an autonomous coding agent from an issue labelled `agent` in one configured GitHub repository. A person reviews the validated candidate before it opens a pull request.

The inbox is initially a personal review desk. It lists sessions needing attention first and shows the proposed diff, validation evidence, exact candidate version/base/digest, progress, and decisions. Approve publishes that candidate; reject declines it; cancel stops an eligible session. Additional instructions can replace a candidate and require another review.

The session is authoritative. The inbox list is a delayed index and may temporarily disagree with the detail view. Reviewer identity comes from Cloudflare Access; explicit local development supports a token. No team management or deployment controls belong in this screen.
