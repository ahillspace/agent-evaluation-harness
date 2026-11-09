import type { RunView } from "../contracts.js";

export function RetryResults({ view }: { view: RunView }) {
  const retries = view.retryRuns ?? [];
  const applications = view.retryApplications ?? [];
  if (!view.run.retryOf && !retries.length && !applications.length) return null;
  return (
    <section className="retry-results" aria-label="Historical reruns">
      {view.run.retryOf && (
        <p>
          This historical rerun is linked to{" "}
          <a href={`#/runs/${view.run.retryOf.runId}`}>the original Run</a>.
        </p>
      )}
      {(retries.length > 0 || applications.length > 0) && (
        <details>
          <summary>Historical reruns</summary>
          <ul>
            {retries.map((retry) => (
              <li key={retry.runId}>
                <a href={`#/runs/${retry.runId}`}>{retry.name}</a>
              </li>
            ))}
            {applications.map((item) => (
              <li key={item.id}>
                {item.bindings.length} answer
                {item.bindings.length === 1 ? "" : "s"} from{" "}
                <a href={`#/runs/${item.retryRunId}`}>a historical rerun</a>.
                Earlier attempts and scores stay available.
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
