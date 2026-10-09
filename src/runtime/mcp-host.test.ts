import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { helperCommand } from "./harness.js";
import { createProcessSupervisor } from "./platform.js";
import type { AnswerFormat, Json } from "../contracts.js";

it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "passes arbitrary MCP environment names and literal values to the real child process",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-mcp-env-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    const environment = {
      future_mcp_option: "mixed Case and spaces",
      Future_JSON_Option: '{"enabled":true,"limit":42}',
      Future_Literal_Option: "$HOME; $(echo untouched)\nsecond line",
    };
    const certificate = path.join(directory, "company certificates.pem");
    await writeFile(certificate, "");
    try {
      await supervisor.recover();
      const command = helperCommand("connection", "AEH_TEST_MCP_BINDING");
      const childSource = `
        const lines = require('node:readline').createInterface({ input: process.stdin });
        lines.on('line', line => {
          const request = JSON.parse(line);
          const env = Object.fromEntries(${JSON.stringify([...Object.keys(environment), "NODE_EXTRA_CA_CERTS"])}.map(key => [key, process.env[key]]));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { env, inheritedSecret: process.env.AEH_UNRELATED_SECRET ?? null } }) + '\\n');
        });
      `;
      const result = await supervisor.run({
        executable: command.command,
        args: command.args,
        cwd: directory,
        processLimit: 4,
        timeoutMs: 15_000,
        env: {
          AEH_UNRELATED_SECRET: "unrelated-fixture-secret",
          NODE_EXTRA_CA_CERTS: certificate,
          AEH_TEST_MCP_BINDING: JSON.stringify({
            command: process.execPath,
            args: ["-e", childSource],
            env: environment,
          }),
        },
        input:
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) +
          "\n",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).result).toEqual({
        env: { ...environment, NODE_EXTRA_CA_CERTS: certificate },
        inheritedSecret: null,
      });
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!["win32", "darwin"].includes(process.platform)).each([
  {
    name: "positive decimal exponent",
    format: { type: "scalar", valueType: "decimal", nullable: false },
    invalid: "1e1001",
    valid: "1e1000",
  },
  {
    name: "negative decimal exponent",
    format: { type: "scalar", valueType: "decimal", nullable: false },
    invalid: "1e-1001",
    valid: "1e-1000",
  },
  {
    name: "scalar",
    format: { type: "scalar", valueType: "string", nullable: true },
    invalid: ["A"],
    valid: "A",
  },
  {
    name: "empty collection",
    format: { type: "list", itemType: "json", nullable: true },
    invalid: "",
    valid: [],
  },
  {
    name: "nonempty collection",
    format: { type: "list", itemType: "json", nullable: true },
    invalid: "",
    valid: ["A"],
  },
] satisfies Array<{
  name: string;
  format: AnswerFormat;
  invalid: Json;
  valid: Json;
}>)(
  "validates the public $name format through the real submission protocol",
  async ({ format, invalid, valid }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-public-format-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    try {
      await supervisor.recover();
      const answerFile = path.join(directory, "answer.json");
      const formatFile = path.join(directory, "format.json");
      await writeFile(formatFile, JSON.stringify(format));
      const command = helperCommand("answer", answerFile, formatFile);
      const requests = [
        { id: 1, method: "tools/list" },
        {
          id: 2,
          method: "tools/call",
          params: { name: "submit_answer", arguments: { answer: invalid } },
        },
        {
          id: 3,
          method: "tools/call",
          params: { name: "submit_answer", arguments: { answer: valid } },
        },
      ];
      const result = await supervisor.run({
        executable: command.command,
        args: command.args,
        cwd: directory,
        processLimit: 4,
        input:
          requests
            .map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }))
            .join("\n") + "\n",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses[1].result.isError).toBe(true);
      expect(responses[1].result.content[0].text).toContain(
        "No answer was recorded",
      );
      expect(responses[2].result.isError).not.toBe(true);
      expect(JSON.parse(await readFile(answerFile, "utf8"))).toEqual({
        answer: valid,
      });
      const advertised =
        responses[0].result.tools[0].inputSchema.properties.answer;
      expect(JSON.stringify(advertised)).not.toContain('"const"');
      expect(JSON.stringify(advertised)).not.toContain('"enum"');
      if (format.type === "list") {
        expect(advertised.type).toBe("array");
        expect(advertised.minItems ?? 0).toBe(0);
        expect(advertised.maxItems).toBeGreaterThan(0);
      }
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "serves a real typed answer MCP protocol in an isolated working directory",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-answer-test-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    try {
      await supervisor.recover();
      const answerFile = path.join(directory, "answer.json");
      const command = helperCommand("answer", answerFile);
      const requests = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "submit_answer",
            arguments: { answer: { count: 42 } },
          },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "submit_answer", arguments: { answer: "overwrite" } },
        },
      ];
      const result = await supervisor.run({
        executable: command.command,
        args: command.args,
        cwd: directory,
        processLimit: 4,
        input:
          requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses[1].result.tools[0].name).toBe("submit_answer");
      expect(responses[3].result.isError).toBe(true);
      expect(responses[3].result.content[0].text).toContain("already recorded");
      expect(JSON.parse(await readFile(answerFile, "utf8"))).toEqual({
        answer: { count: 42 },
      });
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "advertises the public row schema and permits correction before recording one answer",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "aeh-answer-format-test-"),
    );
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    try {
      await supervisor.recover();
      const answerFile = path.join(directory, "answer.json");
      const formatFile = path.join(directory, "answer-format.json");
      await writeFile(
        formatFile,
        JSON.stringify({
          type: "table",
          columns: [
            { name: "billing_country", type: "string", nullable: false },
            { name: "COUNT(*)", type: "integer", nullable: false },
          ],
        }),
      );
      const command = helperCommand("answer", answerFile, formatFile);
      const corrected = [{ billing_country: "Example", "COUNT(*)": 42 }];
      const messages = [
        { id: 1, method: "tools/list" },
        {
          id: 2,
          method: "tools/call",
          params: {
            name: "submit_answer",
            arguments: { answer: [{ country: "Example", count: 42 }] },
          },
        },
        {
          id: 3,
          method: "tools/call",
          params: { name: "submit_answer", arguments: { answer: corrected } },
        },
        {
          id: 4,
          method: "tools/call",
          params: { name: "submit_answer", arguments: { answer: [] } },
        },
        {
          id: 5,
          method: "tools/call",
          params: {
            name: "submit_answer",
            arguments: { answer: [{ wrong: 1 }] },
          },
        },
      ];
      const result = await supervisor.run({
        executable: command.command,
        args: command.args,
        cwd: directory,
        processLimit: 4,
        input:
          messages
            .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
            .join("\n") + "\n",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        responses[0].result.tools[0].inputSchema.properties.answer,
      ).toMatchObject({
        type: "array",
        items: {
          type: "object",
          required: ["billing_country", "COUNT(*)"],
          additionalProperties: false,
        },
      });
      expect(JSON.stringify(responses[0])).not.toContain("Example");
      expect(responses[1].result.isError).toBe(true);
      expect(responses[1].result.content[0].text).toContain("billing_country");
      expect(responses[2].result.isError).not.toBe(true);
      expect(responses[3].result.isError).toBe(true);
      for (const response of responses.slice(3)) {
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toContain("already recorded");
        expect(response.result.content[0].text).toContain("cannot be changed");
        expect(response.result.content[0].text).not.toContain(
          "No answer was recorded",
        );
        expect(response.result.content[0].text).not.toContain(
          "Correct the answer",
        );
      }
      expect(responses).toHaveLength(5);
      expect(JSON.parse(await readFile(answerFile, "utf8"))).toEqual({
        answer: corrected,
      });
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
