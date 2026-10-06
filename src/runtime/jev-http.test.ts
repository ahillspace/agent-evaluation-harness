import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { jevHttp } from "./jev-http.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(
  reply: (response: ServerResponse, call: number) => void,
) {
  let calls = 0;
  const requests: Array<{
    url: string;
    authorization?: string;
    body: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({
      url: request.url!,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    reply(response, ++calls);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    requests,
  };
}
const invoke = (endpoint: string, extra = {}) =>
  jevHttp({
    endpoint,
    apiKey: "fixture-secret",
    request: {
      model: "jev-1.13.0",
      state: { marker: "whole trace" },
      questions: {},
    },
    signal: new AbortController().signal,
    timeoutMs: 2000,
    ...extra,
  });

it("sends bearer JSON and preserves redacted raw response and request ID", async () => {
  const server = await fixture((response) =>
    response.writeHead(200, { "x-request-id": "request-1" }).end(
      JSON.stringify({
        model: "jev-1.13.0",
        echo: "fixture-secret",
        usage: { input_tokens: 123, output_tokens: 4 },
      }),
    ),
  );
  const result = await invoke(server.endpoint);
  expect(server.requests[0]).toMatchObject({
    authorization: "Bearer fixture-secret",
    body: { state: { marker: "whole trace" } },
  });
  expect(result.requestId).toBe("request-1");
  expect(result.response).toHaveProperty("echo", "[REDACTED]");
  expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 4 });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
it("retries only explicit rejected overloads and retains every response", async () => {
  const server = await fixture((response, call) =>
    response
      .writeHead(call < 3 ? 429 : 200, { "retry-after": "0" })
      .end(
        JSON.stringify({ call, usage: { input_tokens: 10, output_tokens: 2 } }),
      ),
  );
  const result = await invoke(server.endpoint);
  expect(server.requests).toHaveLength(3);
  expect(result.attempts.map((attempt) => attempt.status)).toEqual([
    429, 429, 200,
  ]);
  expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
  const ambiguous = await fixture((response) =>
    response.writeHead(500).end("{}"),
  );
  await expect(invoke(ambiguous.endpoint)).rejects.toMatchObject({
    code: "provider_failure",
  });
  expect(ambiguous.requests).toHaveLength(1);
});
it("keeps 422 capacity errors and invalid JSON provenance without retrying", async () => {
  const capacity = await fixture((response) =>
    response.writeHead(422).end('{"detail":"context exceeds capacity"}'),
  );
  await expect(invoke(capacity.endpoint)).rejects.toMatchObject({
    code: "capacity_exceeded",
    response: { detail: "context exceeds capacity" },
  });
  expect(capacity.requests).toHaveLength(1);
  const invalid = await fixture((response) =>
    response.writeHead(422).end('{"detail":"Missing model field"}'),
  );
  await expect(invoke(invalid.endpoint)).rejects.toMatchObject({
    code: "invalid_request",
  });
  const malformed = await fixture((response) =>
    response.end("not JSON fixture-secret"),
  );
  await expect(invoke(malformed.endpoint)).rejects.toMatchObject({
    code: "invalid_provider_response",
    response: "not JSON [REDACTED]",
  });
});
it.each([
  {
    error: {
      code: "max_tokens_exceeded",
      message: "The state exceeds 32000 tokens.",
    },
  },
  {
    detail: {
      error_type: "max_tokens_exceeded",
      message: "The state exceeds 32000 tokens.",
    },
  },
])(
  "records HTTP 400 max_tokens_exceeded as an unjudged token limit without truncating or retrying: %j",
  async (body) => {
    const server = await fixture((response) =>
      response
        .writeHead(400, { "x-request-id": "oversized-fixture" })
        .end(JSON.stringify(body)),
    );
    await expect(invoke(server.endpoint)).rejects.toMatchObject({
      code: "token_limit_exceeded",
      httpStatus: 400,
      response: body,
      requestId: "oversized-fixture",
      request: { state: { marker: "whole trace" } },
      attempts: [{ status: 400, response: body }],
    });
    expect(server.requests).toHaveLength(1);
  },
);
it("bounds response streams and honors cancellation and a shared retry deadline", async () => {
  const huge = await fixture((response) => response.end("x".repeat(2000)));
  await expect(
    invoke(huge.endpoint, { maxResponseBytes: 1000 }),
  ).rejects.toMatchObject({ code: "response_too_large" });
  const waiting = await fixture((response) =>
    response.writeHead(429, { "retry-after": "10" }).end("{}"),
  );
  await expect(
    invoke(waiting.endpoint, { timeoutMs: 40 }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(waiting.requests).toHaveLength(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    invoke(waiting.endpoint, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "interrupted" });
  expect(waiting.requests).toHaveLength(1);
});
it("does not follow redirects carrying credentials", async () => {
  const server = await fixture((response) =>
    response.writeHead(307, { location: "/stolen" }).end("{}"),
  );
  await expect(invoke(server.endpoint)).rejects.toMatchObject({
    code: "provider_failure",
  });
  expect(server.requests).toHaveLength(1);
});
it.each(["network", "missing_usage"])(
  "does not hide unknown final usage behind reported retry usage (%s)",
  async (failure) => {
    const server = await fixture((response, call) => {
      if (call === 1)
        response
          .writeHead(429, { "retry-after": "0" })
          .end(
            JSON.stringify({ usage: { input_tokens: 15, output_tokens: 2 } }),
          );
      else if (failure === "network") response.destroy();
      else response.end("{}");
    });
    if (failure === "network") {
      await expect(invoke(server.endpoint)).rejects.toMatchObject({
        usage: undefined,
        attempts: [{ status: 429, response: { usage: { input_tokens: 15 } } }],
      });
    } else {
      const result = await invoke(server.endpoint);
      expect(result.usage).toBeUndefined();
      expect(result.attempts).toHaveLength(2);
    }
  },
);
