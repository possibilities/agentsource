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
`ctrl+c` always remains the terminal interrupt. The live TUI refreshes its
observation roughly every five seconds, while `refresh projects` starts an
immediate scan. When stdin and stdout are both terminals, agentsource opens the
TUI. Otherwise it prints a JSON observation so agents and scripts can consume
the result without an extra flag.

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

## GitHub webhook wiring

Agentsource can run a foreground webhook daemon for a process supervisor. Its
HTTP listener is fixed to `127.0.0.1`; expose that listener to GitHub through
Tailscale Funnel. Each correctly signed request to `/<owner>/<repo>` becomes
one newline-delimited JSON webhook delivery on a private Unix socket.

Create one secret and keep it stable across the daemon and GitHub webhook
configuration. The daemon refuses symlinked, non-regular, foreign-owned, or
group/world-accessible secret files.

```console
install -d -m 700 ~/.config/agentsource
(umask 077; set -C; openssl rand -hex 32 > ~/.config/agentsource/github-webhook-secret)
chmod 600 ~/.config/agentsource/github-webhook-secret

agentsource webhook-daemon \
  --secret-file ~/.config/agentsource/github-webhook-secret
```

The secret-generation command refuses to overwrite an existing secret. Keep
that file: replacing it requires promptly applying the new value to every
GitHub webhook.

In another terminal, publish the default loopback port through Funnel. This is
the only supported network ingress; Funnel is public internet exposure, while
the GitHub HMAC signature is the authentication boundary.

```console
tailscale funnel --bg 8787
tailscale funnel status
```

Preview webhook reconciliation for every GitHub project directly under
`~/code`, then apply the same plan. Replace the example with the `.ts.net`
origin reported by Tailscale.

```console
scripts/configure-github-webhooks.ts \
  --url https://machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret

scripts/configure-github-webhooks.ts \
  --url https://machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret \
  --apply
```

When the Funnel hostname changes, pass the old origin explicitly so the helper
updates the existing hook instead of creating another one:

```console
scripts/configure-github-webhooks.ts \
  --url https://new-machine.tailnet.ts.net \
  --previous-url https://old-machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret \
  --apply
```

The helper reads only local Git metadata, deduplicates multiple checkouts of
the same GitHub project, reports non-GitHub origins, and uses `gh api` to
create or update one active wildcard webhook at the project-specific URL. It
never puts the secret in command-line arguments.

A cheap local client can watch the stream directly:

```console
nc -U ~/.local/state/agentsource/webhooks.sock | jq --unbuffered -c .
```

The delivery record has `schemaVersion: 1`, `receivedAt`, `owner`, `repo`,
`event`, `deliveryId`, `hookId`, and the parsed GitHub `payload`. The stream is
live and best-effort: disconnected or slow clients can miss deliveries, and
there is no persistence or replay in this slice.

Secret rotation is not atomic in this slice. Do not replace the shared secret
while deliveries must remain uninterrupted; overlapping-secret rotation is a
follow-up capability.

The installer runs `bun install --frozen-lockfile`, atomically links
`~/.local/bin/agentsource` to this checkout's `src/cli.ts`, and records the
deployed commit under `~/.local/state/agentsource`. AgentStart owns invoking
this contract for the machine; rerun `../agentstart/scripts/install-agent-clis`
to converge the fleet CLI installation.

## Develop

```console
bun run check
```
