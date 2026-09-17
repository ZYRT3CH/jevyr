import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const verifier = join(directory, "filesystem-manifest.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jevyr-fs-manifest-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function pathsFile(root, paths) {
  const destination = join(root, ".git", "tracked.paths");
  const chunks = paths.map((path) => Buffer.concat([Buffer.from(path), Buffer.from([0])]));
  writeFileSync(destination, Buffer.concat(chunks));
  return destination;
}

function run(args, succeeds = true) {
  const result = spawnSync(process.execPath, [verifier, ...args], { encoding: "utf8" });
  if (succeeds) {
    assert.equal(result.status, 0, result.stderr);
  } else {
    assert.notEqual(result.status, 0, "filesystem verifier unexpectedly succeeded");
  }
  return result;
}

test("Git tree conversion preserves raw paths and explicitly rejects absent submodules", () => {
  const root = fixture();
  try {
    const objectId = "a".repeat(40);
    const rawPath = Buffer.from("line\nbreak.txt");
    const tree = join(root, ".git", "tree.entries");
    const paths = join(root, ".git", "from-tree.paths");
    writeFileSync(tree, Buffer.concat([
      Buffer.from(`100644 blob ${objectId}\t`),
      rawPath,
      Buffer.from([0]),
    ]));
    run(["paths-from-tree", tree, paths]);
    assert.deepEqual(readFileSync(paths), Buffer.concat([rawPath, Buffer.from([0])]));

    const submoduleTree = join(root, ".git", "submodule.entries");
    writeFileSync(submoduleTree, Buffer.from(`160000 commit ${objectId}\tvendor/dependency\0`));
    const result = run(["paths-from-tree", submoduleTree, join(root, ".git", "submodule.paths")], false);
    assert.match(result.stderr, /submodule .* unsupported/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("path-list entry bounds fail before filesystem inspection", () => {
  const root = fixture();
  try {
    const paths = Array.from({ length: 100_001 }, (_, index) => `missing-${index}`);
    const list = pathsFile(root, paths);
    const result = run(["capture", root, list, join(root, ".git", "oversized.json"), "tracked"], false);
    assert.match(result.stderr, /100000-entry limit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracked closure binds bytes, modes, and hard-link identity while permitting build output", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "src", "main.js"), "export {};\n");
    const list = pathsFile(root, ["package.json", "src/main.js"]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "tracked"]);
    run(["verify", root, manifest]);

    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "main.js"), "generated\n");
    run(["verify", root, manifest]);

    writeFileSync(join(root, "src", "main.js"), "mutated bytes\n");
    run(["verify", root, manifest], false);
    writeFileSync(join(root, "src", "main.js"), "export {};\n");
    run(["verify", root, manifest]);

    if (process.platform !== "win32") {
      chmodSync(join(root, "src", "main.js"), 0o755);
      run(["verify", root, manifest], false);
      chmodSync(join(root, "src", "main.js"), 0o644);
      run(["verify", root, manifest]);
    }

    linkSync(join(root, "package.json"), join(root, "package.alias"));
    run(["verify", root, manifest], false);
    unlinkSync(join(root, "package.alias"));
    run(["verify", root, manifest]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete worktree closure rejects material outside the frozen commit but ignores Git metadata", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "subject.txt"), "frozen\n");
    const list = pathsFile(root, ["subject.txt"]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "complete-worktree"]);
    writeFileSync(join(root, ".git", "runtime-metadata"), "mutable\n");
    run(["verify", root, manifest]);
    mkdirSync(join(root, "untracked-empty"));
    run(["verify", root, manifest], false);
    rmSync(join(root, "untracked-empty"), { recursive: true, force: true });
    run(["verify", root, manifest]);
    writeFileSync(join(root, "untracked.txt"), "not frozen\n");
    run(["verify", root, manifest], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed authority subtree uses frozen membership rather than the mutable Git index", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, ".jevyr"));
    writeFileSync(join(root, ".jevyr", "policy.json"), "{}\n");
    writeFileSync(join(root, "README.md"), "runtime\n");
    const list = pathsFile(root, [".jevyr/policy.json", "README.md"]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "tracked"]);
    run(["contains-file", manifest, ".jevyr/policy.json"]);
    run(["contains-file", manifest, ".jevyr/config.json"], false);
    run(["verify-subtree", root, manifest, ".jevyr"]);

    writeFileSync(join(root, "generated.txt"), "allowed outside authority\n");
    run(["verify-subtree", root, manifest, ".jevyr"]);
    mkdirSync(join(root, ".jevyr", "empty-control"));
    run(["verify-subtree", root, manifest, ".jevyr"], false);
    rmSync(join(root, ".jevyr", "empty-control"), { recursive: true, force: true });
    run(["verify-subtree", root, manifest, ".jevyr"]);
    writeFileSync(join(root, ".jevyr", "config.json"), "{}\n");
    run(["verify-subtree", root, manifest, ".jevyr"], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed authority subtree distinguishes absence from an empty directory", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "README.md"), "runtime\n");
    const list = pathsFile(root, ["README.md"]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "tracked"]);
    run(["verify-subtree", root, manifest, ".jevyr"]);
    mkdirSync(join(root, ".jevyr"));
    run(["verify-subtree", root, manifest, ".jevyr"], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-build runtime closure freezes generated executables and hard-linked dependencies", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "dist", "daemon.js"), "serve();\n");
    writeFileSync(join(root, "node_modules", "store-object.js"), "dependency\n");
    linkSync(join(root, "node_modules", "store-object.js"), join(root, "node_modules", "dependency.js"));
    const manifest = join(root, ".git", "runtime.json");
    run(["capture-all", root, manifest]);
    run(["verify", root, manifest]);
    writeFileSync(join(root, "dist", "daemon.js"), "replaced();\n");
    run(["verify", root, manifest], false);
    writeFileSync(join(root, "dist", "daemon.js"), "serve();\n");
    run(["verify", root, manifest]);
    mkdirSync(join(root, "empty-runtime-directory"));
    run(["verify", root, manifest], false);
    rmSync(join(root, "empty-runtime-directory"), { recursive: true, force: true });
    run(["verify", root, manifest]);
    writeFileSync(join(root, "dist", "late.js"), "late mutation\n");
    run(["verify", root, manifest], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty commits and filenames containing newlines have unambiguous manifests", { skip: process.platform === "win32" }, () => {
  const empty = fixture();
  const root = fixture();
  try {
    const emptyList = pathsFile(empty, []);
    const emptyManifest = join(empty, ".git", "manifest.json");
    run(["capture", empty, emptyList, emptyManifest, "complete-worktree"]);
    run(["verify", empty, emptyManifest]);

    const name = "line\nbreak.txt";
    writeFileSync(join(root, name), "ambiguous only without NUL framing\n");
    const list = pathsFile(root, [name]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "complete-worktree"]);
    run(["verify", root, manifest]);
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).entries.length, 1);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbolic-link target text is committed without following the link", { skip: process.platform === "win32" }, () => {
  const root = fixture();
  const outside = fixture();
  try {
    writeFileSync(join(root, "target-a"), "a\n");
    writeFileSync(join(root, "target-b"), "b\n");
    symlinkSync("target-a", join(root, "current"));
    const list = pathsFile(root, ["current", "target-a", "target-b"]);
    const manifest = join(root, ".git", "manifest.json");
    run(["capture", root, list, manifest, "complete-worktree"]);
    run(["verify", root, manifest]);
    unlinkSync(join(root, "current"));
    symlinkSync("target-b", join(root, "current"));
    run(["verify", root, manifest], false);

    const internalTrackedList = pathsFile(root, ["current", "target-a", "target-b"]);
    const internalTrackedManifest = join(root, ".git", "internal-tracked.json");
    run(["capture", root, internalTrackedList, internalTrackedManifest, "tracked"]);
    run(["verify", root, internalTrackedManifest]);

    const runtimeManifest = join(root, ".git", "runtime.json");
    run(["capture-all", root, runtimeManifest]);
    run(["verify", root, runtimeManifest]);
    writeFileSync(join(outside, "target"), "outside\n");
    symlinkSync(join(outside, "target"), join(root, "escape"));
    const escapedTrackedList = pathsFile(root, ["escape"]);
    run(["capture", root, escapedTrackedList, join(root, ".git", "escaped-tracked.json"), "tracked"], false);

    writeFileSync(join(root, ".git", "secret"), "metadata\n");
    symlinkSync(".git/secret", join(root, "git-metadata-link"));
    const metadataList = pathsFile(root, ["git-metadata-link"]);
    run(["capture", root, metadataList, join(root, ".git", "git-metadata-link.json"), "tracked"], false);

    symlinkSync("missing-target", join(root, "dangling"));
    const danglingList = pathsFile(root, ["dangling"]);
    run(["capture", root, danglingList, join(root, ".git", "dangling.json"), "tracked"], false);
    run(["capture-all", root, join(root, ".git", "escaped-runtime.json")], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
