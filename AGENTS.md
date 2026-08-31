# Agent guidance

Agentsource is a read-only observer. Git commands may inspect repositories but
must never fetch, stage, stash, switch, clean, reset, merge, push, or otherwise
change the projects it reports.

The live TUI follows the canonical Signal Room pages in the operator wiki. Keep
the shell chromeless, preserve `ctrl+c` as the terminal interrupt, and keep all
advertised actions in the `ctrl+k` command palette.

Run `bun run check` before committing. Exercise the real TUI with Terminal
Control at 40, 80, and 120 columns and at one shallow height.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
