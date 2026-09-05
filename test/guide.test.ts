import { expect, test } from "bun:test";
import { CONTRACT, renderGuideJson } from "../src/guide.ts";

// agentsource owns its own conformance to the fleet agent contract (version 1,
// defined in agentstart's config/agent-contract/schema.json). This test
// asserts the invariants that matter for an *operator* CLI without depending
// on agentstart's checkout being present; agentstart's own
// scripts/validate-agent-contract.ts runs the full schema against
// `agentsource guide --json` separately.

test("guide --json emits a conformant envelope", () => {
  const envelope = JSON.parse(renderGuideJson());
  expect(envelope.schema_version).toBe(1);
  expect(envelope.ok).toBe(true);
  expect(envelope.error).toBeNull();
  expect(envelope.data).toEqual(CONTRACT);
});

test("contract declares the required top-level shape", () => {
  expect(CONTRACT.contract_version).toBe(1);
  expect(CONTRACT.meta.name).toBe("agentsource");
  expect(CONTRACT.meta.audience).toBe("operator");
  expect(CONTRACT.commands.length).toBeGreaterThan(0);
});

function walk(commands: readonly (typeof CONTRACT.commands)[number][]): void {
  for (const command of commands) {
    // An operator CLI may not expose an agent-audience command.
    expect(command.audience).not.toBe("agent");
    if (command.subcommands && command.subcommands.length > 0) {
      // A group is not invocable: no mutates, no arguments of its own.
      expect(command.mutates).toBeUndefined();
      expect(command.arguments).toBeUndefined();
      walk(command.subcommands);
    } else {
      // A leaf is invocable and owes the full mechanical description.
      expect(typeof command.mutates).toBe("boolean");
      expect(Array.isArray(command.arguments)).toBe(true);
    }

    // A positional carries no leading dashes; a flag carries them.
    for (const argument of command.arguments ?? []) {
      const looksLikeFlag = argument.name.startsWith("-");
      if (argument.positional) expect(looksLikeFlag).toBe(false);
      else expect(looksLikeFlag).toBe(true);
      if (argument.direction !== undefined) expect(argument.format).toBe("path");
    }

    // A constraint may only name arguments the command actually declares.
    const known = new Set((command.arguments ?? []).map((argument) => argument.name));
    for (const constraint of command.constraints ?? []) {
      for (const name of constraint.arguments) expect(known.has(name)).toBe(true);
    }
  }
}

test("every command is a well-formed tree with no agent-audience verb", () => {
  walk(CONTRACT.commands);
});

test("every real dispatch verb is present in the contract, none hidden", () => {
  const names = CONTRACT.commands.map((command) => command.name).sort();
  expect(names).toEqual(["guide", "notify-daemon", "scan", "webhook-configure", "webhook-daemon"]);
});
