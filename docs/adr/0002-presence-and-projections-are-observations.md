# 0002: Presence and projections are observations

Status: retrospective, recorded 2026-09-08 from the existing derived-state contract.

Agent and Pane presence are associated with known checkouts using Herdr's
workspace metadata and then the most-specific known current directory. Presence
does not establish authorship, worktree ownership or why an agent is there.
Unsupported or missing provenance stays unknown rather than being guessed.

CI state comes from the receiver's current projection of relevant Git heads.
The observation process reads that projection through the Unix socket instead
of querying GitHub itself. Projection channels can provide an initial current
value; delivery channels are transient and have no replay. Missing observation
is distinct from an empty roster or a successful CI result.

This keeps one owner for each derived state and avoids treating a screen badge
as a durable event ledger. Disconnected or slow readers can miss events and
must reconstruct current state; they cannot infer completion from absence.

Evidence: [glossary](../../CONTEXT.md), [observation and channel contract](../../README.md),
[webhook receiver](../../src/webhooks.ts), and [CI projection](../../src/github-ci.ts).
