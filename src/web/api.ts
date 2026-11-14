import { useCallback, useEffect, useState } from "react";
import type {
  CommandInput,
  CommandName,
  CommandResultMap,
} from "../contracts.js";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

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
    throw new CommandError(
      body.error?.message ?? `Request failed (${response.status}).`,
      response.status,
      body.error?.code,
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
  const [failedKey, setFailedKey] = useState("");
  const [version, setVersion] = useState(0);
  const requestKey = `${operation}:${key}:${version}`;
  const [requestState, setRequestState] = useState({
    key: "",
    loading: false,
  });
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setRequestState({ key: requestKey, loading: true });
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
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setFailedKey(`${operation}:${key}`);
        }
      } finally {
        if (!controller.signal.aborted)
          setRequestState({ key: requestKey, loading: false });
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
  }, [operation, key, requestKey, interval, enabled]);
  return {
    data: enabled && loadedKey === `${operation}:${key}` ? data : null,
    error: enabled && failedKey === `${operation}:${key}` ? error : null,
    loading:
      enabled && (requestState.key !== requestKey || requestState.loading),
    refresh,
  };
}

export function navigate(path: string) {
  window.location.hash = path;
}
export function useRoute() {
  const [route, setRoute] = useState(
    () => window.location.hash.slice(1) || "/runs",
  );
  useEffect(() => {
    const update = () => setRoute(window.location.hash.slice(1) || "/runs");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
