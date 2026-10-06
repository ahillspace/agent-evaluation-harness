import type { RunView } from "../contracts.js";
import { savedTarget, targetLabel } from "../contracts/targets.js";
import { useResource } from "./api.js";
import { DownloadButton, ErrorNotice, JsonView } from "./ui.js";

export function RunConfiguration({ view }: { view: RunView }) {
  const resource = useResource("runs.export-target", { runId: view.run.id });
  const { manifest } = view.run;
  const target = savedTarget(manifest);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Configuration</h2>
          <p>The settings saved when this run started.</p>
        </div>
        <div className="actions">
          <a className="button secondary" href={`#/run?source=${view.run.id}`}>
            Reuse configuration
          </a>
          {resource.data && (
            <DownloadButton
              filename={`${view.run.id}-agent.json`}
              value={resource.data}
            >
              Export target JSON
            </DownloadButton>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        <ErrorNotice error={resource.error} />
        <h3>{targetLabel(target)}</h3>
        <p className="subtle">
          {target.kind === "external"
            ? "The remote system controls its own prompts, models, and tools. This export describes the saved endpoint request."
            : "The export contains agent settings and credential placeholders. Questions and expected answers stay in this app."}
        </p>
        <JsonView
          value={resource.data ?? { status: "Loading saved configuration..." }}
        />
        <details className="disclosure">
          <summary>Question bank and evaluation settings</summary>
          <JsonView
            value={{
              bank: {
                id: manifest.bank.id,
                name: manifest.bank.name,
                revision: manifest.bank.number,
              },
              repetitions: manifest.repetitions,
              limits: manifest.limits,
              evaluator: manifest.evaluator,
              judge: manifest.judge,
              jevJudge: manifest.jevJudge,
              digest: manifest.digest,
            }}
          />
        </details>
      </div>
    </section>
  );
}
