import type { RuntimeCatalog, Json } from "../contracts.js";
import { useResource } from "./api.js";

export function credentialModels(
  resources: Json | undefined,
  harness: string,
  provider: string,
) {
  if (
    !resources ||
    typeof resources !== "object" ||
    Array.isArray(resources) ||
    !Array.isArray(resources.models)
  )
    return [];
  return resources.models.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string"
    )
      return [];
    return [
      {
        id:
          harness === "opencode" && !item.id.startsWith(`${provider}/`)
            ? `${provider}/${item.id}`
            : item.id,
        name: typeof item.name === "string" ? item.name : item.id,
        provider,
      },
    ];
  });
}

/** useResource binds every response to its request key and cancels replaced requests. */
export function useRoleCatalog(
  catalog: RuntimeCatalog | undefined,
  harness: string,
  connectionId: string,
  provider: string,
  enabled: boolean,
) {
  const resource = useResource(
    "connections.test",
    { connectionId },
    undefined,
    enabled && !!connectionId,
  );
  return {
    catalog:
      !connectionId || !catalog
        ? catalog
        : {
            ...catalog,
            harnesses: catalog.harnesses.map((item) =>
              item.id === harness
                ? {
                    ...item,
                    models: credentialModels(
                      resource.data?.resources,
                      harness,
                      provider,
                    ),
                  }
                : item,
            ),
          },
    error:
      resource.error ??
      (resource.data && !resource.data.ok
        ? new Error(resource.data.message)
        : undefined),
    refresh: resource.refresh,
  };
}
