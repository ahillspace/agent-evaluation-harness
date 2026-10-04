import { spawn } from "node:child_process";
import type { ProcessLaunch } from "./contracts.js";
import { signalGroup } from "./posix-state.js";

// The group leader stays alive until cleanup, preserving its group identity.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  signalGroup(process.pid, "SIGTERM");
  setTimeout(() => signalGroup(process.pid, "SIGKILL"), 400);
};
// Preserve the leader identity until the watchdog applies group-wide escalation.
process.on("SIGTERM", () => {
  if (!process.connected) stop();
  else process.send?.({ type: "stop_requested" }, () => {});
});
process.on("SIGINT", () => {
  if (!process.connected) stop();
  else process.send?.({ type: "stop_requested" }, () => {});
});
process.on("disconnect", stop);
process.once("message", (message: { type: string; input: ProcessLaunch }) => {
  if (stopping || !process.connected || message.type !== "launch")
    return stop();
  const input = message.input;
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const complete = (code: number) => {
    if (process.connected) process.send?.({ type: "exit", code }, () => {});
    else stop();
  };
  child.once("error", () => complete(125));
  child.once("exit", (code) => complete(code ?? 130));
});
if (!process.connected) stop();
else process.send?.({ type: "ready", pid: process.pid }, () => {});
