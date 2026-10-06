import { expect, it } from "vitest";
import { runCli } from "./cli.js";

it("shows runnable repository commands with portable file input examples", async () => {
  expect(await runCli(["--help"])).toEqual({
    usage:
      "node dist/cli.js <operation> [--json <JSON> | --file <path> | --stdin] [--url <local endpoint>]",
    discovery: "node dist/cli.js discover",
    examples: [
      "node dist/cli.js workspace.get",
      "node dist/cli.js runs.launch --file launch.json",
      "node dist/cli.js runs.control --file control.json",
    ],
  });
});
