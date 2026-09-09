# 0001: Observe Git without mutating projects

Status: retrospective, recorded 2026-09-08 from the existing observation contract.

An Observation inspects repository state without fetching or modifying any
project. Locally known remote refs describe the last fetched state, not a claim
about the current remote. Untracked files are counted without reading their
contents merely to calculate addition totals.

The observer can consequently run beside unfinished work without changing refs,
worktrees, the index or private working files. It gives up implicit remote
freshness and complete line totals for untracked content. Those limits belong
in the domain language and result, rather than being hidden behind automatic
fetches or an inference about what should be pushed.

This is the project-observation boundary. The webhook receiver's own state and
explicit hook administration are separate contracts; neither authorizes an
observation to mutate the repositories it reports.

Evidence: [repository rules](../../AGENTS.md), [glossary](../../CONTEXT.md),
[operator contract](../../README.md), and [Git reader](../../src/git.ts).
