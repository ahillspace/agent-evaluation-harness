import { useCallback, useEffect, useState } from "react";
import type {
  CommandInput,
  CommandName,
  CommandResultMap,
} from "../contracts.js";

export async function command<K extends CommandName>(
  operation: K,
  input: CommandInput<K>,
  signal?: AbortSignal,
): Promise<CommandResultMap[K]> {
  const response = await fetch(`/api/commands/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.message ?? `Request failed (${response.status}).`,
    );
  return body as CommandResultMap[K];
}

export function useResource<K extends CommandName>(
  operation: K,
  input: CommandInput<K>,
  interval?: number,
  enabled = true,
) {
  const key = JSON.stringify(input);
  const [data, setData] = useState<CommandResultMap[K] | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await command(
          operation,
          JSON.parse(key),
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setData(result);
          setLoadedKey(`${operation}:${key}`);
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      if (!controller.signal.aborted && interval)
        timer = setTimeout(() => {
          void load();
        }, interval);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [operation, key, version, interval, enabled]);
  return {
    data: enabled && loadedKey === `${operation}:${key}` ? data : null,
    error,
    refresh,
  };
}

export function navigate(path: string) {
  window.location.hash = path;
}
export function useRoute() {
  const [route, setRoute] = useState(
    () => window.location.hash.slice(1) || "/run",
  );
  useEffect(() => {
    const update = () => setRoute(window.location.hash.slice(1) || "/run");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
