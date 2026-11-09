import { Component, type ReactNode } from "react";
import { Icon } from "./ui.js";

export function FatalError({ message }: { message: string }) {
  return (
    <main className="fatal-error" role="alert">
      <span className="eyebrow">
        <Icon name="shield" />
        Agent Evaluation Harness
      </span>
      <h1>The workspace could not display this screen</h1>
      <p>Your saved runs and evidence remain on the local engine.</p>
      <pre>{message}</pre>
      <button
        className="button primary"
        onClick={() => window.location.reload()}
      >
        Reload workspace
      </button>
      <a
        className="button secondary"
        href="#/runs"
        onClick={() => {
          window.location.hash = "/runs";
          window.location.reload();
        }}
      >
        Open runs
      </a>
    </main>
  );
}

export class AppBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <FatalError message={this.state.error.message} />
    ) : (
      this.props.children
    );
  }
}
