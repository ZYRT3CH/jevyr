import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it("installs both aliases idempotently without replacing another launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevyr-installer-"));
  const launcher = join(directory, process.platform === "win32" ? "jevyr.cmd" : "jevyr");
  try {
    const install = () => exec(process.execPath, [join(root, "scripts/install-local-cli.mjs"), directory]);
    await install();
    const first = await readFile(launcher, "utf8");
    expect(first).toContain(join(root, "apps", "cli", "dist", "main.js"));
    expect(await readFile(join(directory, process.platform === "win32" ? "jevyr.cmd" : "jevyr"), "utf8")).toBe(first);
    await install();
    expect(await readFile(launcher, "utf8")).toBe(first);
    await writeFile(launcher, "unrelated launcher");
    await expect(install()).rejects.toThrow("not overwritten");
    expect(await readFile(launcher, "utf8")).toBe("unrelated launcher");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
