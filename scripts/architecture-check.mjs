import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowed = {
  contracts: new Set(["contracts"]),
  domain: new Set(["contracts", "domain"]),
  storage: new Set(["contracts", "domain", "storage"]),
  evaluation: new Set(["contracts", "domain", "evaluation"]),
  application: new Set([
    "contracts",
    "domain",
    "storage",
    "evaluation",
    "application",
  ]),
  runtime: new Set(["contracts", "runtime"]),
  web: new Set(["contracts", "web"]),
  cli: new Set(["contracts", "transport"]),
  transport: new Set(["contracts", "transport"]),
  composition: new Set([
    "contracts",
    "domain",
    "storage",
    "evaluation",
    "application",
    "runtime",
    "transport",
  ]),
};

function zone(file) {
  if (file === "src/contracts.ts" || file.startsWith("src/contracts/"))
    return "contracts";
  if (file === "src/server.ts") return "composition";
  if (file === "src/cli.ts") return "cli";
  if (file === "src/transport-client.ts") return "transport";
  const folder = file.split("/")[1];
  return Object.hasOwn(allowed, folder) ? folder : undefined;
}

function runtimeBoundary(file, dependency) {
  const secrets = "src/runtime/secrets/";
  const processes = "src/runtime/processes/";
  const isProcess =
    dependency.startsWith(processes) ||
    dependency === "src/runtime/process-supervisor.ts" ||
    dependency === "src/runtime/windows-job.ts";
  if (file.startsWith(secrets) && isProcess)
    return "Credential infrastructure cannot depend on process ownership.";
  if (file.startsWith(processes) && dependency.startsWith(secrets))
    return "Process infrastructure cannot depend on credential storage.";
  if (
    /^src\/runtime\/connection(?:s|-storage|-migration)\.ts$/.test(file) &&
    isProcess
  )
    return "Connection services cannot depend on process ownership.";
  if (
    file === "src/runtime/process-supervisor.ts" &&
    dependency.startsWith("src/runtime/") &&
    !["src/runtime/commands.ts", "src/runtime/processes/contracts.ts"].includes(
      dependency,
    )
  )
    return "The shared coordinator can depend only on command resolution and process contracts.";
  const concrete =
    (dependency.startsWith(processes) &&
      dependency !== `${processes}contracts.ts`) ||
    (dependency.startsWith(secrets) && dependency !== `${secrets}store.ts`) ||
    dependency === "src/runtime/windows-job.ts";
  if (
    concrete &&
    file !== "src/runtime/platform.ts" &&
    !file.startsWith(processes) &&
    !file.startsWith(secrets)
  )
    return "Platform implementations belong inside infrastructure and runtime composition.";
  if (
    dependency === "src/runtime/platform.ts" &&
    file !== "src/runtime/index.ts"
  )
    return "Only runtime composition can select platform services.";
}

/** Check source ownership using syntax nodes, including re-exports and dynamic imports. */
export function inspectSource(file, source) {
  file = file.replaceAll("\\", "/");
  const owner = zone(file);
  if (!owner)
    return [
      `${file}: Unclassified production module. Assign an explicit architectural owner.`,
    ];
  const failures = [];
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const report = (node, message) => {
    const line =
      parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    failures.push(`${file}:${line}: ${message}`);
  };
  const inspectImport = (node, expression) => {
    if (!expression || !ts.isStringLiteralLike(expression)) {
      report(
        node,
        "A computed import bypasses ownership checks. Use a literal module specifier.",
      );
      return;
    }
    const specifier = expression.text;
    if (/tableau-mcp-autoresearch|@tableau-autoresearch\//i.test(specifier)) {
      report(
        node,
        "The previous repository is reference material, not a dependency.",
      );
      return;
    }
    if (specifier.startsWith(".")) {
      const resolved = path.posix
        .normalize(path.posix.join(path.posix.dirname(file), specifier))
        .replace(/\.(?:m?js|jsx)$/, ".ts");
      if (!resolved.startsWith("src/")) {
        report(node, "Production code cannot import outside src.");
        return;
      }
      const dependency = zone(resolved);
      if (!dependency)
        report(node, `Import has no architectural owner: ${specifier}`);
      else if (!allowed[owner].has(dependency))
        report(node, `${owner} cannot import ${dependency}: ${specifier}`);
      if (owner === "runtime") {
        const violation = runtimeBoundary(file, resolved);
        if (violation) report(node, violation);
      }
      return;
    }
    if (
      specifier.startsWith("/") ||
      /^[a-z]:[\\/]/i.test(specifier) ||
      specifier.startsWith("file:")
    ) {
      report(
        node,
        "Absolute filesystem imports make the repository non-portable.",
      );
      return;
    }
    if (owner === "contracts" && specifier !== "zod")
      report(
        node,
        "Contracts may depend only on their own declarations and zod.",
      );
    if (
      owner === "web" &&
      (specifier.startsWith("node:") || builtinModules.includes(specifier))
    ) {
      report(
        node,
        "Presentation cannot access Node APIs. Use an application command or query.",
      );
    }
  };
  const visit = (node) => {
    if (
      owner === "runtime" &&
      !["src/runtime/platform.ts", "src/runtime/commands.ts"].includes(file)
    ) {
      const platformProperty =
        ts.isPropertyAccessExpression(node) &&
        node.expression.getText(parsed) === "process" &&
        node.name.text === "platform";
      const platformElement =
        ts.isElementAccessExpression(node) &&
        node.expression.getText(parsed) === "process" &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "platform";
      const osImport =
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        ["node:os", "os"].includes(node.moduleSpecifier.text) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((item) =>
          ["platform", "type"].includes((item.propertyName ?? item.name).text),
        );
      if (platformProperty || platformElement || osImport)
        report(
          node,
          "Operating system selection belongs in platform composition or executable resolution.",
        );
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) inspectImport(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspectImport(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      inspectImport(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return failures;
}

export async function checkArchitecture(root) {
  const failures = [];
  let checked = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|spec)\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        failures.push(
          ...inspectSource(
            path.relative(root, fullPath),
            await readFile(fullPath, "utf8"),
          ),
        );
        checked += 1;
      }
    }
  }
  await walk(path.join(root, "src"));
  return { checked, failures };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { checked, failures } = await checkArchitecture(root);
  if (failures.length) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Architecture boundaries passed for ${checked} production modules.\n`,
    );
}
