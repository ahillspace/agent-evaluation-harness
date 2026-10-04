export interface SecretStore {
  allocate(): Promise<string>;
  owns(reference: string): Promise<boolean>;
  read(reference: string): Promise<string>;
  write(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export type SecretErrorCode =
  "missing" | "access_denied" | "unavailable" | "foreign_workspace" | "invalid";
export class SecretStoreError extends Error {
  constructor(
    readonly code: SecretErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}
