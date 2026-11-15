# Puchero

Puchero runs an autonomous coding agent from an issue labelled `agent` in one configured GitHub repository. It opens a pull request automatically after the configured workspace checks pass. Merging remains a separate decision.

The inbox is initially a personal desk for following agent work. It lists sessions needing attention first and shows the proposed diff, validation evidence, exact candidate version/base/digest, progress, and pull request. Stop cancels an eligible session before publishing begins. Additional instructions can steer work or start a fresh candidate; every candidate must pass validation before publication. Review and merging happen on GitHub.

The session is authoritative. The inbox list is a delayed index and may temporarily disagree with the detail view. Reviewer identity comes from Cloudflare Access; explicit local development supports a token. No team management or deployment controls belong in this screen.
