#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultWebhookSocketPath, snapshotChannels } from "./channel-client.ts";
import { applyCiObservation, projectionFromEnvelope } from "./ci-observation.ts";
import { scanProjects } from "./git.ts";
import { runGitHubWebhookSetupCli } from "./github-webhooks.ts";
import { renderGuideJson, renderHelp } from "./guide.ts";
import { renderJson, renderSnapshot } from "./render.ts";
import { runTui } from "./tui/app.ts";
import { readWebhookSecret, startWebhookDaemon } from "./webhooks.ts";

interface ObservationInvocation {
  mode: "tui" | "snapshot" | "json" | "help";
  root?: string;
}

interface GuideInvocation {
  mode: "guide";
}

interface WebhookDaemonInvocation {
  mode: "webhook-daemon";
  secretFile: string;
  port: number;
  socketPath: string;
  root: string;
}

interface WebhookConfigureInvocation {
  mode: "webhook-configure";
  args: string[];
}

type Invocation =
  | ObservationInvocation
  | WebhookDaemonInvocation
  | WebhookConfigureInvocation
  | GuideInvocation;

export { defaultWebhookSocketPath } from "./channel-client.ts";

function usage(): string {
  return renderHelp();
}

export function parseArgs(args: readonly string[]): Invocation {
  if (args[0] === "guide") {
    return { mode: "guide" };
  }
  if (args[0] === "webhook-configure") {
    return { mode: "webhook-configure", args: [...args.slice(1)] };
  }
  if (args[0] === "webhook-daemon") {
    let secretFile: string | undefined;
    let port = 8787;
    let socketPath = defaultWebhookSocketPath();
    let root = join(homedir(), "code");
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--help" || arg === "-h") return { mode: "help" };
      if (arg === "--secret-file" || arg === "--port" || arg === "--socket" || arg === "--root") {
        const value = args[index + 1];
        if (!value) throw new Error(`${arg} needs a value`);
        if (arg === "--secret-file") secretFile = resolve(value);
        else if (arg === "--socket") socketPath = resolve(value);
        else if (arg === "--root") root = resolve(value);
        else {
          port = Number(value);
          if (!Number.isInteger(port) || port < 1 || port > 65_535)
            throw new Error("--port must be an integer from 1 to 65535");
        }
        index += 1;
      } else if (arg?.startsWith("--secret-file=")) {
        secretFile = resolve(arg.slice("--secret-file=".length));
      } else if (arg?.startsWith("--socket=")) {
        socketPath = resolve(arg.slice("--socket=".length));
      } else if (arg?.startsWith("--root=")) {
        root = resolve(arg.slice("--root=".length));
      } else if (arg?.startsWith("--port=")) {
        port = Number(arg.slice("--port=".length));
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
          throw new Error("--port must be an integer from 1 to 65535");
      } else throw new Error(`unknown webhook-daemon option: ${arg}`);
    }
    if (!secretFile) throw new Error("webhook-daemon needs --secret-file PATH");
    return { mode: "webhook-daemon", secretFile, port, socketPath, root };
  }
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
  if (invocation.mode === "guide") {
    process.stdout.write(renderGuideJson());
    return 0;
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
  if (invocation.mode === "webhook-configure") {
    return await runGitHubWebhookSetupCli(invocation.args);
  }
  if (invocation.mode === "webhook-daemon") {
    try {
      const secret = await readWebhookSecret(invocation.secretFile);
      const daemon = await startWebhookDaemon({
        secret,
        port: invocation.port,
        socketPath: invocation.socketPath,
        root: invocation.root,
      });
      process.stderr.write(
        `agentsource: accepting GitHub webhooks at http://${daemon.host}:${daemon.port}/<owner>/<repo>\n` +
          `agentsource: serving subscribed channels at ${daemon.socketPath}\n`,
      );
      for (const diagnostic of daemon.diagnostics)
        process.stderr.write(`agentsource: CI projection: ${diagnostic}\n`);
      let onInterrupt = (): void => undefined;
      let onTerminate = (): void => undefined;
      const signal = await new Promise<"SIGINT" | "SIGTERM">((resolveSignal) => {
        onInterrupt = () => resolveSignal("SIGINT");
        onTerminate = () => resolveSignal("SIGTERM");
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onTerminate);
      });
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      await daemon.close();
      return signal === "SIGINT" ? 130 : 143;
    } catch (error) {
      process.stderr.write(
        `agentsource: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  if (mode === "snapshot" || mode === "json") {
    const [raw, snapshot] = await Promise.all([
      scanProjects({
        ...(invocation.root ? { root: invocation.root } : {}),
        includeQuiet: true,
      }),
      snapshotChannels({ channels: ["ci:*"] }),
    ]);
    const result = applyCiObservation(raw, {
      available: snapshot.available,
      projections: snapshot.values.flatMap((value) => {
        const projection = projectionFromEnvelope(value);
        return projection ? [projection] : [];
      }),
      diagnostics: snapshot.diagnostics,
    });
    process.stdout.write(
      mode === "json" ? renderJson(result) : renderSnapshot(result, process.stdout.columns || 100),
    );
    return 0;
  }
  await runTui({ ...(invocation.root ? { root: invocation.root } : {}) });
  return 0;
}

if (import.meta.main) process.exit(await main());
