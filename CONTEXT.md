# Context

**Project**
A direct child of `~/code` that Git recognizes as a worktree root. Projects
sharing a Git common directory are one project.
_Avoid_: repository folder, workspace

**Primary branch**
The local integration branch named by `supervisor.trunk`, falling back to
`main`. It is the reference used to classify linked worktree commits.
_Avoid_: default branch, current branch

**Primary checkout**
The checkout whose `.git` directory is the repository's Git common directory.
It remains the primary checkout regardless of which branch it currently holds.
_Avoid_: main worktree, trunk worktree

**Linked worktree**
Any live checkout registered in the Git common directory other than the
primary checkout. A project “has a worktree” when it has at least one of these.
_Avoid_: secondary repo, workspace

**Working changes**
Staged, unstaged, conflicted, or untracked files in any live checkout of a
project. Addition and deletion totals cover tracked diffs; untracked files are
counted separately without reading their contents.
_Avoid_: dirty files, file changes

**Unpushed work**
Unique commits on local branches that are not reachable from any locally known
remote branch, plus the cumulative file statistics introduced by those
commits. The observation never fetches.
_Avoid_: ahead of upstream, unpushed files

**Observation**
A point-in-time, read-only scan of projects, including its root, timestamp,
projects needing attention, and diagnostics. Non-interactive callers receive
the schema-versioned JSON form.
_Avoid_: status report, inventory

**Agent presence**
A Herdr-reported agent deterministically associated with a primary checkout or
linked worktree by workspace checkout metadata or by its current directory.
_Avoid_: agent ownership, inferred worktree author

**Pane presence**
An open Herdr pane without a currently recognized agent, deterministically
associated by the same checkout rules as agent presence. It remains available
in the machine-readable observation until the pane closes, but never contributes
TUI visibility or Herdr session totals and never masquerades as an agent.
_Avoid_: stopped agent, shell agent

**Webhook delivery**
One GitHub webhook request whose signature and project path agentsource has
validated. Each delivery becomes one schema-versioned value on the delivery
channel.
_Avoid_: notification, callback

**Channel**
A named live feed on the agentsource Unix socket. Every emitted envelope names
its channel; channels are best-effort and have no persistence or replay beyond
the initial projection supplied by projection channels.
_Avoid_: event queue, message bus

**Subscription**
The single schema-versioned request a socket client sends to select exact
channels or terminal-star prefixes. A subscription to a projection prefix
receives one current value for each matching projection before live updates.
_Avoid_: filter, consumer group

**Delivery channel**
The `deliveries` channel carrying every validated webhook delivery after a
client subscribes. It has no initial value or replay.
_Avoid_: raw channel, firehose

**CI projection**
The daemon-owned current GitHub check and commit-status state for one
registered project's relevant Git heads, keyed by commit SHA and annotated
with branch and checkout associations. Its channel is `ci:<owner>:<repo>`;
`ci:*` selects every registered CI projection.
_Avoid_: Actions channel, workflow history

**CI state**
The branch-facing normalization of a projected Git head: `PASS`, `PENDING`,
`FAIL`, `NONE`, `LOCAL`, or `UNKNOWN`. `PENDING` and `FAIL` require attention;
all states remain visible when their branch or checkout is visible.
_Avoid_: workflow result, build badge

**Projection snapshot**
A bounded request for the daemon's current values matching exact channels or
terminal-star prefixes. Cached projections are fresh by definition; the
daemon constructs only requested registered projections absent from its cache.
_Avoid_: replay, forced refresh

**Registered project**
A GitHub project discovered as a direct child of the webhook daemon's chosen
root when it starts. Registration is observational and does not alter either
the local project or its GitHub repository.
_Avoid_: configured hook, watched repository

**GitHub repository visibility**
The GitHub-reported access classification for a registered project's remote
repository: `PRIVATE`, `PUBLIC`, or `INTERNAL`. It is unknown when no current
GitHub projection is available and never inferred from a remote URL.
_Avoid_: project privacy, local visibility
