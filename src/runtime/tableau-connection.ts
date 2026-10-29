import { z } from "zod";
import type {
  CommandValue,
  ConnectionRecord,
  ConnectionResourcePage,
  Json,
} from "../contracts.js";
export class TableauConnectionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Json,
  ) {
    super(message);
    this.name = "TableauConnectionFailure";
  }
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new TableauConnectionFailure(
      "response_too_large",
      "Tableau returned a response above the byte limit. Use a smaller page.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new TableauConnectionFailure(
      "invalid_response",
      "Tableau returned an empty response.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new TableauConnectionFailure(
          "response_too_large",
          "Tableau returned a response above the byte limit. Use a smaller page.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new TableauConnectionFailure(
      "invalid_response",
      "Tableau returned malformed JSON.",
    );
  }
}

/** REST discovery and MCP probing share credential validation and session cleanup. */
export async function withTableauSession<T>(
  connection: ConnectionRecord,
  secrets: Record<string, string>,
  operation: (session: {
    server: string;
    token: string;
    siteId?: string;
    signal: AbortSignal;
  }) => Promise<T>,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<T> {
  const server = String(connection.settings.server).replace(/\/$/, "");
  const response = await fetch(`${server}/api/3.22/auth/signin`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      credentials: {
        personalAccessTokenName: connection.settings.patName,
        personalAccessTokenSecret: secrets.patValue,
        site: { contentUrl: connection.settings.site },
      },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TableauConnectionFailure(
      "connection_failed",
      `Tableau rejected sign-in (HTTP ${response.status}). Check the connection credentials and site.`,
    );
  }
  const signedIn = z
    .object({
      credentials: z.object({
        token: z.string().min(1),
        site: z.unknown().optional(),
      }),
    })
    .safeParse(await readJson(response, 65_536));
  if (!signedIn.success)
    throw new TableauConnectionFailure(
      "invalid_response",
      "Tableau returned an unexpected sign-in response.",
    );
  const { token, site } = signedIn.data.credentials;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const parsedSite = z
      .object({ id: z.string().min(1) })
      .optional()
      .safeParse(site);
    if (!parsedSite.success)
      throw new TableauConnectionFailure(
        "invalid_response",
        "Tableau returned an unexpected site in its sign-in response.",
      );
    outcome = {
      ok: true,
      value: await operation({
        server,
        token,
        siteId: parsedSite.data?.id,
        signal,
      }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let cleanupFailure: TableauConnectionFailure | undefined;
  try {
    const signedOut = await fetch(`${server}/api/3.22/auth/signout`, {
      method: "POST",
      redirect: "error",
      headers: { "X-Tableau-Auth": token },
      signal: AbortSignal.timeout(10_000),
    });
    await signedOut.body?.cancel();
    if (!signedOut.ok)
      throw new TableauConnectionFailure(
        "cleanup_failed",
        `Tableau session cleanup failed (HTTP ${signedOut.status}).`,
      );
  } catch (cause) {
    cleanupFailure =
      cause instanceof TableauConnectionFailure
        ? cause
        : new TableauConnectionFailure(
            "cleanup_failed",
            "Tableau session cleanup could not be confirmed.",
          );
  }
  if (cleanupFailure) {
    if (!outcome.ok)
      throw new TableauConnectionFailure(
        "cleanup_failed",
        `${outcome.error instanceof TableauConnectionFailure ? outcome.error.message : "The Tableau request failed."} Tableau session cleanup also failed.`,
        {
          operationCode:
            outcome.error instanceof TableauConnectionFailure
              ? outcome.error.code
              : "connection_failed",
          cleanupMessage: cleanupFailure.message,
        },
      );
    throw cleanupFailure;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export async function queryTableauResources(
  connection: ConnectionRecord,
  secrets: Record<string, string>,
  input: CommandValue<"connections.resources">,
  signal?: AbortSignal,
): Promise<ConnectionResourcePage> {
  if (input.search && /[&,]/u.test(input.search))
    throw new TableauConnectionFailure(
      "invalid_input",
      "Tableau exact-name search does not support commas or ampersands. Clear search and browse the datasource pages instead.",
    );
  return withTableauSession(
    connection,
    secrets,
    async ({ server, token, siteId, signal: deadline }) => {
      if (!siteId)
        throw new TableauConnectionFailure(
          "invalid_response",
          "Tableau did not identify the signed-in site.",
        );
      const url = new URL(
        `${server}/api/3.22/sites/${encodeURIComponent(siteId)}/datasources`,
      );
      url.searchParams.set("pageSize", String(input.pageSize));
      url.searchParams.set("pageNumber", String(input.page));
      url.searchParams.set("sort", "name:asc");
      if (input.search)
        url.searchParams.set("filter", `name:eq:${input.search}`);
      const response = await fetch(url, {
        redirect: "error",
        signal: deadline,
        headers: { accept: "application/json", "X-Tableau-Auth": token },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TableauConnectionFailure(
          "connection_failed",
          `Tableau could not list datasources (HTTP ${response.status}).`,
        );
      }
      const parsed = z
        .object({
          pagination: z.object({
            pageNumber: z.coerce.number().int().positive(),
            pageSize: z.coerce.number().int().positive().max(1000),
            totalAvailable: z.coerce.number().int().nonnegative(),
          }),
          datasources: z.object({
            datasource: z
              .array(
                z.object({
                  id: z.string().min(1).max(200),
                  name: z.string().min(1).max(1000),
                  project: z.object({ name: z.string().max(1000) }).optional(),
                }),
              )
              .max(input.pageSize)
              .default([]),
          }),
        })
        .safeParse(await readJson(response, 4_194_304));
      if (!parsed.success || parsed.data.pagination.pageNumber !== input.page)
        throw new TableauConnectionFailure(
          "invalid_response",
          "Tableau returned an unexpected datasource page.",
        );
      const { pagination, datasources } = parsed.data;
      return {
        resources: datasources.datasource.map((item) => ({
          id: item.id,
          name: item.name,
          ...(item.project ? { projectName: item.project.name } : {}),
        })),
        total: pagination.totalAvailable,
        nextPage:
          pagination.pageNumber * pagination.pageSize <
          pagination.totalAvailable
            ? pagination.pageNumber + 1
            : null,
      };
    },
    signal,
  );
}
