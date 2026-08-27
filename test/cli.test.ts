import { expect, test } from "bun:test";
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

test("CLI chooses JSON automatically outside an interactive terminal", () => {
  expect(resolveMode("tui", true, true)).toBe("tui");
  expect(resolveMode("tui", false, true)).toBe("json");
  expect(resolveMode("tui", true, false)).toBe("json");
  expect(resolveMode("tui", false, false)).toBe("json");
  expect(resolveMode("snapshot", false, false)).toBe("snapshot");
  expect(resolveMode("json", true, true)).toBe("json");
});
