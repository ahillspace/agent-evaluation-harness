import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { ConnectionRecord } from "../contracts.js";
import { queryTableauResources } from "./tableau-connection.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  mode:
    | "normal"
    | "failure"
    | "oversized"
    | "malformed-site"
    | "dual-failure" = "normal",
) {
  const requests: URL[] = [];
  let signedOut = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("signin"))
      response.end(
        JSON.stringify({
          credentials: {
            token: "private-session",
            site: { id: mode === "malformed-site" ? null : "site-luid" },
          },
        }),
      );
    else if (url.pathname.endsWith("signout")) {
      signedOut++;
      response.writeHead(mode === "dual-failure" ? 503 : 204);
      response.end();
    } else {
      expect(request.headers["x-tableau-auth"]).toBe("private-session");
      if (mode === "failure" || mode === "dual-failure") {
        response.writeHead(403);
        response.end('{"secret":"must not surface"}');
      } else if (mode === "oversized") response.end("x".repeat(4_194_305));
      else
        response.end(
          JSON.stringify({
            pagination: {
              pageNumber: url.searchParams.get("pageNumber"),
              pageSize: "1",
              totalAvailable: "2",
            },
            datasources: {
              datasource: [
                {
                  id:
                    url.searchParams.get("pageNumber") === "2"
                      ? "38bf6eb9-2093-4f41-a228-516a3a97abde"
                      : "fe44d2e5-3631-4426-bd97-a5a9a0d6ced6",
                  name: "Supply chain",
                  project: {
                    name:
                      url.searchParams.get("pageNumber") === "2"
                        ? "Production"
                        : "Sandbox",
                  },
                },
              ],
            },
          }),
        );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const connection: ConnectionRecord = {
    id: "tableau",
    name: "Tableau",
    provider: "tableau",
    settings: {
      server: `http://127.0.0.1:${address.port}`,
      site: "fixture",
      patName: "test",
    },
    hasCredentials: true,
    credentialFields: ["patValue"],
  };
  return { connection, requests, signedOut: () => signedOut };
}
it("queries bounded native pages with readable project metadata and exact identities", async () => {
  const { connection, requests, signedOut } = await fixture();
  const first = await queryTableauResources(
    connection,
    { patValue: "secret" },
    { connectionId: connection.id, page: 1, pageSize: 1 },
  );
  const second = await queryTableauResources(
    connection,
    { patValue: "secret" },
    {
      connectionId: connection.id,
      page: 2,
      pageSize: 1,
      search: "Supply chain",
    },
  );
  expect(first).toMatchObject({
    nextPage: 2,
    total: 2,
    resources: [{ name: "Supply chain", projectName: "Sandbox" }],
  });
  expect(second).toMatchObject({
    nextPage: null,
    resources: [
      { id: "38bf6eb9-2093-4f41-a228-516a3a97abde", projectName: "Production" },
    ],
  });
  expect(
    requests.filter((url) => url.pathname.endsWith("datasources")),
  ).toHaveLength(2);
  expect(
    requests
      .find((url) => url.searchParams.has("filter"))
      ?.searchParams.get("filter"),
  ).toBe("name:eq:Supply chain");
  expect(signedOut()).toBe(2);
  expect(JSON.stringify([first, second])).not.toContain("private-session");
});
it.each(["failure", "oversized"] as const)(
  "signs out after a %s resource response",
  async (mode) => {
    const { connection, signedOut } = await fixture(mode);
    await expect(
      queryTableauResources(
        connection,
        { patValue: "secret" },
        { connectionId: connection.id, page: 1, pageSize: 100 },
      ),
    ).rejects.toThrow(mode === "failure" ? /403/ : /limit/);
    expect(signedOut()).toBe(1);
  },
);
it("rejects unsupported filter separators before contacting Tableau", async () => {
  const { connection, requests } = await fixture();
  await expect(
    queryTableauResources(
      connection,
      { patValue: "secret" },
      {
        connectionId: connection.id,
        page: 1,
        pageSize: 100,
        search: "Sales,projectName:eq:Private",
      },
    ),
  ).rejects.toThrow(/browse/i);
  expect(requests).toHaveLength(0);
});
it("signs out a valid token even when sign-in site metadata is malformed", async () => {
  const { connection, signedOut, requests } = await fixture("malformed-site");
  await expect(
    queryTableauResources(
      connection,
      { patValue: "secret" },
      { connectionId: connection.id, page: 1, pageSize: 100 },
    ),
  ).rejects.toThrow(/unexpected site/i);
  expect(signedOut()).toBe(1);
  expect(requests.some((url) => url.pathname.endsWith("datasources"))).toBe(
    false,
  );
});
it("preserves the query failure when session cleanup also fails", async () => {
  const { connection, signedOut } = await fixture("dual-failure");
  await expect(
    queryTableauResources(
      connection,
      { patValue: "secret" },
      { connectionId: connection.id, page: 1, pageSize: 100 },
    ),
  ).rejects.toMatchObject({
    code: "cleanup_failed",
    message: expect.stringMatching(/403.*cleanup/i),
    details: {
      operationCode: "connection_failed",
      cleanupMessage: expect.stringContaining("503"),
    },
  });
  expect(signedOut()).toBe(1);
});
