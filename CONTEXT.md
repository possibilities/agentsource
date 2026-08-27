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
