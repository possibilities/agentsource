import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

test("CLI parses snapshot and root options", () => {
  expect(parseArgs(["--snapshot", "--root", "/tmp/projects"])).toEqual({
    mode: "snapshot",
    root: "/tmp/projects",
  });
  expect(() => parseArgs(["--unknown"])).toThrow("unknown option");
});
