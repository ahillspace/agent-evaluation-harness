import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runSecretCommand, type RunSecretCommand } from "./native-command.js";
import { WorkspaceSecretScope } from "./scope.js";
import { SecretStoreError, type SecretStore } from "./store.js";

async function dpapi(
  value: string,
  operation: "Protect" | "Unprotect",
  command: RunSecretCommand = runSecretCommand,
): Promise<string> {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); try { ${operation === "Protect" ? "$bytes=[Text.Encoding]::UTF8.GetBytes($value); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))" : "$bytes=[Convert]::FromBase64String($value); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))"} } catch { exit 1 }`;
  const executable = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await command({
    executable,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    input: value,
  });
  if (result.code !== 0)
    throw new SecretStoreError(
      "access_denied",
      "Windows could not access this credential. Enter the credential again under the current Windows account.",
    );
  return result.stdout.replace(/^\uFEFF/, "");
}
export function decryptWindowsCredential(value: string): Promise<string> {
  return dpapi(value, "Unprotect");
}

export class WindowsSecretStore implements SecretStore {
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
  private async filename(reference: string): Promise<string> {
    const { directory } = await this.scope.require(reference);
    return path.join(directory, `${reference.split(":")[1]}.dpapi`);
  }
  async read(reference: string): Promise<string> {
    let encrypted: string;
    try {
      encrypted = await readFile(await this.filename(reference), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new SecretStoreError(
          "missing",
          "The saved Windows credential is missing. Enter the credential again.",
        );
      throw error;
    }
    return dpapi(encrypted, "Unprotect", this.command);
  }
  async write(reference: string, value: string): Promise<void> {
    const filename = await this.filename(reference);
    if (Buffer.byteLength(value) > 32 * 1024)
      throw new SecretStoreError(
        "invalid",
        "The credential exceeds the supported size.",
      );
    const encrypted = await dpapi(value, "Protect", this.command);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async delete(reference: string): Promise<void> {
    await rm(await this.filename(reference), { force: true });
  }
}
export function createWindowsSecretStore(directory: string): SecretStore {
  return new WindowsSecretStore(new WorkspaceSecretScope(directory));
}
