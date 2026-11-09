import type { ReactNode } from "react";
import { Icon } from "./ui.js";
import { buildId } from "./build.js";

const destinations = [
  { href: "/banks", icon: "bank", label: "Question banks" },
  { href: "/runs", icon: "run", label: "Runs" },
  { href: "/settings", icon: "settings", label: "Settings" },
];
const buildLabel =
  buildId === "development"
    ? buildId
    : new Date(buildId).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

export function AppShell({
  section,
  location,
  connected,
  children,
}: {
  section: string;
  location?: "New run" | "Run details";
  connected: boolean;
  children: ReactNode;
}) {
  const current =
    destinations.find((item) => item.href === section)?.label ?? "Runs";
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            ae
          </span>
          <span>
            Agent evaluation<span>Local workspace</span>
          </span>
        </div>
        <div className="nav-caption">Workspace</div>
        <nav aria-label="Main navigation">
          {destinations.map((item) => (
            <a
              key={item.href}
              href={`#${item.href}`}
              aria-label={item.label}
              aria-current={section === item.href ? "page" : undefined}
              className={`${section === item.href ? "active" : ""}${item.href === "/settings" ? " settings-link" : ""}`}
              title={item.label}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div
            className={`workspace-status ${connected ? "connected" : "disconnected"}`}
          >
            <i aria-hidden="true" />
            {connected ? "Engine connected" : "Engine unavailable"}
            <span>Workspace saved locally</span>
            <span className="build-identity" title={buildId}>
              Build {buildLabel}
            </span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar" aria-label="Current location">
          <div>
            <span>Workspace</span>
            <span className="breadcrumb-slash" aria-hidden="true">
              /
            </span>
            {location ? <a href="#/runs">Runs</a> : <strong>{current}</strong>}
            {location && (
              <>
                <span className="breadcrumb-slash" aria-hidden="true">
                  /
                </span>
                <strong>{location}</strong>
              </>
            )}
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
