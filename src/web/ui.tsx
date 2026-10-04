import { useId, useState, useEffect, useRef, type ReactNode } from "react";

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    bank: (
      <>
        <path d="M4 4h7v16H4zM14 4h6v16h-6zM7 8h1M17 8h1" />
      </>
    ),
    run: (
      <>
        <path d="m9 5 11 7-11 7zM4 5v14" />
      </>
    ),
    results: (
      <>
        <path d="M4 4v16h17M8 16v-5m5 5V7m5 9V4" />
      </>
    ),
    settings: (
      <>
        <path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-10h6" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4 10-10" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    agent: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="4" />
        <path d="M12 3v4M8 13h.01M16 13h.01M9 17h6" />
      </>
    ),
    tool: (
      <>
        <path d="m14 6 4 4M3 21l9-9M14 3a6 6 0 0 0-5 8l4 4a6 6 0 0 0 8-5l-4 1-4-4z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.run}
    </svg>
  );
}

export function Help({
  label,
  children,
  tooltip,
}: {
  label: string;
  children: ReactNode;
  tooltip?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="help">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-describedby={id}
        aria-label={`About ${label}`}
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      <span id={id} className="help-popover" role="tooltip">
        {tooltip ?? children}
      </span>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          <div className="help-body">{children}</div>
          <button className="button primary" onClick={() => setOpen(false)}>
            Got it
          </button>
        </Modal>
      )}
    </span>
  );
}

export function Field({
  label,
  help,
  children,
  required,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div className="field">
      <div className="field-label">
        {label}
        {required && <span className="required">Required</span>}
        {help && <Help label={label}>{help}</Help>}
      </div>
      {children}
    </div>
  );
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number | null | undefined;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={value == null ? "metric-unknown" : ""}>
        {value ?? "Not recorded"}
      </strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <i />
      {title(value)}
    </span>
  );
}

export function title(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
export function number(value: number | null | undefined) {
  return value == null ? "Not recorded" : Intl.NumberFormat().format(value);
}
export function duration(value: number | null | undefined) {
  return value == null
    ? "Not recorded"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(1)} s`;
}
export function date(value: string | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
}
export function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export const controlHelp: Record<string, string> = {
  pause: "Finish the active question, then stop admitting new work.",
  halt: "Interrupt active work and preserve unfinished questions for Resume.",
  resume:
    "Continue unfinished questions with new attempts. Completed results stay saved.",
  cancel: "Interrupt work and end this run after cleanup finishes.",
};

export function ControlButtons({
  actions,
  onAction,
  pending,
}: {
  actions: readonly string[];
  onAction: (action: string) => void;
  pending?: string | null;
}) {
  return (
    <div className="actions">
      {actions.map((action) => (
        <button
          key={action}
          className={`button ${action === "resume" ? "primary" : action === "cancel" ? "danger" : "secondary"}`}
          title={controlHelp[action]}
          disabled={!!pending}
          onClick={() => onAction(action)}
        >
          {title(action)}
          {pending === action ? " requested..." : ""}
        </button>
      ))}
    </div>
  );
}

export function Empty({
  title: heading,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon name="run" size={26} />
      </div>
      <h2>{heading}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="notice error">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title: heading,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{heading}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

export function Modal({
  title: heading,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      )
      ?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const items = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
            );
            const first = items?.[0],
              last = items?.[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2 id={id}>{heading}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{json(value)}</pre>;
}
export function DownloadButton({
  filename,
  value,
  children = "Export JSON",
}: {
  filename: string;
  value: unknown;
  children?: ReactNode;
}) {
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([json(value)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button className="button secondary" onClick={download}>
      <Icon name="download" size={15} />
      {children}
    </button>
  );
}
