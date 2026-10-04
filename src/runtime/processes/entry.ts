import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export function processEntry(name: "posix-watchdog" | "posix-runner") {
  const source = fileURLToPath(
    new URL(
      `./${name}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  return {
    source,
    args: [
      ...(source.endsWith(".ts")
        ? [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
          ]
        : []),
      source,
    ],
  };
}
