import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, resolveMode } from "../src/cli.ts";

test("CLI parses one-shot formats and root options", () => {
  expect(parseArgs(["--snapshot", "--root", "/tmp/projects"])).toEqual({
    mode: "snapshot",
    root: "/tmp/projects",
  });
  expect(parseArgs(["--json"])).toEqual({ mode: "json" });
  expect(() => parseArgs(["--json", "--snapshot"])).toThrow(
    "--json and --snapshot cannot be used together",
  );
  expect(() => parseArgs(["--json", "--help", "--snapshot"])).toThrow(
    "--json and --snapshot cannot be used together",
  );
  expect(() => parseArgs(["--snapshot", "--help", "--json"])).toThrow(
    "--json and --snapshot cannot be used together",
  );
  expect(() => parseArgs(["--unknown"])).toThrow("unknown option");
});

test("CLI parses the webhook daemon without weakening its loopback-only listener", () => {
  expect(
    parseArgs([
      "webhook-daemon",
      "--secret-file",
      "/tmp/webhook-secret",
      "--port=9000",
      "--socket",
      "/tmp/agentsource.sock",
      "--root",
      "/tmp/code",
    ]),
  ).toEqual({
    mode: "webhook-daemon",
    secretFile: "/tmp/webhook-secret",
    port: 9000,
    socketPath: "/tmp/agentsource.sock",
    root: "/tmp/code",
  });
  expect(parseArgs(["webhook-daemon", "--secret-file", "/tmp/webhook-secret"])).toMatchObject({
    root: join(homedir(), "code"),
  });
  expect(() => parseArgs(["webhook-daemon"])).toThrow("needs --secret-file");
  expect(() =>
    parseArgs(["webhook-daemon", "--secret-file", "/tmp/secret", "--port", "0"]),
  ).toThrow("integer from 1 to 65535");
  expect(() =>
    parseArgs(["webhook-daemon", "--secret-file", "/tmp/secret", "--host", "0.0.0.0"]),
  ).toThrow("unknown webhook-daemon option");
});

test("CLI delegates installed webhook reconciliation without rewriting its arguments", () => {
  expect(
    parseArgs(["webhook-configure", "--url", "https://machine.tailnet.ts.net", "--apply"]),
  ).toEqual({
    mode: "webhook-configure",
    args: ["--url", "https://machine.tailnet.ts.net", "--apply"],
  });
});

test("CLI chooses JSON automatically outside an interactive terminal", () => {
  expect(resolveMode("tui", true, true)).toBe("tui");
  expect(resolveMode("tui", false, true)).toBe("json");
  expect(resolveMode("tui", true, false)).toBe("json");
  expect(resolveMode("tui", false, false)).toBe("json");
  expect(resolveMode("snapshot", false, false)).toBe("snapshot");
  expect(resolveMode("json", true, true)).toBe("json");
});
