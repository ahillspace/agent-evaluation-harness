import { useState } from "react";
import type { ConnectionResource } from "../contracts.js";
import { useResource } from "./api.js";
import { ErrorNotice, Field } from "./ui.js";

export function ConnectionResources({
  connectionId,
  selected,
  onChange,
}: {
  connectionId: string;
  selected?: ConnectionResource;
  onChange: (resource: ConnectionResource | undefined) => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const catalog = useResource("connections.resources", {
    connectionId,
    page,
    pageSize: 100,
    ...(query ? { search: query } : {}),
  });
  const choices = catalog.data?.resources ?? [];
  const label = (resource: ConnectionResource) =>
    resource.projectName
      ? `${resource.name} / ${resource.projectName}`
      : resource.name;
  return (
    <>
      <Field
        label="Datasource"
        help="Choose a published datasource visible to this connection. This guides the agent and does not restrict access."
      >
        <select
          aria-label="Datasource"
          value={selected?.id ?? ""}
          onChange={(event) =>
            onChange(choices.find((item) => item.id === event.target.value))
          }
        >
          <option value="">No datasource guidance</option>
          {selected && !choices.some((item) => item.id === selected.id) && (
            <option value={selected.id}>{label(selected)}</option>
          )}
          {choices.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {label(resource)}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNotice error={catalog.error} />
      {!catalog.data && !catalog.error && (
        <p className="subtle" role="status">
          Loading accessible datasources...
        </p>
      )}
      {!catalog.error && catalog.data?.resources.length === 0 && (
        <p className="subtle" role="status">
          {query
            ? "No datasources match this exact name. Clear search to browse."
            : "No published datasources are visible to this connection."}
        </p>
      )}
      <details className="disclosure">
        <summary>Find another datasource</summary>
        <Field
          label="Exact datasource name"
          help="Tableau searches complete names. Clear search to browse names containing commas or ampersands."
        >
          <input
            aria-label="Exact datasource name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setQuery(search.trim());
                setPage(1);
                catalog.refresh();
              }
            }}
          />
        </Field>
        <div className="actions">
          <button
            className="button secondary"
            onClick={() => {
              setQuery(search.trim());
              setPage(1);
              catalog.refresh();
            }}
          >
            Find datasource
          </button>
          {query && (
            <button
              className="button secondary"
              onClick={() => {
                setSearch("");
                setQuery("");
                setPage(1);
              }}
            >
              Clear search
            </button>
          )}
          <button
            className="button secondary"
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous page
          </button>
          <button
            className="button secondary"
            disabled={!catalog.data?.nextPage}
            onClick={() => setPage(catalog.data!.nextPage!)}
          >
            Next page
          </button>
        </div>
        {catalog.data && (
          <p className="subtle">
            Page {page} - {catalog.data.total} accessible datasources
            {query ? " matching this name" : ""}.
          </p>
        )}
      </details>
    </>
  );
}
