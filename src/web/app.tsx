import { useResource, useRoute } from "./api.js";
import { Banks } from "./banks.js";
import { Observe } from "./observe.js";
import { Runs } from "./runs.js";
import { Settings } from "./settings.js";
import { Setup } from "./setup.js";
import { ErrorNotice } from "./ui.js";
import { AppShell } from "./app-shell.js";

export function App() {
  const route = useRoute();
  const [path = "/runs", search = ""] = route.split("?");
  const pathname =
    path === "/run"
      ? "/runs/new"
      : path === "/results"
        ? "/runs"
        : path.startsWith("/observe/")
          ? `/runs/${path.slice("/observe/".length)}`
          : path;
  const params = new URLSearchParams(search);
  const resource = useResource("workspace.get", {}, 5000);
  const workspace = resource.data;
  const section = pathname.startsWith("/runs/")
    ? "/runs"
    : pathname.startsWith("/settings/")
      ? "/settings"
      : pathname;
  const setup = pathname === "/runs/new";
  const runId =
    !setup && pathname.startsWith("/runs/")
      ? pathname.slice("/runs/".length)
      : undefined;
  const sourceRunId = params.get("source") ?? undefined;
  const blueprintId = params.get("blueprint") ?? undefined;
  const sessionId = params.get("session") ?? undefined;
  const initialResultId = params.get("result") ?? undefined;
  const initialAssessmentId = params.get("score") ?? undefined;
  return (
    <AppShell
      section={section}
      location={setup ? "New run" : runId ? "Run details" : undefined}
      connected={!!workspace && !resource.error}
    >
      <ErrorNotice error={resource.error} />
      {!workspace ? (
        <div className="loading">Opening your workspace...</div>
      ) : section === "/banks" ? (
        <Banks workspace={workspace} refresh={resource.refresh} />
      ) : runId ? (
        <Observe
          key={JSON.stringify([
            runId,
            sessionId,
            initialResultId,
            initialAssessmentId,
          ])}
          runId={runId}
          sessionId={sessionId}
          refreshWorkspace={resource.refresh}
          workspace={workspace}
          initialResultId={initialResultId}
          initialAssessmentId={initialAssessmentId}
        />
      ) : section === "/settings" ? (
        <Settings workspace={workspace} refresh={resource.refresh} />
      ) : setup ? (
        <Setup
          key={JSON.stringify([
            workspace.workspaceId,
            sourceRunId,
            blueprintId,
          ])}
          workspace={workspace}
          refresh={resource.refresh}
          sourceRunId={sourceRunId}
          blueprintId={blueprintId}
        />
      ) : (
        <Runs workspace={workspace} refresh={resource.refresh} />
      )}
    </AppShell>
  );
}
