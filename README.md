# agentsource

Agentsource is a read-only Signal Room TUI for the Git projects directly under
`~/code`. It shows only projects that have at least one of:

- working changes in any live checkout;
- commits on local branches that no locally known remote branch contains; or
- an additional linked worktree; or
- a supported Herdr agent associated with its primary checkout or a linked
  worktree; or
- pending or failing CI on its primary branch or a linked worktree.

Working statistics belong only to the checkout that contains them: the primary
checkout has its own statistics, and every linked worktree reports its own
statistics alongside its path, branch or detached HEAD, and ahead/behind and
merged/unmerged relationship to the project's primary branch. The
observation-wide total is derived from those checkout-local records rather than
stored again on each project. The primary branch is `supervisor.trunk` when
configured and `main` otherwise.

Agentsource takes one `herdr api snapshot` and one `herdr workspace list`
snapshot per scan. It associates every recognized agent and every otherwise
unoccupied open pane through its workspace's recorded checkout when available,
then falls back to the most-specific known checkout containing its current
directory. Only supported agents contribute live TUI presence, project
visibility, and Herdr session totals. Plain panes remain machine-readable in
JSON without masquerading as agents or drawing attention in the TUI. A pane
that starts elsewhere and later creates a worktree cannot be attributed without
Herdr recording that provenance, so Agentsource does not guess.

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

The JSON document has `schemaVersion: 3` and contains `scannedAt`, `root`,
`projects`, `agentPresence`, `ci`, and `diagnostics`. Each project and linked
worktree has `agents` and `panes` arrays. Normalized agent entries include harness and status,
conversation and session identity when available, Herdr pane/tab/workspace
identifiers, and focus state. Pane entries retain pane/tab/workspace identity,
title, and focus state after an agent exits. `agentPresence.available`
distinguishes an empty snapshot from an unavailable Herdr surface, while its
diagnostics record degraded workspace metadata. `--json` forces this output in a terminal;
`--snapshot` forces the plain-text form in any environment.

Every visible primary branch and linked-worktree branch also has a normalized
CI summary: `PASS`, `PENDING`, `FAIL`, `NONE`, `LOCAL`, or `UNKNOWN`. The
top-level `ci.projections` array retains the complete daemon projections used
to derive those summaries. One-shot observations obtain them through the Unix
socket snapshot RPC; agentsource never queries GitHub from the observation
process. If the daemon is unavailable, Git and Herdr observation still
succeeds with CI availability diagnostics.

## GitHub webhook wiring

Agentsource can run a foreground webhook daemon for a process supervisor. Its
HTTP listener is fixed to `127.0.0.1`; expose that listener to GitHub through
Tailscale Funnel. Each correctly signed request to `/<owner>/<repo>` becomes
one webhook delivery available through a private Unix socket. Socket clients
must subscribe before the daemon sends them anything.

The installer creates one private secret when it is absent and preserves it on
every later run. Keep it stable across the daemon and GitHub webhook
configuration. The daemon refuses symlinked, non-regular, foreign-owned, or
group/world-accessible secret files.

```console
scripts/install.sh --install

agentsource webhook-daemon \
  --secret-file ~/.config/agentsource/github-webhook-secret
```

The daemon discovers registered GitHub projects directly below `~/code` at
startup, but does not query GitHub until a client first requests a missing CI
projection. A cached projection is authoritative regardless of age; later
snapshot requests return it without another GitHub call. Relevant webhooks
refresh the affected projection. Pass `--root PATH` to choose a different
project root. CI query failures are reported in projection diagnostics and do
not stop webhook delivery.

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
agentsource webhook-configure \
  --url https://machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret

agentsource webhook-configure \
  --url https://machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret \
  --apply
```

When the Funnel hostname changes, pass the old origin explicitly so the helper
updates the existing hook instead of creating another one:

```console
agentsource webhook-configure \
  --url https://new-machine.tailnet.ts.net \
  --previous-url https://old-machine.tailnet.ts.net \
  --secret-file ~/.config/agentsource/github-webhook-secret \
  --apply
```

The helper reads only local Git metadata, deduplicates multiple checkouts of
the same GitHub project, reports non-GitHub origins, and uses `gh api` to
create or update one active wildcard webhook at the project-specific URL. It
never puts the secret in command-line arguments.

Dry-run `unchanged` means the properties GitHub exposes still agree: URL,
active state, wildcard events, JSON content, and TLS verification. GitHub masks
the stored secret, so remote HMAC agreement is proven only by an accepted
delivery; it cannot be inferred from hook inspection alone.

Reconciliation is deliberately scoped to GitHub projects currently found
under the selected root. Removing a local project does not delete its remote
hook; stale-hook inventory and explicit removal belong to a later slice.

A client sends exactly one newline-delimited subscription. `deliveries` is the
live webhook delivery channel. Each `ci:<owner>:<repo>` channel is the complete
current check/status projection for that project's relevant Git heads,
including its configured primary branch and live local worktree HEADs;
the terminal-star prefix `ci:*` selects every registered CI projection.

```json
{"schemaVersion":1,"subscribe":["deliveries","ci:*"]}
```

Every emitted NDJSON envelope has `schemaVersion`, `channel`, `emittedAt`, and
`data`. A CI subscription immediately receives one complete envelope per
matching registered project; later relevant webhooks refresh and emit only the
affected project's projection. The `deliveries` channel has no replay.
Prefixes may select the whole namespace (`ci:*`) or one owner's namespace
(`ci:possibilities:*`); `*` selects every channel.

For one-shot consumers, send a snapshot request instead of a subscription. The
daemon hydrates only matching missing projections, returns their current
envelopes in one response, and closes the connection:

```json
{"schemaVersion":1,"requestId":"observation-1","method":"snapshot","channels":["ci:*"]}
```

Use the included client to try exact channels, prefixes, or both:

```console
scripts/watch-webhook-channels.ts 'ci:*'
scripts/watch-webhook-channels.ts --snapshot 'ci:*'
scripts/watch-webhook-channels.ts deliveries 'ci:*' | jq --unbuffered -c .
```

The socket and its parent directory are owner-only. There is no additional
application token: local Unix identity is the socket authentication boundary.
All channels are live and best-effort, so disconnected or slow clients can
miss updates.

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
