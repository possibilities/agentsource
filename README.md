# agentsource

Agentsource is a read-only Signal Room TUI for the Git projects directly under
`~/code`. It shows only projects that have at least one of:

- working changes in any live checkout;
- commits on local branches that no locally known remote branch contains; or
- an additional linked worktree.

Each project reports aggregate working and unpushed statistics. Every linked
worktree reports its path, branch or detached HEAD, working-file count, and its
ahead/behind and merged/unmerged relationship to the project's primary branch.
The primary branch is `supervisor.trunk` when configured and `main` otherwise.

Agentsource never fetches and never writes to a repository. Remote state means
“as of the last fetch,” and untracked contents are not read merely to calculate
addition totals.

## Run

```console
bun install
bun run src/cli.ts
```

`ctrl+k` opens the command palette. It contains every action and binding;
`ctrl+c` always remains the terminal interrupt. When stdin and stdout are both
terminals, agentsource opens the TUI. Otherwise it prints a JSON observation so
agents and scripts can consume the result without an extra flag.

```console
bun run src/cli.ts | jq '.projects[] | {name, working, unpushed}'
bun run src/cli.ts --json
bun run src/cli.ts --snapshot  # explicit plain-text observation
bun run src/cli.ts --root /path/to/projects
scripts/install.sh --install
scripts/install.sh --uninstall
```

The JSON document has `schemaVersion: 1` and contains `scannedAt`, `root`,
`projects`, and `diagnostics`. `--json` forces this output in a terminal;
`--snapshot` forces the plain-text form in any environment.

The installer runs `bun install --frozen-lockfile`, atomically links
`~/.local/bin/agentsource` to this checkout's `src/cli.ts`, and records the
deployed commit under `~/.local/state/agentsource`. AgentStart owns invoking
this contract for the machine; rerun `../agentstart/scripts/install-agent-clis`
to converge the fleet CLI installation.

## Develop

```console
bun run check
```
