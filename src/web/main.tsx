import { createRoot } from "react-dom/client";
import { useResource, useRoute } from "./api.js";
import { Banks } from "./banks.js";
import { Observe } from "./observe.js";
import { Results } from "./results.js";
import { Settings } from "./settings.js";
import { Setup } from "./setup.js";
import { ErrorNotice, Icon } from "./ui.js";
import "./styles.css";
import { AppBoundary } from "./error-boundary.js";

function App() {
  const route = useRoute();
  const [pathname = "/run", search = ""] = route.split("?");
  const params = new URLSearchParams(search);
  const resource = useResource("workspace.get", {}, 5000);
  const workspace = resource.data;
  const section = pathname.startsWith("/observe") ? "/run" : pathname;
  const nav = [
    { href: "/banks", icon: "bank", label: "Question banks" },
    { href: "/run", icon: "run", label: "Run" },
    { href: "/results", icon: "results", label: "Results" },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#/run"
          aria-label="Agent Evaluation Harness home"
        >
          <span className="brand-symbol">
            [<i />]
          </span>
          <span>
            Agent Evaluation<span>HARNESS</span>
          </span>
        </a>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <a
              key={item.href}
              href={`#${item.href}`}
              className={section === item.href ? "active" : ""}
              aria-current={section === item.href ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="#/settings"
            className={section === "/settings" ? "active" : ""}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </a>
          <div className="workspace-status">
            <i />
            Local workspace<span>Local engine</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span>Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {section === "/banks"
                ? "Question banks"
                : section === "/results"
                  ? "Results"
                  : section === "/settings"
                    ? "Settings"
                    : "Run"}
            </strong>
          </div>
          <span className="topbar-note">
            <Icon name="shield" size={14} />
            Evidence before conclusions
          </span>
        </header>
        <main className="main-content">
          <ErrorNotice error={resource.error} />
          {!workspace ? (
            <div className="loading">Opening your workspace...</div>
          ) : section === "/banks" ? (
            <Banks workspace={workspace} refresh={resource.refresh} />
          ) : pathname.startsWith("/observe/") ? (
            <Observe
              key={pathname}
              runId={pathname.slice("/observe/".length)}
              sessionId={params.get("session") ?? undefined}
              refreshWorkspace={resource.refresh}
            />
          ) : section === "/results" ? (
            <Results workspace={workspace} refresh={resource.refresh} />
          ) : section === "/settings" ? (
            <Settings workspace={workspace} refresh={resource.refresh} />
          ) : (
            <Setup
              key={route}
              workspace={workspace}
              refresh={resource.refresh}
              sourceRunId={params.get("source") ?? undefined}
              blueprintId={params.get("blueprint") ?? undefined}
            />
          )}
        </main>
        <footer className="app-footer">
          <span>Agent Evaluation Harness</span>
          <span>Local workspace · Immutable evaluation evidence</span>
        </footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
