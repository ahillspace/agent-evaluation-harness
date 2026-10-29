const fetchFailureCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const fetchFailureNames = new Set([
  "AbortError",
  "TimeoutError",
  "TypeError",
  "FetchError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "RequestAbortedError",
]);

function errorField(value: unknown, key: string): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as unknown;
  }
  return undefined;
}

export function safeFetchDiagnostics(error: unknown): {
  names: string[];
  codes: string[];
} {
  const values = [error];
  const cause = errorField(error, "cause");
  if (cause !== undefined) values.push(cause);
  const names = new Set<string>();
  const codes = new Set<string>();
  for (const value of values) {
    const name = errorField(value, "name");
    if (typeof name === "string" && fetchFailureNames.has(name))
      names.add(name);
    const code = errorField(value, "code");
    if (typeof code === "string" && fetchFailureCodes.has(code))
      codes.add(code);
  }
  return { names: [...names], codes: [...codes] };
}

export function safeFetchFailureDetails(error: unknown): string {
  const diagnostic = safeFetchDiagnostics(error);
  const details = [
    ...diagnostic.names.map((name) => `name=${name}`),
    ...diagnostic.codes.map((code) => `code=${code}`),
  ];
  return details.length ? ` (${details.join(", ")})` : "";
}
