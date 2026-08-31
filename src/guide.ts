// The fleet agent contract: agentsource's single machine-readable
// self-description, emitted by `agentsource guide --json`.
//
// This is the one authoring site. `usage()` in cli.ts and the setup usage in
// github-webhooks.ts render FROM this document instead of carrying their own
// prose — see config/agent-contract/README.md in agentstart for why that
// used to drift.
//
// agentsource is an operator CLI: a webhook receiver and git-scanning
// service driven by humans and installers, not agents. It owes only `meta`
// and `commands` — no `guidance` or `concepts`, and no command may declare
// `audience: agent`.

export interface GuideArgument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: readonly string[];
  default?: unknown;
  aliases?: readonly string[];
}

export interface GuideConstraint {
  kind: "one_of" | "conflicts" | "requires";
  arguments: readonly string[];
  required?: boolean;
  description?: string;
}

export interface GuideCommand {
  name: string;
  summary: string;
  audience: "operator" | "internal";
  mutates?: boolean;
  guidance?: string;
  arguments?: readonly GuideArgument[];
  subcommands?: readonly GuideCommand[];
  stdin?: { accepts: "text" | "json"; required?: boolean; description: string };
  constraints?: readonly GuideConstraint[];
}

export interface AgentContract {
  contract_version: 1;
  meta: {
    name: string;
    version: string;
    purpose: string;
    audience: "operator";
  };
  commands: readonly GuideCommand[];
}

const VERSION = "0.1.0";

export const CONTRACT: AgentContract = {
  contract_version: 1,
  meta: {
    name: "agentsource",
    version: VERSION,
    purpose:
      "Signal Room TUI and webhook service for local Git work across ~/code: working changes, unpushed work, linked worktrees, CI attention, and Herdr sessions.",
    audience: "operator",
  },
  commands: [
    {
      name: "scan",
      summary:
        "Show ~/code projects with working changes, unpushed work, worktrees, CI attention, or Herdr sessions (the default, bare invocation)",
      audience: "operator",
      mutates: false,
      guidance:
        "Invoked with no subcommand keyword: `agentsource [--json | --snapshot] [--root PATH]`. Opens the interactive TUI when stdin and stdout are both a terminal; otherwise prints one JSON observation as if --json were given.",
      arguments: [
        {
          name: "--json",
          type: "boolean",
          description: "Print one JSON observation and exit, instead of opening the TUI.",
        },
        {
          name: "--snapshot",
          type: "boolean",
          description: "Print one plain-text observation and exit, instead of opening the TUI.",
        },
        {
          name: "--root",
          type: "string",
          description: "Scan direct projects below PATH instead of ~/code.",
          format: "path",
          direction: "in",
        },
      ],
      constraints: [
        {
          kind: "conflicts",
          arguments: ["--json", "--snapshot"],
          description: "Only one output mode can be selected per call.",
        },
      ],
    },
    {
      name: "webhook-daemon",
      summary: "Run the GitHub webhook receiver and serve CI channels over a Unix socket",
      audience: "operator",
      mutates: true,
      guidance:
        "Long-running foreground process; runs until SIGINT or SIGTERM. Accepts GitHub webhooks over loopback HTTP (meant to sit behind Tailscale Funnel) and republishes CI observations to subscribers of its Unix socket.",
      arguments: [
        {
          name: "--secret-file",
          type: "string",
          description: "Private file holding the GitHub webhook secret.",
          format: "path",
          direction: "in",
          required: true,
        },
        {
          name: "--port",
          type: "integer",
          description: "Loopback HTTP port for Tailscale Funnel.",
          default: 8787,
        },
        {
          name: "--socket",
          type: "string",
          description: "Unix delivery stream socket the daemon creates and serves on.",
          format: "path",
          direction: "out",
        },
        {
          name: "--root",
          type: "string",
          description: "Register direct GitHub projects below PATH instead of ~/code.",
          format: "path",
          direction: "in",
        },
      ],
    },
    {
      name: "webhook-configure",
      summary: "Discover GitHub projects under ~/code and reconcile their repository webhooks",
      audience: "operator",
      mutates: true,
      guidance:
        "Without --apply, only reports the changes it would make. --apply performs them against the GitHub API via `gh`.",
      arguments: [
        {
          name: "--url",
          type: "string",
          description: "HTTPS origin the webhook should deliver to.",
          format: "url",
          required: true,
        },
        {
          name: "--secret-file",
          type: "string",
          description: "Private file holding the webhook secret to configure.",
          format: "path",
          direction: "in",
          required: true,
        },
        {
          name: "--previous-url",
          type: "string",
          description:
            "A prior HTTPS origin to also match, so a moved receiver is updated in place rather than duplicated.",
          format: "url",
        },
        {
          name: "--root",
          type: "string",
          description: "Discover direct GitHub projects below PATH instead of ~/code.",
          format: "path",
          direction: "in",
        },
        {
          name: "--apply",
          type: "boolean",
          description:
            "Actually create or update webhooks, instead of reporting what would change.",
        },
      ],
    },
    {
      name: "guide",
      summary: "Print this machine-readable contract",
      audience: "operator",
      mutates: false,
      arguments: [
        {
          name: "--json",
          type: "boolean",
          description: "Print the contract as the fixed envelope (the only supported form).",
        },
      ],
    },
  ],
};

function findCommand(name: string): GuideCommand {
  const command = CONTRACT.commands.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`agent contract: no command named "${name}"`);
  return command;
}

function renderArgument(argument: GuideArgument): string {
  const flag = argument.positional
    ? argument.name.toUpperCase()
    : argument.choices
      ? `${argument.name} ${argument.choices.join("|")}`
      : argument.type === "boolean"
        ? argument.name
        : `${argument.name} ${argument.format ? argument.format.toUpperCase() : "VALUE"}`;
  return `  ${flag.padEnd(28)}${argument.description}`;
}

/** Render `--help` for the whole CLI from the contract. */
export function renderHelp(): string {
  const scan = findCommand("scan");
  const daemon = findCommand("webhook-daemon");
  const configure = findCommand("webhook-configure");
  const lines: string[] = [];
  lines.push(
    `Usage: agentsource [--json | --snapshot] [--root PATH]`,
    `       agentsource webhook-daemon --secret-file PATH [--port PORT] [--socket PATH] [--root PATH]`,
    `       agentsource webhook-configure --url HTTPS_ORIGIN --secret-file PATH [--root PATH] [--apply]`,
    "",
    CONTRACT.meta.purpose,
    "",
    scan.guidance ?? "",
    "",
    "Options:",
  );
  for (const argument of scan.arguments ?? []) lines.push(renderArgument(argument));
  lines.push("  --help                      show this help", "", "Webhook daemon options:");
  for (const argument of daemon.arguments ?? []) lines.push(renderArgument(argument));
  lines.push("", "Webhook configure options:");
  for (const argument of configure.arguments ?? []) lines.push(renderArgument(argument));
  lines.push("", "Run `agentsource guide --json` for the full machine-readable contract.", "");
  return lines.join("\n");
}

/** Render `webhook-configure --help` from the contract. */
export function renderWebhookConfigureHelp(): string {
  const configure = findCommand("webhook-configure");
  const lines: string[] = [
    "Usage: agentsource webhook-configure --url HTTPS_ORIGIN --secret-file PATH [--previous-url HTTPS_ORIGIN] [--root PATH] [--apply]",
    "",
    `${configure.summary}.`,
    configure.guidance ?? "",
    "",
  ];
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .concat("\n");
}

export function renderGuideJson(): string {
  const envelope = {
    schema_version: 1,
    ok: true,
    error: null,
    data: CONTRACT,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
