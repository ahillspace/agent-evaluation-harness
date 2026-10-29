import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { answerFormatSchema, jsonSchema } from "../contracts.js";
import { inheritedEnvironment } from "./commands.js";
import {
  answerFormatJsonSchema,
  validateSubmittedAnswer,
} from "../contracts/answer-format.js";

// This bridge runs inside the target's existing containment scope, never as a separate worker.
const mode = process.argv[2];
const answerFormat =
  mode === "answer" && process.argv[4]
    ? answerFormatSchema.parse(
        JSON.parse(await readFile(process.argv[4], "utf8")),
      )
    : undefined;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const failure = (id: unknown, message: string) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`,
  );
const recordedReceipt = (id: unknown) =>
  reply(id, {
    isError: true,
    content: [
      {
        type: "text",
        text: "An answer is already recorded and cannot be changed. End this attempt without submitting again.",
      },
    ],
  });

if (mode === "connection") {
  const key = process.argv[3]!;
  const binding = JSON.parse(process.env[key] ?? "{}") as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  const env = { ...inheritedEnvironment(), ...binding.env };
  const child = spawn(binding.command, binding.args, {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.on("data", () => {
    /* Provider diagnostics can contain credentials. */
  });
  child.stdin.on("error", () => undefined);
  child.once("error", () => {
    process.stderr.write("The connection process could not start.\n");
    process.exitCode = 1;
    lines.close();
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
    lines.close();
  });
  lines.on("line", (line) => {
    if (line.length > 2_000_000) {
      child.kill();
      lines.close();
    } else child.stdin.write(`${line}\n`);
  });
  lines.on("close", () => child.stdin.end());
} else {
  const tool =
    mode === "answer"
      ? {
          name: "submit_answer",
          description:
            "Submit the final typed answer exactly once. Preserve JSON value types.",
          inputSchema: {
            type: "object",
            properties: {
              answer: answerFormat ? answerFormatJsonSchema(answerFormat) : {},
            },
            required: ["answer"],
            additionalProperties: false,
          },
        }
      : {
          name: "read_evidence",
          description:
            "Read saved run evidence. Expected answers require includeGold: true and are audited.",
          inputSchema: {
            type: "object",
            properties: {
              runId: { type: "string" },
              resultId: { type: "string" },
              includeGold: { type: "boolean", default: false },
            },
            required: ["runId"],
            additionalProperties: false,
          },
        };
  let serial = Promise.resolve();
  lines.on("line", (line) => {
    serial = serial.then(async () => {
      let request: {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      try {
        if (line.length > 2_000_000) throw new Error();
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (request.id === undefined) return;
      if (request.method === "initialize") {
        reply(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: `aeh-${mode}`, version: "1.0.0" },
        });
        return;
      }
      if (request.method === "ping") {
        reply(request.id, {});
        return;
      }
      if (request.method === "tools/list") {
        reply(request.id, { tools: [tool] });
        return;
      }
      if (
        request.method !== "tools/call" ||
        request.params?.name !== tool.name
      ) {
        failure(request.id, "Unknown method or tool.");
        return;
      }
      try {
        const args = request.params.arguments ?? {};
        if (mode === "answer") {
          try {
            await access(process.argv[3]!);
            recordedReceipt(request.id);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!Object.hasOwn(args, "answer") || Object.keys(args).length !== 1)
            throw new Error("Provide exactly one answer value.");
          if (answerFormat) {
            const validation = validateSubmittedAnswer(
              answerFormat,
              jsonSchema.parse(args.answer),
            );
            if (!validation.ok) {
              await writeFile(
                `${process.argv[3]!}.rejection.json`,
                JSON.stringify({
                  error: validation.error,
                  answer: args.answer,
                }),
                "utf8",
              );
              reply(request.id, {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `${validation.error ?? "The answer does not match the public format."} Correct the answer format and call submit_answer again. No answer was recorded.`,
                  },
                ],
              });
              return;
            }
          }
          await writeFile(
            process.argv[3]!,
            JSON.stringify({ answer: args.answer }),
            { flag: "wx" },
          );
          reply(request.id, {
            content: [{ type: "text", text: "Answer recorded." }],
          });
        } else {
          const response = await fetch(process.env.AEH_EVIDENCE_URL!, {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.AEH_EVIDENCE_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error("Evidence request was rejected.");
          const evidence = await response.text();
          reply(request.id, { content: [{ type: "text", text: evidence }] });
        }
      } catch (error) {
        if (
          mode === "answer" &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          recordedReceipt(request.id);
          return;
        }
        reply(request.id, {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error &&
                error.message === "Provide exactly one answer value."
                  ? error.message
                  : "The request could not be completed.",
            },
          ],
        });
      }
    });
  });
  lines.on("close", () => {
    void serial;
  });
}
