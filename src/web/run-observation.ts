import { useCallback, useEffect, useRef, useState } from "react";
import type { RunRecord, RunObservation, RunView } from "../contracts.js";
import { command } from "./api.js";

export function mergeRunObservation(
  original: RunRecord,
  update: RunObservation,
): RunView {
  return { ...update, run: { ...update.run, manifest: original.manifest } };
}

/** Bootstrap one frozen manifest, then refresh only current Run state. */
export function useRunObservation(runId: string) {
  const original = useRef<RunRecord | null>(null);
  const [loaded, setLoaded] = useState<{
    runId: string;
    data: RunView | null;
    error: Error | null;
  } | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (original.current?.id !== runId) original.current = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const frozen = original.current?.id === runId ? original.current : null;
        const next = frozen
          ? mergeRunObservation(
              frozen,
              await command("runs.observe", { runId }, controller.signal),
            )
          : await command("runs.get", { runId }, controller.signal);
        if (controller.signal.aborted) return;
        original.current = next.run;
        setLoaded({ runId, data: next, error: null });
      } catch (cause) {
        if (!controller.signal.aborted)
          setLoaded((previous) => ({
            runId,
            data: previous?.runId === runId ? previous.data : null,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }));
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void load();
        }, 1500);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, version]);
  return {
    data: loaded?.runId === runId ? loaded.data : null,
    error: loaded?.runId === runId ? loaded.error : null,
    refresh,
  };
}
