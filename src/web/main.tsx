import { createRoot } from "react-dom/client";
import { useResource, useRoute } from "./api.js";
import { Banks } from "./banks.js";
import { Observe } from "./observe.js";
import { Results } from "./results.js";
import { Settings } from "./settings.js";
import { Setup } from "./setup.js";
import { ErrorNotice } from "./ui.js";
import "./styles.css";
import { AppBoundary } from "./error-boundary.js";
import { AppShell } from "./app-shell.js";

function App() {
  const route = useRoute();
  const [pathname = "/run", search = ""] = route.split("?");
  const params = new URLSearchParams(search);
  const resource = useResource("workspace.get", {}, 5000);
  const workspace = resource.data;
  const section = pathname.startsWith("/observe")
    ? "/run"
    : pathname.startsWith("/settings/")
      ? "/settings"
      : pathname;
  return (
    <AppShell
      section={section}
      observing={pathname.startsWith("/observe/")}
      connected={!!workspace && !resource.error}
    >
      <ErrorNotice error={resource.error} />
      {!workspace ? (
        <div className="loading">Opening your workspace...</div>
      ) : section === "/banks" ? (
        <Banks workspace={workspace} refresh={resource.refresh} />
      ) : pathname.startsWith("/observe/") ? (
        <Observe
          key={route}
          runId={pathname.slice("/observe/".length)}
          sessionId={params.get("session") ?? undefined}
          refreshWorkspace={resource.refresh}
          workspace={workspace}
          initialResultId={params.get("result") ?? undefined}
          initialAssessmentId={params.get("score") ?? undefined}
        />
      ) : section === "/results" ? (
        <Results workspace={workspace} refresh={resource.refresh} />
      ) : section === "/settings" ? (
        <Settings workspace={workspace} refresh={resource.refresh} />
      ) : (
        <Setup
          key={`${workspace.workspaceId ?? ""}:${route}`}
          workspace={workspace}
          refresh={resource.refresh}
          sourceRunId={params.get("source") ?? undefined}
          blueprintId={params.get("blueprint") ?? undefined}
        />
      )}
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
