import { useId, useState } from "react";
import { Help } from "./ui.js";

export interface JsonGuide {
  description: string;
  example: unknown;
  fields: ReadonlyArray<{
    key: string;
    description: string;
    values: string;
    default?: string;
  }>;
}

export function jsonInputError(
  value: string,
  validate?: (value: unknown) => void,
  shape: "object" | "array" = "object",
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (shape === "array" && !Array.isArray(parsed))
      return "Enter a JSON array enclosed in brackets: [].";
    if (
      shape === "object" &&
      (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    )
      return "Enter a JSON object enclosed in braces: {}.";
    validate?.(parsed);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter valid JSON.";
  }
}

export function JsonEditor({
  label,
  value,
  onChange,
  guide,
  validate,
  rows = 6,
  shape = "object",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  guide: JsonGuide;
  validate?: (value: unknown) => void;
  rows?: number;
  shape?: "object" | "array";
}) {
  const id = useId();
  const [copyStatus, setCopyStatus] = useState("");
  const error = jsonInputError(value, validate, shape);
  const example = JSON.stringify(guide.example, null, 2);
  return (
    <div className="json-editor stack">
      <div className="row">
        <p className="subtle" id={`${id}-description`}>
          {guide.description}
        </p>
        <Help
          label={`${label} JSON`}
          tooltip="View supported keys, defaults, and an example."
        >
          {guide.description}
          <pre className="json-view">{example}</pre>
        </Help>
      </div>
      <details className="disclosure json-reference">
        <summary>Supported settings and example</summary>
        <dl>
          {guide.fields.map((field) => (
            <div key={field.key}>
              <dt>
                <code>{field.key}</code>
              </dt>
              <dd>
                {field.description}{" "}
                <span className="subtle">
                  Values: {field.values}.
                  {field.default && ` Default: ${field.default}.`}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <pre className="json-view">{example}</pre>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (!navigator.clipboard?.writeText) {
              setCopyStatus(
                "Copy unavailable. Select and copy the example above.",
              );
              return;
            }
            void navigator.clipboard
              .writeText(example)
              .then(() => setCopyStatus("Example copied."))
              .catch(() =>
                setCopyStatus(
                  "Copy unavailable. Select and copy the example above.",
                ),
              );
          }}
        >
          Copy example
        </button>
        <span role="status" className="subtle">
          {copyStatus}
        </span>
      </details>
      <textarea
        aria-label={label}
        aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
        aria-invalid={!!error}
        className="code-input"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      {error && (
        <p id={`${id}-error`} className="warning" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
