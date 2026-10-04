import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WINDOWS_JOB_SOURCE } from "../windows-job.js";
import type {
  ProcessDriver,
  ProcessLaunch,
  ProcessScope,
} from "./contracts.js";

const executeFile = promisify(execFile);
export class WindowsProcessDriver implements ProcessDriver {
  readonly capabilities = { hardDescendantLimit: true };
  private readonly directory: string;
  private helper = "";
  constructor(stateDirectory: string) {
    this.directory = path.resolve(stateDirectory, "process-scopes");
  }
  async recover() {
    await mkdir(this.directory, { recursive: true });
    const digest = createHash("sha256")
      .update(WINDOWS_JOB_SOURCE)
      .digest("hex")
      .slice(0, 16);
    this.helper = path.join(this.directory, `scope-${digest}.exe`);
    if (!existsSync(this.helper)) {
      const source = path.join(this.directory, `scope-${digest}.cs`);
      await writeFile(source, WINDOWS_JOB_SOURCE);
      const compiler = path.join(
        process.env.SystemRoot ?? "C:/Windows",
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      );
      await executeFile(
        compiler,
        ["/nologo", "/target:exe", `/out:${this.helper}`, source],
        { windowsHide: true, timeout: 30_000 },
      );
    }
    let recovered = 0;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const filename = path.join(this.directory, name);
      const record: unknown = JSON.parse(await readFile(filename, "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        !("job" in record) ||
        typeof record.job !== "string" ||
        !/^Local\\AEH-[a-f0-9-]+$/.test(record.job)
      )
        throw new Error("Invalid process recovery record.");
      await this.drain(record.job);
      await unlink(filename);
      recovered++;
    }
    return { recovered };
  }
  private filename(id: string) {
    return path.join(this.directory, `${id}.json`);
  }
  private job(id: string) {
    return `Local\\AEH-${id}`;
  }
  private async drain(job: string) {
    await executeFile(this.helper, ["cleanup", job], {
      windowsHide: true,
      timeout: 10_000,
    });
  }
  async prepare(id: string) {
    await writeFile(this.filename(id), JSON.stringify({ job: this.job(id) }), {
      flag: "wx",
    });
  }
  async launch(input: ProcessLaunch): Promise<ProcessScope> {
    const child = spawn(
      this.helper,
      [
        String(process.pid),
        this.job(input.id),
        String(input.processLimit),
        input.cwd,
        input.executable,
        ...input.args,
      ],
      {
        cwd: input.cwd,
        env: input.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return {
      child,
      stop() {
        if (child.exitCode === null) child.kill();
      },
    };
  }
  async cleanup(id: string) {
    await this.drain(this.job(id));
    await unlink(this.filename(id));
  }
}
