import { spawn } from "node:child_process";
import { SecretStoreError } from "./store.js";

export interface NativeSecretCommand {
  executable: string;
  args: string[];
  input?: string;
}
export type RunSecretCommand = (
  command: NativeSecretCommand,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Native credential utilities never inherit provider settings or expose their diagnostic output. */
export const runSecretCommand: RunSecretCommand = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      windowsHide: true,
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: SecretStoreError | undefined;
    const stop = (message: string) => {
      failure ??= new SecretStoreError("unavailable", message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () =>
        stop(
          "Credential storage timed out. Unlock your credential store and retry.",
        ),
      10_000,
    );
    const collect = (data: Buffer, output: "stdout" | "stderr") => {
      bytes += data.length;
      if (bytes > 256 * 1024)
        return stop("Credential storage returned an invalid response.");
      if (output === "stdout") stdout.push(data);
      else stderr.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => collect(data, "stderr"));
    child.stdin.on("error", () => {
      /* Process completion reports native failures without input disclosure. */
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new SecretStoreError(
          "unavailable",
          "The operating system credential utility could not start.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    child.stdin.end(command.input ?? "");
  });
