import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KeychainSecretStore } from "./keychain.js";
import { WorkspaceSecretScope } from "./scope.js";
import { SecretStoreError } from "./store.js";
import { runSecretCommand } from "./native-command.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function scope(name = "workspace") {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-keychain-"));
  directories.push(directory);
  const workspace = path.join(directory, name);
  await mkdir(workspace);
  return {
    directory,
    workspace,
    scope: new WorkspaceSecretScope(workspace, path.join(directory, "local")),
  };
}
it("binds opaque references to a local workspace registration", async () => {
  const fixture = await scope();
  const reference = await fixture.scope.allocate();
  expect(await fixture.scope.owns(reference)).toBe(true);
  const reopened = new WorkspaceSecretScope(
    fixture.workspace,
    path.join(fixture.directory, "local"),
  );
  expect(await reopened.owns(reference)).toBe(true);
  const copy = path.join(fixture.directory, "copy");
  await mkdir(copy);
  expect(
    await new WorkspaceSecretScope(
      copy,
      path.join(fixture.directory, "local"),
    ).owns(reference),
  ).toBe(false);
  expect(
    await new WorkspaceSecretScope(
      fixture.workspace,
      path.join(fixture.directory, "other-machine"),
    ).owns(reference),
  ).toBe(false);
});

it("shares a complete registration across concurrent initializers", async () => {
  const fixture = await scope();
  const scopes = Array.from(
    { length: 20 },
    () =>
      new WorkspaceSecretScope(
        fixture.workspace,
        path.join(fixture.directory, "local"),
      ),
  );
  const references = await Promise.all(scopes.map((item) => item.allocate()));
  expect(
    new Set(references.map((reference) => reference.split(":")[0])).size,
  ).toBe(1);
});
it("sends encoded Keychain secrets only through stdin and verifies writes", async () => {
  const fixture = await scope();
  const secret = 'secret\n"; delete-generic-password -s other\nUnicode: 🦊';
  const encoded = Buffer.from(secret).toString("base64");
  const command = vi
    .fn()
    .mockResolvedValueOnce({ code: 0, stdout: "security> ", stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: `${encoded}\n`, stderr: "" });
  const store = new KeychainSecretStore(fixture.scope, command);
  const reference = await store.allocate();
  await store.write(reference, secret);
  expect(command.mock.calls[0]?.[0]).toMatchObject({
    executable: "/usr/bin/security",
    args: ["-i"],
  });
  expect(command.mock.calls[0]?.[0].input).toContain(encoded);
  expect(
    JSON.stringify(command.mock.calls.map(([call]) => call.args)),
  ).not.toContain(secret);
  expect(command.mock.calls[0]?.[0].input.split("\n")).toHaveLength(2);
});
it("sanitizes Keychain failures and preserves typed recovery errors", async () => {
  const fixture = await scope();
  const command = vi.fn().mockResolvedValue({
    code: 36,
    stdout: "",
    stderr: "secret denied sensitive detail",
  });
  const store = new KeychainSecretStore(fixture.scope, command);
  const reference = await store.allocate();
  await expect(store.read(reference)).rejects.toMatchObject({
    code: "access_denied",
  });
  await expect(store.read(reference)).rejects.not.toThrow("sensitive detail");
  command.mockResolvedValue({ code: 44, stdout: "", stderr: "" });
  await expect(store.read(reference)).rejects.toMatchObject({
    code: "missing",
  });
  await expect(store.delete(reference)).resolves.toBeUndefined();
  await expect(store.delete("foreign:entry")).rejects.toBeInstanceOf(
    SecretStoreError,
  );
});

it("rejects oversized interactive commands before starting Keychain", async () => {
  const fixture = await scope();
  const command = vi.fn();
  const store = new KeychainSecretStore(fixture.scope, command);
  await expect(
    store.write(await store.allocate(), "x".repeat(4000)),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(command).not.toHaveBeenCalled();
});

it("rejects an empty credential before starting an interactive password request", async () => {
  const fixture = await scope();
  const command = vi.fn();
  const store = new KeychainSecretStore(fixture.scope, command);
  await expect(store.write(await store.allocate(), "")).rejects.toMatchObject({
    code: "invalid",
  });
  expect(command).not.toHaveBeenCalled();
});

it("bounds native output and never includes native diagnostics in errors", async () => {
  await expect(
    runSecretCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('private'.repeat(100000));"],
      input: "secret",
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    runSecretCommand({
      executable: path.join(tmpdir(), "aeh-missing-credential-utility"),
      args: [],
      input: "secret",
    }),
  ).rejects.not.toThrow("secret");
});

it.skipIf(process.platform !== "darwin")(
  "round-trips the native login Keychain and removes its fixture",
  async () => {
    const fixture = await scope();
    const store = new KeychainSecretStore(fixture.scope);
    const reference = await store.allocate();
    try {
      await store.write(reference, "fixture credential 🦊\nwith spaces");
      expect(await store.read(reference)).toBe(
        "fixture credential 🦊\nwith spaces",
      );
    } finally {
      await store.delete(reference);
    }
  },
  30_000,
);
