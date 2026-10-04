import { runSecretCommand, type RunSecretCommand } from "./native-command.js";
import { WorkspaceSecretScope } from "./scope.js";
import { SecretStoreError, type SecretStore } from "./store.js";

const service = "com.agent-evaluation-harness.credentials.v1";
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly scope: WorkspaceSecretScope,
    private readonly command: RunSecretCommand = runSecretCommand,
  ) {}
  allocate() {
    return this.scope.allocate();
  }
  owns(reference: string) {
    return this.scope.owns(reference);
  }
  private failure(code: number): never {
    if (code === 44)
      throw new SecretStoreError(
        "missing",
        "The saved Keychain credential is missing. Enter the credential again.",
      );
    if ([36, 51, 128].includes(code))
      throw new SecretStoreError(
        "access_denied",
        "Keychain access was denied or requires interaction. Unlock the login Keychain and grant access, then retry.",
      );
    throw new SecretStoreError(
      "unavailable",
      "Keychain could not complete the request. Check login Keychain access and retry.",
    );
  }
  async read(reference: string): Promise<string> {
    const { account } = await this.scope.require(reference);
    const result = await this.command({
      executable: "/usr/bin/security",
      args: ["find-generic-password", "-s", service, "-a", account, "-w"],
    });
    if (result.code !== 0) this.failure(result.code);
    const encoded = result.stdout.trim();
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new SecretStoreError(
        "invalid",
        "The saved Keychain credential has an invalid format. Enter the credential again.",
      );
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  async write(reference: string, value: string): Promise<void> {
    const { account } = await this.scope.require(reference);
    if (!value.length)
      throw new SecretStoreError("invalid", "The credential cannot be empty.");
    if (Buffer.byteLength(value) > 32 * 1024)
      throw new SecretStoreError(
        "invalid",
        "The credential exceeds the supported size.",
      );
    const encoded = Buffer.from(value).toString("base64");
    // Interactive input keeps the password off argv. All tokens use a restricted alphabet.
    const input = `add-generic-password -s ${service} -a ${account} -w ${encoded}\n`;
    if (input.length > 4095)
      throw new SecretStoreError(
        "invalid",
        "The credential exceeds the Keychain command size limit.",
      );
    const result = await this.command({
      executable: "/usr/bin/security",
      args: ["-i"],
      input,
    });
    if (result.code !== 0) this.failure(result.code);
    // security's interactive shell can report command failure while returning zero.
    if ((await this.read(reference)) !== value)
      throw new SecretStoreError(
        "unavailable",
        "Keychain could not verify the saved credential.",
      );
  }
  async delete(reference: string): Promise<void> {
    const { account } = await this.scope.require(reference);
    const result = await this.command({
      executable: "/usr/bin/security",
      args: ["delete-generic-password", "-s", service, "-a", account],
    });
    if (result.code !== 0 && result.code !== 44) this.failure(result.code);
  }
}
export function createMacSecretStore(directory: string): SecretStore {
  return new KeychainSecretStore(new WorkspaceSecretScope(directory));
}
