import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { httpTargetSchema } from "../../contracts/http-target.js";
import { executeHttpTarget } from "./http.js";
import { buildHttpRequest, extractHttpAnswer } from "./http-mapping.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return `http://127.0.0.1:${address.port}`;
}
const publicInput = {
  question: {
    id: "q",
    text: "Public question",
    tags: [],
    context: "Public context",
  },
  runId: "r",
  attemptId: "a",
  repetition: 1,
};
function input(url: string) {
  return {
    ...publicInput,
    configuration: httpTargetSchema.parse({ endpoint: url }),
    timeoutMs: 1000,
    maxOutputBytes: 100_000,
    signal: new AbortController().signal,
    onDispatch: async () => {},
    onEvent: () => {},
  };
}
describe("HTTP endpoint mapping", () => {
  it("projects only explicit public input and preserves typed values", () => {
    const configuration = httpTargetSchema.parse({
      endpoint: "https://example.com",
      body: { "a/b": { "~value": null }, id: null },
      bindings: [
        { pointer: "/a~1b/~0value", source: "context" },
        { pointer: "/id", source: "attemptId" },
      ],
    });
    expect(
      buildHttpRequest(configuration, {
        ...publicInput,
        question: { ...publicInput.question, expected: "SECRET" },
      } as typeof publicInput),
    ).toEqual({ "a/b": { "~value": "Public context" }, id: "a" });
  });
  it.each([null, false, 0, "", [], {}])(
    "preserves selected answer %j",
    (answer) => {
      expect(extractHttpAnswer({ answer }, "/answer")).toEqual(answer);
    },
  );
  it("rejects missing answers, unsafe pointers, and overlapping mappings", () => {
    expect(() => extractHttpAnswer({}, "/answer")).toThrow();
    expect(() =>
      httpTargetSchema.parse({
        endpoint: "https://example.com",
        answerPointer: "/__proto__",
      }),
    ).toThrow();
    expect(() =>
      httpTargetSchema.parse({
        endpoint: "https://example.com",
        body: { a: { b: null } },
        bindings: [
          { pointer: "/a", source: "context" },
          { pointer: "/a/b", source: "question" },
        ],
      }),
    ).toThrow();
  });
  it.each([
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "file:///test",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() => httpTargetSchema.parse({ endpoint: url })).toThrow();
  });
});
describe("HTTP target invocation", () => {
  it("rejects invalid UTF-8 instead of grading a replacement character", async () => {
    const url = await endpoint((_request, response) => {
      response.end(
        Buffer.concat([
          Buffer.from('{"answer":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      );
    });
    await expect(executeHttpTarget(input(url))).rejects.toMatchObject({
      code: "invalid_json",
    });
  });
  it("checkpoints before dispatch and captures one typed response without cookies", async () => {
    let checkpoint = false;
    let calls = 0;
    const url = await endpoint((request, response) => {
      calls++;
      expect(checkpoint).toBe(true);
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBe("Bearer test-secret");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ answer: [{ count: 26 }] }));
    });
    const request = input(url);
    request.configuration.authentication = {
      kind: "bearer",
      credentialReference: "ref",
    };
    const result = await executeHttpTarget({
      ...request,
      credential: "test-secret",
      onDispatch: async () => {
        checkpoint = true;
      },
    });
    expect(result.answer).toEqual([{ count: 26 }]);
    expect(result.remoteCompletion).toBe("observed");
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(calls).toBe(1);
  });
  it.each([202, 204, 302, 429, 500])(
    "rejects status %i without retry",
    async (status) => {
      let calls = 0;
      const url = await endpoint((_request, response) => {
        calls++;
        response.writeHead(status, { Location: "/again" });
        response.end('{"answer":"x"}');
      });
      await expect(executeHttpTarget(input(url))).rejects.toMatchObject({
        remoteCompletion: "unknown",
      });
      expect(calls).toBe(1);
    },
  );
  it("bounds slow bodies and preserves uncertain remote completion", async () => {
    const url = await endpoint((_request, response) => {
      response.writeHead(200);
      response.write('{"answer":');
    });
    await expect(
      executeHttpTarget({ ...input(url), timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "timeout", remoteCompletion: "unknown" });
  });
  it("bounds decoded response bodies", async () => {
    const url = await endpoint((_request, response) => {
      response.end(JSON.stringify({ answer: "x".repeat(2000) }));
    });
    await expect(
      executeHttpTarget({ ...input(url), maxOutputBytes: 1000 }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
  it("rejects credential echoes instead of grading a redacted answer", async () => {
    const url = await endpoint((_request, response) => {
      response.end('{"answer":"test-secret"}');
    });
    await expect(
      executeHttpTarget({ ...input(url), credential: "test-secret" }),
    ).rejects.toMatchObject({ code: "credential_leak" });
  });
  it("never dispatches an already canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeHttpTarget({
        ...input("https://example.com"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "interrupted",
      remoteCompletion: "not-dispatched",
    });
  });
  it("rejects escaped credential echoes", async () => {
    const url = await endpoint((_request, response) => {
      response.end('{"answer":"test-\\u0073ecret"}');
    });
    await expect(
      executeHttpTarget({ ...input(url), credential: "test-secret" }),
    ).rejects.toMatchObject({ code: "credential_leak" });
  });
  it("rejects malformed JSON and missing fields separately", async () => {
    const malformed = await endpoint((_request, response) => {
      response.end("invalid");
    });
    await expect(executeHttpTarget(input(malformed))).rejects.toMatchObject({
      code: "invalid_json",
    });
    const missing = await endpoint((_request, response) => {
      response.end("{}");
    });
    await expect(executeHttpTarget(input(missing))).rejects.toMatchObject({
      code: "answer_missing",
    });
  });
  it("does not send credentials configured as ordinary headers", async () => {
    const request = input("https://example.com");
    request.configuration.headers = { "X-Anything": "test-secret" };
    await expect(
      executeHttpTarget({ ...request, credential: "test-secret" }),
    ).rejects.toMatchObject({
      code: "credential_leak",
      remoteCompletion: "not-dispatched",
    });
  });
});
