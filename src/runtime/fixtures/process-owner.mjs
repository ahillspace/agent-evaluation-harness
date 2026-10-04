import { createProcessSupervisor } from "../platform.ts";
const supervisor = createProcessSupervisor({ stateDirectory: process.argv[2] });
await supervisor.recover();
await supervisor.run({
  executable: process.execPath,
  cwd: process.argv[2],
  processLimit: 4,
  args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
  onLine(line) {
    process.stdout.write(`${line}\n`);
  },
});
