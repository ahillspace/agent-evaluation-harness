import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { commandSchemas, type RunView } from "../contracts.js";
import { command } from "./api.js";
import { ErrorNotice } from "./ui.js";

const pendingRecoverySchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("runs.retry-failed"),
      input: commandSchemas["runs.retry-failed"],
    })
    .strict(),
  z
    .object({
      operation: z.literal("runs.control"),
      input: commandSchemas["runs.control"].extend({
        action: z.literal("resume"),
        idempotencyKey: z.string().min(1).max(200),
      }),
    })
    .strict(),
]);
export type PendingRunRecovery = z.infer<typeof pendingRecoverySchema>;
type RecoveryState = {
  key?: string;
  request?: PendingRunRecovery;
  savedValue?: string;
  ready: boolean;
  error?: unknown;
};
function readPending(key: string | undefined, runId: string): RecoveryState {
  if (!key)
    return {
      ready: false,
      error: new Error(
        "Workspace identity is unavailable. Refresh before starting more work.",
      ),
    };
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(key);
    const request = saved
      ? pendingRecoverySchema.parse(JSON.parse(saved))
      : undefined;
    if (request && request.input.runId !== runId)
      throw new Error("Recovery request belongs to another Run.");
    return { key, request, savedValue: saved || undefined, ready: true };
  } catch {
    return {
      key,
      savedValue: saved || undefined,
      ready: false,
      error: new Error(
        saved
          ? "This tab cannot read its saved recovery request. Discard it only if you accept possible duplicate work."
          : "This tab cannot read its saved recovery request. Restore browser storage before starting more work.",
      ),
    };
  }
}

export function useRunRecovery({
  workspaceId,
  runId,
  onAcknowledged,
}: {
  workspaceId?: string;
  runId: string;
  onAcknowledged: (view: RunView) => void;
}) {
  const key = workspaceId
    ? `aeh.run-recovery.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(runId)}`
    : undefined;
  const [state, setState] = useState<RecoveryState>(() =>
    readPending(key, runId),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const acknowledged = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    mounted.current = true;
    setState(readPending(key, runId));
    return () => {
      mounted.current = false;
    };
  }, [key, runId]);
  const ready = state.key === key && state.ready;
  const perform = async (proposed?: PendingRunRecovery) => {
    if (busyRef.current || !key || !ready) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const stored = readPending(key, runId);
      setState(stored);
      if (!stored.ready) throw stored.error;
      if (proposed && stored.request)
        throw new Error(
          "Check the saved recovery request before starting more work.",
        );
      const request = stored.request ?? pendingRecoverySchema.parse(proposed);
      if (request.input.runId !== runId)
        throw new Error("Recovery request belongs to another Run.");
      try {
        sessionStorage.setItem(key, JSON.stringify(request));
      } catch {
        throw new Error(
          "This tab cannot save the recovery request. Restore browser storage before starting more work.",
        );
      }
      setState({
        key,
        ready: true,
        request,
        savedValue: JSON.stringify(request),
      });
      const result =
        request.operation === "runs.retry-failed"
          ? await command(request.operation, request.input)
          : await command(request.operation, request.input);
      if (result.run.id !== runId)
        throw new Error(
          "The recovery response does not match this Run. Check the saved request again.",
        );
      let cleanupError: Error | undefined;
      try {
        if (sessionStorage.getItem(key) === JSON.stringify(request))
          sessionStorage.removeItem(key);
      } catch {
        cleanupError = new Error(
          "Recovery was accepted, but this tab could not clear its saved request. Check the recovery request again before starting more work.",
        );
      }
      if (mounted.current && currentKey.current === key) {
        setState({
          key,
          ready: true,
          request: cleanupError ? request : undefined,
          savedValue: cleanupError ? JSON.stringify(request) : undefined,
          error: cleanupError,
        });
        const identity = JSON.stringify([
          key,
          request.operation,
          request.input.idempotencyKey,
        ]);
        if (acknowledged.current !== identity) {
          acknowledged.current = identity;
          onAcknowledged(result);
        }
      }
    } catch (error) {
      if (mounted.current && currentKey.current === key)
        setState((saved) => ({ ...saved, error }));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const discard = () => {
    if (busyRef.current || !key || state.key !== key || !state.savedValue)
      return;
    try {
      if (sessionStorage.getItem(key) !== state.savedValue) {
        setState({
          ...readPending(key, runId),
          error: new Error(
            "The saved recovery request changed. Review it before discarding it.",
          ),
        });
        return;
      }
      sessionStorage.removeItem(key);
      setState({ key, ready: true });
    } catch {
      setState((saved) => ({
        ...saved,
        error: new Error(
          "This tab could not discard its saved recovery request. Restore browser storage and try again.",
        ),
      }));
    }
  };
  return {
    request: state.key === key ? state.request : undefined,
    hasSavedRequest: state.key === key && !!state.savedValue,
    busy,
    ready,
    error: state.key === key ? state.error : undefined,
    submit: (request: PendingRunRecovery) => perform(request),
    replay: () => perform(),
    discard,
  };
}
export type RunRecovery = ReturnType<typeof useRunRecovery>;

export function RunRecoveryNotice({ recovery }: { recovery: RunRecovery }) {
  return (
    <>
      <ErrorNotice error={recovery.error} />
      {recovery.hasSavedRequest && (
        <div className="notice stack">
          <span>
            A saved recovery request needs confirmation before starting more
            work.{" "}
          </span>
          <div className="actions">
            {recovery.request && (
              <button
                className="button secondary"
                disabled={recovery.busy || !recovery.ready}
                onClick={() => {
                  void recovery.replay();
                }}
              >
                {recovery.busy
                  ? "Checking recovery request..."
                  : "Check recovery request"}
              </button>
            )}
            <button
              className="button secondary"
              disabled={recovery.busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Discard this tab's saved recovery request? Previous work might have started. Starting another request can repeat remote work and incur additional usage.",
                  )
                )
                  recovery.discard();
              }}
            >
              Discard saved request
            </button>
          </div>
        </div>
      )}
    </>
  );
}
