import { z } from "zod";
import type { Json, RuntimePort } from "../contracts.js";
import { providerProbe } from "./model-providers.js";
import { safeFetchFailureDetails } from "./safe-fetch-diagnostics.js";

// Fixed discovery bounds cover the complete catalog, including every page.
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_PAGES = 20;
const TIMEOUT_MS = 20_000;
const pageSchema = z
  .object({
    data: z
      .array(
        z.object({
          id: z.string().min(1).max(1000),
          name: z.string().max(2000).optional(),
          display_name: z.string().max(2000).optional(),
        }),
      )
      .max(MAX_MODELS),
    has_more: z.boolean().optional(),
    last_id: z.string().min(1).max(1000).nullish(),
  })
  .passthrough();

class CatalogFailure extends Error {}

async function readPage(response: Response, remaining: number) {
  if (Number(response.headers.get("content-length")) > remaining) {
    await response.body?.cancel();
    throw new CatalogFailure(
      "Model discovery exceeded its response byte limit. No partial catalog was accepted.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new CatalogFailure(
      "The provider returned an empty model catalog response.",
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > remaining)
        throw new CatalogFailure(
          "Model discovery exceeded its response byte limit. No partial catalog was accepted.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new CatalogFailure(
      "The provider returned malformed model catalog JSON.",
    );
  }
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success)
    throw new CatalogFailure(
      "The provider returned an invalid model catalog. No partial catalog was accepted.",
    );
  return { page: parsed.data, bytes };
}

/** Only documented model-list GET requests run here; discovery never invokes a model. */
export async function probeModelCatalog(input: {
  provider: string;
  settings: Record<string, Json>;
  apiKey: string;
  signal?: AbortSignal;
}): ReturnType<RuntimePort["testConnection"]> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  try {
    signal.throwIfAborted();
    const probe = providerProbe(input.provider, input.settings, input.apiKey);
    if (!probe)
      return {
        ok: true,
        message:
          "Bedrock configuration is valid. The runtime endpoint does not offer model discovery; enter a model ID. Credentials are verified only when a run invokes that model.",
        resources: {
          models: [],
          modelDiscovery: "unavailable",
          credentialsVerified: false,
        },
      };
    const models: Json[] = [];
    const identifiers = new Set<string>();
    const cursors = new Set<string>();
    let remaining = MAX_CATALOG_BYTES;
    let cursor: string | undefined;
    for (let index = 0; index < MAX_PAGES; index++) {
      signal.throwIfAborted();
      const url = new URL(probe.url);
      if (input.provider === "anthropic") {
        // https://platform.claude.com/docs/en/api/models/list
        url.searchParams.set("limit", "1000");
        if (cursor) url.searchParams.set("after_id", cursor);
      }
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: probe.headers,
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogFailure(
          `The provider rejected model discovery (HTTP ${response.status}). No partial catalog was accepted.`,
        );
      }
      const { page, bytes } = await readPage(response, remaining);
      remaining -= bytes;
      signal.throwIfAborted();
      if (models.length + page.data.length > MAX_MODELS)
        throw new CatalogFailure(
          "Model discovery exceeded its model count limit. No partial catalog was accepted.",
        );
      for (const model of page.data) {
        if (identifiers.has(model.id))
          throw new CatalogFailure(
            "Model discovery returned duplicate model identifiers. No partial catalog was accepted.",
          );
        const name = model.name ?? model.display_name ?? model.id;
        if (
          input.apiKey.length > 3 &&
          (model.id.includes(input.apiKey) || name.includes(input.apiKey))
        )
          throw new CatalogFailure(
            "The provider returned an invalid model catalog. No partial catalog was accepted.",
          );
        identifiers.add(model.id);
        models.push({ id: model.id, name, provider: input.provider });
      }
      // Never follow returned links or invent pagination parameters for gateways.
      if (
        ["next", "next_page", "next_cursor", "nextPage", "nextCursor"].some(
          (key) =>
            page[key] !== undefined && page[key] !== null && page[key] !== "",
        ) ||
        /rel\s*=\s*"?next\b/i.test(response.headers.get("link") ?? "")
      )
        throw new CatalogFailure(
          "The provider returned unsupported model catalog pagination. No partial catalog was accepted.",
        );
      if (input.provider !== "anthropic") {
        if (page.has_more)
          throw new CatalogFailure(
            "The provider returned unsupported model catalog pagination. No partial catalog was accepted.",
          );
        return {
          ok: true,
          message:
            "The provider accepted the credentials and model discovery completed.",
          resources: {
            models,
            modelDiscovery: "complete",
            credentialsVerified: true,
          },
        };
      }
      if (typeof page.has_more !== "boolean")
        throw new CatalogFailure(
          "The provider omitted model catalog pagination status. No partial catalog was accepted.",
        );
      if (!page.has_more)
        return {
          ok: true,
          message:
            "The provider accepted the credentials and model discovery completed.",
          resources: {
            models,
            modelDiscovery: "complete",
            credentialsVerified: true,
          },
        };
      if (
        !page.last_id ||
        page.last_id !== page.data.at(-1)?.id ||
        cursors.has(page.last_id)
      )
        throw new CatalogFailure(
          "Model catalog pagination did not advance. No partial catalog was accepted.",
        );
      cursor = page.last_id;
      cursors.add(cursor);
    }
    throw new CatalogFailure(
      "Model discovery exceeded its page limit. No partial catalog was accepted.",
    );
  } catch (error) {
    const message = input.signal?.aborted
      ? "Model discovery was interrupted. No partial catalog was accepted."
      : timeout.aborted
        ? "Model discovery exceeded its time limit. No partial catalog was accepted."
        : error instanceof CatalogFailure
          ? error.message
          : error instanceof z.ZodError
            ? "The provider configuration is invalid."
            : `Model discovery did not complete${safeFetchFailureDetails(error)}. No partial catalog was accepted.`;
    return {
      ok: false,
      message,
      resources: {
        models: [],
        modelDiscovery: "failed",
        credentialsVerified: false,
      },
    };
  }
}
