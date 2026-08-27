#!/usr/bin/env bun

import { resolve } from "node:path";
import { scanProjects } from "./git.ts";
import { renderJson, renderSnapshot } from "./render.ts";
import { runTui } from "./tui/app.ts";

interface Invocation {
  mode: "tui" | "snapshot" | "json" | "help";
  root?: string;
}

function usage(): string {
  return `Usage: agentsource [--json | --snapshot] [--root PATH]

Show ~/code projects with working changes, unpushed work, or linked worktrees.

Opens the TUI in a terminal; otherwise prints one JSON observation.

Options:
  --json        print one JSON observation and exit
  --snapshot    print one plain observation and exit
  --root PATH   scan direct projects below PATH instead of ~/code
  --help        show this help
`;
}

export function parseArgs(args: readonly string[]): Invocation {
  let mode: Invocation["mode"] = "tui";
  let help = false;
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--snapshot") {
      if (mode === "json") throw new Error("--json and --snapshot cannot be used together");
      mode = "snapshot";
    } else if (arg === "--json") {
      if (mode === "snapshot") throw new Error("--json and --snapshot cannot be used together");
      mode = "json";
    } else if (arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root needs a path");
      root = resolve(value);
      index += 1;
    } else if (arg?.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else throw new Error(`unknown option: ${arg}`);
  }
  return { mode: help ? "help" : mode, ...(root ? { root } : {}) };
}

export function resolveMode(
  requested: Invocation["mode"],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): Invocation["mode"] {
  if (requested !== "tui") return requested;
  return stdinIsTTY && stdoutIsTTY ? "tui" : "json";
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `agentsource: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(usage());
    return 2;
  }
  const mode = resolveMode(
    invocation.mode,
    process.stdin.isTTY === true,
    process.stdout.isTTY === true,
  );
  if (mode === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (mode === "snapshot" || mode === "json") {
    const result = await scanProjects({ ...(invocation.root ? { root: invocation.root } : {}) });
    process.stdout.write(
      mode === "json" ? renderJson(result) : renderSnapshot(result, process.stdout.columns || 100),
    );
    return 0;
  }
  await runTui({ ...(invocation.root ? { root: invocation.root } : {}) });
  return 0;
}

if (import.meta.main) process.exit(await main());
