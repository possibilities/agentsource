#!/usr/bin/env bun

import { resolve } from "node:path";
import { scanProjects } from "./git.ts";
import { renderSnapshot } from "./render.ts";
import { runTui } from "./tui/app.ts";

interface Invocation {
  mode: "tui" | "snapshot" | "help";
  root?: string;
}

function usage(): string {
  return `Usage: agentsource [--snapshot] [--root PATH]

Show ~/code projects with working changes, unpushed work, or linked worktrees.

Options:
  --snapshot    print one plain observation and exit
  --root PATH   scan direct projects below PATH instead of ~/code
  --help        show this help
`;
}

export function parseArgs(args: readonly string[]): Invocation {
  let mode: Invocation["mode"] = "tui";
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") mode = "help";
    else if (arg === "--snapshot") mode = "snapshot";
    else if (arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root needs a path");
      root = resolve(value);
      index += 1;
    } else if (arg?.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else throw new Error(`unknown option: ${arg}`);
  }
  return { mode, ...(root ? { root } : {}) };
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
  if (invocation.mode === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (
    invocation.mode === "snapshot" ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    const result = await scanProjects({ ...(invocation.root ? { root: invocation.root } : {}) });
    process.stdout.write(renderSnapshot(result, process.stdout.columns || 100));
    return 0;
  }
  await runTui({ ...(invocation.root ? { root: invocation.root } : {}) });
  return 0;
}

if (import.meta.main) process.exit(await main());
