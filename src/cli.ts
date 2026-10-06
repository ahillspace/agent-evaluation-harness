import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runCli(args: string[]): Promise<unknown> {
  let operation: string | undefined;
  let endpoint = process.env.AEH_URL ?? "http://127.0.0.1:4381";
  let input: unknown = {};
  let inputSet = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--url") {
      endpoint = args[++index] ?? "";
      continue;
    }
    if (arg === "--json" || arg === "--file" || arg === "--stdin") {
      if (inputSet)
        throw new Error(
          "Choose only one input source: --json, --file, or --stdin.",
        );
      inputSet = true;
      let raw: string;
      if (arg === "--stdin") {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin)
          chunks.push(Buffer.from(chunk as Buffer));
        raw = Buffer.concat(chunks).toString("utf8");
      } else {
        const value = args[++index];
        if (!value) throw new Error(`${arg} requires a value.`);
        raw = arg === "--file" ? await readFile(value, "utf8") : value;
      }
      input = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
      continue;
    }
    if (arg === "--help" || arg === "-h")
      return {
        usage:
          "node dist/cli.js <operation> [--json <JSON> | --file <path> | --stdin] [--url <local endpoint>]",
        discovery: "node dist/cli.js discover",
        examples: [
          "node dist/cli.js workspace.get",
          "node dist/cli.js runs.launch --file launch.json",
          "node dist/cli.js runs.control --file control.json",
        ],
      };
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (operation)
      throw new Error(
        "Specify one operation. Use discover to list operations.",
      );
    operation = arg;
  }
  if (!operation) operation = "discover";
  const url = new URL(endpoint);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error("Use a local HTTP engine endpoint.");
  const response = await fetch(
    new URL(
      operation === "discover"
        ? "/api/discovery"
        : `/api/commands/${encodeURIComponent(operation)}`,
      url,
    ),
    operation === "discover"
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const result = (await response.json()) as unknown;
  if (!response.ok)
    throw Object.assign(new Error("Engine command failed."), {
      response: result,
    });
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runCli(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(error && typeof error === "object" && "response" in error ? error.response : { error: { code: "cli_error", message: error instanceof Error ? error.message : String(error) } })}\n`,
    );
    process.exitCode = 1;
  }
}
