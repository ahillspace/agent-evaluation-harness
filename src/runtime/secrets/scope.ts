import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SecretStoreError } from "./store.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Registration lives outside transferable workspaces and binds secrets to their canonical location. */
export class WorkspaceSecretScope {
  private registration?: Promise<{ id: string; directory: string }>;
  constructor(
    private readonly workspace: string,
    private readonly localDirectory = path.join(
      homedir(),
      ".agent-evaluation-harness",
      "credentials",
    ),
  ) {}
  private identity(): Promise<{ id: string; directory: string }> {
    this.registration ??= this.register().catch((error: unknown) => {
      this.registration = undefined;
      throw error;
    });
    return this.registration;
  }
  private async register() {
    await mkdir(this.workspace, { recursive: true });
    const canonical = await realpath(this.workspace);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const directory = path.join(this.localDirectory, digest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "registration");
    const temporary = path.join(directory, `${randomUUID()}.registration`);
    try {
      await writeFile(temporary, randomUUID(), { flag: "wx", mode: 0o600 });
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    const id = await readFile(filename, "utf8");
    if (!uuid.test(id))
      throw new SecretStoreError(
        "invalid",
        "Credential registration is invalid. Restore the local credential registration before continuing.",
      );
    return { id, directory };
  }
  async allocate(): Promise<string> {
    return `${(await this.identity()).id}:${randomUUID()}`;
  }
  async owns(reference: string): Promise<boolean> {
    const [scope, item, extra] = reference.split(":");
    return (
      extra === undefined &&
      Boolean(item && uuid.test(item)) &&
      scope === (await this.identity()).id
    );
  }
  async require(
    reference: string,
  ): Promise<{ account: string; directory: string }> {
    if (!(await this.owns(reference)))
      throw new SecretStoreError(
        "foreign_workspace",
        "This workspace has no access to the saved credential. Enter the credential again on this machine.",
      );
    return { account: reference, directory: (await this.identity()).directory };
  }
}
