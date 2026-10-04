import { useState } from "react";
import type { Json } from "../contracts.js";
import { Help, JsonView } from "./ui.js";

export interface ToolChoice {
  name: string;
  description?: string;
  inputSchema?: Json;
}
export function parseToolCatalog(value: Json | undefined): ToolChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item !== null &&
    !Array.isArray(item) &&
    typeof item === "object" &&
    typeof item.name === "string"
      ? [
          {
            name: item.name,
            ...(typeof item.description === "string"
              ? { description: item.description }
              : {}),
            ...(item.inputSchema !== undefined
              ? { inputSchema: item.inputSchema }
              : {}),
          },
        ]
      : [],
  );
}
export function toolSummary(description = "") {
  const text = description.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
export function ToolCatalog({
  tools,
  selected,
  onChange,
}: {
  tools: ToolChoice[];
  selected: string[];
  onChange: (names: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = tools.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="stack">
      <input
        aria-label="Search available tools"
        placeholder="Search available tools"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="row">
        <span className="subtle">
          {matches.length} tools · {selected.length} selected
        </span>
        <div className="actions">
          <button
            className="text-button"
            onClick={() =>
              onChange([
                ...new Set([...selected, ...matches.map((tool) => tool.name)]),
              ])
            }
          >
            {query ? "Select matching" : "Select all"}
          </button>
          <button className="text-button" onClick={() => onChange([])}>
            Clear selection
          </button>
        </div>
      </div>
      <div className="selection-list tool-catalog">
        {matches.map((tool) => (
          <div className="tool-row" key={tool.name}>
            <div>
              <label className="check-row">
                <input
                  aria-label={`Allow ${tool.name}`}
                  type="checkbox"
                  checked={selected.includes(tool.name)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, tool.name]
                        : selected.filter((name) => name !== tool.name),
                    )
                  }
                />
                <strong>{tool.name}</strong>
              </label>
              <p>
                {toolSummary(tool.description) || "No description provided."}
              </p>
            </div>
            <Help
              label={tool.name}
              tooltip={
                toolSummary(tool.description) ||
                "View tool details and input schema."
              }
            >
              <div className="tool-details">
                <p>{tool.description ?? "No description provided."}</p>
                {tool.inputSchema && (
                  <>
                    <h3>Input schema</h3>
                    <JsonView value={tool.inputSchema} />
                  </>
                )}
              </div>
            </Help>
          </div>
        ))}
      </div>
    </div>
  );
}
