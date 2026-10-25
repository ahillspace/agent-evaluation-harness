import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { probeModelCatalog } from "./model-catalog.js";

const cleanups: Array<() => Promise<void>> = [];
const secret = "private-model-catalog-test-key";
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const requests: Array<{
    method?: string;
    url: string;
    authorization?: string;
    apiKey?: string;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url!,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port.");
  return {
    requests,
    probe: (provider = "openai", signal?: AbortSignal) =>
      probeModelCatalog({
        provider,
        settings: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
        apiKey: secret,
        signal,
      }),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

it.each(["openai", "openrouter"])(
  "reads the complete %s model list using only GET",
  async (provider) => {
    const { probe, requests } = await fixture((_request, response) =>
      response.end(
        JSON.stringify({ data: [{ id: "one", name: "One" }, { id: "two" }] }),
      ),
    );
    await expect(probe(provider)).resolves.toMatchObject({
      ok: true,
      resources: {
        modelDiscovery: "complete",
        credentialsVerified: true,
        models: [
          { id: "one", name: "One", provider },
          { id: "two", name: "two", provider },
        ],
      },
    });
    expect(requests).toEqual([
      {
        method: "GET",
        url: "/v1/models",
        authorization: `Bearer ${secret}`,
        apiKey: undefined,
      },
    ]);
  },
);

it("follows Anthropic cursors on the configured endpoint without following a returned URL", async () => {
  const cursor = "https://other.invalid/path?cursor=one&private=value";
  const { probe, requests } = await fixture((request, response) => {
    const after = new URL(
      request.url!,
      "http://fixture.invalid",
    ).searchParams.get("after_id");
    response.end(
      JSON.stringify(
        after
          ? {
              data: [{ id: "last", display_name: "Last model" }],
              has_more: false,
              last_id: "last",
            }
          : {
              data: [{ id: cursor, display_name: "First model" }],
              has_more: true,
              last_id: cursor,
            },
      ),
    );
  });
  const result = await probe("anthropic");
  expect(result).toMatchObject({
    ok: true,
    resources: {
      models: [
        { id: cursor, name: "First model" },
        { id: "last", name: "Last model" },
      ],
    },
  });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(new URL(request.url, "http://fixture.invalid").pathname).toBe(
      "/v1/models",
    );
    expect(request.apiKey).toBe(secret);
  }
  expect(
    new URL(requests[1]!.url, "http://fixture.invalid").searchParams.get(
      "after_id",
    ),
  ).toBe(cursor);
});

it.each(["cycle", "page-limit", "unsupported", "missing-status"])(
  "rejects %s pagination without exposing a partial catalog",
  async (mode) => {
    let count = 0;
    const { probe, requests } = await fixture((_request, response) => {
      const id = mode === "cycle" ? "same" : `model-${++count}`;
      response.end(
        JSON.stringify({
          data: [{ id }],
          ...(mode === "missing-status" ? {} : { has_more: true, last_id: id }),
          ...(mode === "unsupported"
            ? { next: "https://untrusted.invalid/models" }
            : {}),
        }),
      );
    });
    const result = await probe(
      mode === "unsupported" ? "openrouter" : "anthropic",
    );
    expect(result).toMatchObject({
      ok: false,
      resources: { models: [], modelDiscovery: "failed" },
    });
    expect(requests).toHaveLength(
      mode === "cycle" ? 2 : mode === "page-limit" ? 20 : 1,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);

it.each(["chunked", "compressed", "aggregate"])(
  "enforces the aggregate decoded byte limit for %s responses",
  async (mode) => {
    let page = 0;
    const { probe, requests } = await fixture((_request, response) => {
      const id = `model-${++page}`;
      const body = JSON.stringify({
        data: [{ id }],
        padding: "x".repeat((mode === "aggregate" ? 5 : 9) * 1024 * 1024),
        has_more: page === 1,
        last_id: id,
      });
      if (mode === "compressed")
        response
          .writeHead(200, { "content-encoding": "gzip" })
          .end(gzipSync(body));
      else {
        response.writeHead(200, { "transfer-encoding": "chunked" });
        response.write(body);
        response.end();
      }
    });
    const result = await probe(mode === "aggregate" ? "anthropic" : "openai");
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("byte limit"),
      resources: { models: [] },
    });
    expect(requests).toHaveLength(mode === "aggregate" ? 2 : 1);
  },
);

it.each(["malformed", "utf8", "invalid-entry", "duplicate", "count-limit"])(
  "rejects %s catalogs without silently dropping model rows",
  async (mode) => {
    const { probe } = await fixture((_request, response) => {
      if (mode === "malformed") response.end(`invalid ${secret}`);
      else if (mode === "utf8") response.end(Buffer.from([0xff]));
      else
        response.end(
          JSON.stringify({
            data:
              mode === "count-limit"
                ? Array.from({ length: 10_001 }, (_, id) => ({
                    id: String(id),
                  }))
                : [
                    { id: "one" },
                    mode === "invalid-entry" ? { id: 42 } : { id: "one" },
                  ],
          }),
        );
    });
    const result = await probe();
    expect(result).toMatchObject({
      ok: false,
      resources: { models: [], modelDiscovery: "failed" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);

it.each([403, 302])(
  "sanitizes HTTP %i and never follows redirects",
  async (status) => {
    const { probe, requests } = await fixture((_request, response) => {
      response.writeHead(status, { location: "/credential-sink" }).end(secret);
    });
    const result = await probe();
    expect(result).toMatchObject({ ok: false, resources: { models: [] } });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);

it("uses one deadline across model catalog pages and their response bodies", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    originalTimeout(ms === 20_000 ? 500 : ms),
  );
  let page = 0;
  const { probe, requests } = await fixture((_request, response) => {
    const id = `model-${++page}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    const timer = setTimeout(
      () =>
        response.end(
          `${JSON.stringify([{ id }])},"has_more":${page === 1},"last_id":"${id}"}`,
        ),
      350,
    );
    response.once("close", () => clearTimeout(timer));
  });
  const result = await probe("anthropic");
  expect(result).toMatchObject({
    ok: false,
    message: expect.stringContaining("time limit"),
    resources: { models: [] },
  });
  expect(requests).toHaveLength(2);
});

it("cancels a stalled response body without exposing the cancellation reason", async () => {
  const controller = new AbortController();
  const { probe } = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    setImmediate(() => controller.abort(new Error(secret)));
  });
  const result = await probe("openai", controller.signal);
  expect(result).toMatchObject({
    ok: false,
    message: expect.stringContaining("interrupted"),
    resources: { models: [] },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});
