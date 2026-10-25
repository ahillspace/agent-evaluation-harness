import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { commandSchemas } from "./contracts.js";
import {
  createApplication,
  type Application,
} from "./application/application.js";
import { AppError, errorMessage } from "./domain/errors.js";
import { createRuntime } from "./runtime/index.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk as Buffer);
    if (size > 8_000_000)
      throw new AppError("body_limit", "Request exceeds the 8 MB limit.");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString("utf8")
        .replace(/^\uFEFF/, "") || "{}",
    ) as unknown;
  } catch {
    throw new AppError("invalid_input", "Request body must be valid JSON.");
  }
}
export async function startServer(
  options: {
    application?: Application;
    dataDirectory?: string;
    port?: number;
    host?: string;
  } = {},
) {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new AppError(
      "invalid_input",
      "The local engine must bind to a loopback address.",
    );
  const dataDirectory = resolve(
    options.dataDirectory ?? process.env.AEH_DATA_DIRECTORY ?? ".aeh",
  );
  const application =
    options.application ??
    (await createApplication({
      dataDirectory,
      runtime: await createRuntime({ stateDirectory: dataDirectory }),
    }));
  const webDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "web-dist",
  );
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "no-store");
      const hostHeader = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(hostHeader))
        throw new AppError(
          "forbidden",
          "This server accepts local requests only.",
        );
      if (request.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(request.headers.origin);
        } catch {
          throw new AppError("forbidden", "Invalid request origin.");
        }
        const ownOrigin = `http://${hostHeader}`;
        const development = [
          "http://127.0.0.1:5181",
          "http://localhost:5181",
        ].includes(origin.origin);
        if (origin.origin !== ownOrigin && !development)
          throw new AppError(
            "forbidden",
            "Cross-origin requests are not allowed.",
          );
        response.setHeader("Access-Control-Allow-Origin", origin.origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${hostHeader}`);
      let result: unknown;
      if (request.method === "GET" && url.pathname === "/api/build") {
        const build = await readFile(
          resolve(webDirectory, "build.json"),
          "utf8",
        )
          .then((value) => JSON.parse(value) as { buildId: string })
          .catch(() => ({ buildId: "development" }));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ...build, processId: process.pid }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/discovery")
        result = {
          name: "Agent Evaluation Harness",
          version: 1,
          operations: Object.entries(commandSchemas).map(([name, schema]) => ({
            name,
            inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }),
          })),
        };
      else if (request.method === "GET" && url.pathname === "/api/state")
        result = await application.execute("workspace.get", {});
      else if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/commands/")
      )
        result = await application.execute(
          decodeURIComponent(url.pathname.slice("/api/commands/".length)),
          await body(request),
        );
      else if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/runs/") &&
        url.pathname.endsWith("/events")
      )
        result = await application.execute("runs.events", {
          runId: url.pathname.split("/")[3],
          cursor: Number(url.searchParams.get("cursor") ?? 0),
        });
      else if (url.pathname.startsWith("/api/"))
        throw new AppError("not_found", "API endpoint not found.");
      else if (request.method === "GET") {
        const requested = resolve(
          webDirectory,
          `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
        );
        if (
          requested !== webDirectory &&
          !requested.startsWith(webDirectory + sep)
        )
          throw new AppError("forbidden", "Invalid file path.");
        let bytes: Buffer;
        try {
          bytes = await readFile(requested);
        } catch {
          try {
            bytes = await readFile(resolve(webDirectory, "index.html"));
          } catch {
            response.writeHead(503, { "Content-Type": "text/plain" });
            response.end(
              "Build the web app with npm run build, or open the Vite development server.",
            );
            return;
          }
        }
        response.writeHead(200, {
          "Content-Type":
            mime[extname(requested)] ?? "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(bytes);
        return;
      } else throw new AppError("not_found", "Endpoint not found.");
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof z.ZodError
            ? "invalid_input"
            : error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
              ? error.code
              : "internal_error";
      const status =
        code === "forbidden"
          ? 403
          : code === "not_found"
            ? 404
            : code === "internal_error"
              ? 500
              : code === "idempotency_conflict" || code === "invalid_state"
                ? 409
                : 400;
      if (!response.headersSent)
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
        });
      response.end(
        JSON.stringify({
          error: {
            code,
            message: errorMessage(error),
            ...(error instanceof z.ZodError ? { details: error.issues } : {}),
          },
        }),
      );
    });
  });
  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(
        options.port ?? Number(process.env.PORT ?? 4381),
        host,
        () => {
          server.off("error", reject);
          resolveListening();
        },
      );
    });
  } catch (error) {
    await application.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server has no TCP address.");
  let closed = false;
  return {
    server,
    url: `http://${host === "::1" ? `[${host}]` : host}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await application.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startServer();
  process.stdout.write(`Agent Evaluation Harness: ${app.url}\n`);
  const close = () => {
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
