import { copyFile, mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const source = new URL("../src/repository-test-controller-runner.mjs", import.meta.url);
const destination = new URL("../dist/repository-test-controller-runner.mjs", import.meta.url);
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await copyFile(source, destination);
assert.deepEqual(await readFile(destination), await readFile(source));
