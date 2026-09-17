#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { sep } from "node:path";

const PROTOCOL = "jevyr.filesystem-manifest/1";
const MAX_PATH_LIST_BYTES = 128_000_000;
const MAX_TREE_LIST_BYTES = 192_000_000;
const BUFFER_SIZE = 1024 * 1024;
const ROOT_SEPARATOR = Buffer.from(sep);
const SOURCE_ENTRY_LIMIT = 100_000;
const SOURCE_BYTE_LIMIT = 1_000_000_000n;
const SOURCE_DIRECTORY_LIMIT = 500_000;
const RUNTIME_ENTRY_LIMIT = 500_000;
const RUNTIME_BYTE_LIMIT = 4_000_000_000n;
const RUNTIME_DIRECTORY_LIMIT = 1_000_000;

function fail(message) {
  throw new Error(message);
}

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function fromB64(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail(`${label} is not canonical base64`);
  return decoded;
}

function splitNulPaths(value, entryLimit) {
  if (value.byteLength > MAX_PATH_LIST_BYTES) fail("Tracked path list exceeds its 128 MB limit");
  if (value.byteLength === 0) return [];
  if (value.at(-1) !== 0) fail("Tracked path list is not NUL terminated");
  const paths = [];
  let start = 0;
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] !== 0) continue;
    const path = value.subarray(start, index);
    if (path.byteLength === 0) fail("Tracked path list contains an empty path");
    if (paths.length === entryLimit) fail(`Filesystem manifest exceeds its ${entryLimit}-entry limit`);
    paths.push(Buffer.from(path));
    start = index + 1;
  }
  return paths;
}

function readPathList(path, entryLimit) {
  return splitNulPaths(readStableFile(path, MAX_PATH_LIST_BYTES, "Tracked path list"), entryLimit);
}

function readStableFile(path, maximumBytes, label) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`${label} is not a regular file`);
    if (before.size > BigInt(maximumBytes)) fail(`${label} exceeds its byte limit`);
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity(before), identity(after)) || BigInt(value.byteLength) !== after.size) {
      fail(`${label} changed while it was read`);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function pathsFromGitTree(treePath, pathsPath) {
  const value = readStableFile(treePath, MAX_TREE_LIST_BYTES, "Git tree inventory");
  if (value.byteLength > 0 && value.at(-1) !== 0) fail("Git tree inventory is not NUL terminated");
  const paths = [];
  let pathBytes = 0;
  let start = 0;
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] !== 0) continue;
    const record = value.subarray(start, index);
    start = index + 1;
    const separator = record.indexOf(0x09);
    if (separator <= 0 || separator === record.byteLength - 1) fail("Git tree inventory contains a malformed entry");
    const header = record.subarray(0, separator).toString("ascii");
    const path = Buffer.from(record.subarray(separator + 1));
    components(path);
    if (/^160000 commit [0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(header)) {
      fail(`Git submodule ${b64(path)} is unsupported because its content is absent from the sealed checkout`);
    }
    if (!/^(?:100644|100755|120000) blob [0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(header)) {
      fail("Git tree inventory contains an unsupported mode, type, or object id");
    }
    if (paths.length === SOURCE_ENTRY_LIMIT) fail(`Filesystem manifest exceeds its ${SOURCE_ENTRY_LIMIT}-entry limit`);
    pathBytes += path.byteLength + 1;
    if (pathBytes > MAX_PATH_LIST_BYTES) fail("Tracked path list exceeds its 128 MB limit");
    paths.push(path, Buffer.from([0]));
  }
  writeFileSync(pathsPath, Buffer.concat(paths, pathBytes), { flag: "wx", mode: 0o400 });
}

function components(path) {
  if (path.byteLength === 0 || path[0] === 0x2f) fail("Manifest path must be relative");
  const result = [];
  let start = 0;
  for (let index = 0; index <= path.byteLength; index += 1) {
    if (index !== path.byteLength && path[index] !== 0x2f) continue;
    const component = path.subarray(start, index);
    if (
      component.byteLength === 0
      || (component.byteLength === 1 && component[0] === 0x2e)
      || (component.byteLength === 2 && component[0] === 0x2e && component[1] === 0x2e)
    ) fail("Manifest path contains a non-canonical component");
    result.push(Buffer.from(component));
    start = index + 1;
  }
  return result;
}

function relativePath(parts) {
  return Buffer.concat(parts.flatMap((part, index) => index === 0 ? [part] : [Buffer.from("/"), part]));
}

function absolutePath(root, path) {
  return Buffer.concat([root, ROOT_SEPARATOR, path]);
}

function withinRoot(root, candidate) {
  return candidate.equals(root)
    || (candidate.byteLength > root.byteLength
      && candidate.subarray(0, root.byteLength).equals(root)
      && candidate.subarray(root.byteLength, root.byteLength + ROOT_SEPARATOR.byteLength).equals(ROOT_SEPARATOR));
}

function identity(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function metadata(info) {
  return {
    mode: Number(info.mode & 0o7777n),
    size: info.size.toString(),
    links: info.nlink.toString(),
  };
}

function inspectParents(root, rootInfo, path) {
  const parts = components(path);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = Buffer.concat([current, ROOT_SEPARATOR, part]);
    const info = lstatSync(current, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`Tracked path ${b64(path)} has a linked or non-directory ancestor`);
    }
    if (info.dev !== rootInfo.dev) fail(`Tracked path ${b64(path)} crosses a filesystem boundary`);
  }
  return parts;
}

function hashStableFile(path, initial) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(identity(initial), identity(before))) {
      fail(`Tracked file ${b64(path)} changed while it was opened`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let observed = 0n;
    while (true) {
      const length = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (length === 0) break;
      observed += BigInt(length);
      digest.update(buffer.subarray(0, length));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity(before), identity(after)) || observed !== after.size) {
      fail(`Tracked file ${b64(path)} changed while it was hashed`);
    }
    return `sha256:${digest.digest("hex")}`;
  } finally {
    closeSync(descriptor);
  }
}

function inspectEntry(root, rootInfo, path, closure, budget) {
  inspectParents(root, rootInfo, path);
  const absolute = absolutePath(root, path);
  const before = lstatSync(absolute, { bigint: true });
  if (before.dev !== rootInfo.dev) fail(`Tracked entry ${b64(path)} crosses a filesystem boundary`);
  if (before.isFile()) {
    if (before.size > budget.remaining) fail("Filesystem manifest exceeds its aggregate byte limit");
    budget.remaining -= before.size;
    budget.observed += before.size;
    if (closure !== "complete-runtime" && before.nlink !== 1n) {
      fail(`Tracked file ${b64(path)} has more than one hard link`);
    }
    return {
      path: b64(path),
      type: "file",
      ...metadata(before),
      digest: hashStableFile(absolute, before),
    };
  }
  if (before.isSymbolicLink()) {
    const target = readlinkSync(absolute, { encoding: "buffer" });
    const targetBytes = BigInt(target.byteLength);
    if (targetBytes > budget.remaining) fail("Filesystem manifest exceeds its aggregate byte limit");
    budget.remaining -= targetBytes;
    budget.observed += targetBytes;
    if (closure === "tracked" || closure === "complete-runtime") {
      const resolvedTarget = realpathSync.native(absolute, { encoding: "buffer" });
      const gitMetadata = Buffer.concat([root, ROOT_SEPARATOR, Buffer.from(".git")]);
      if (!withinRoot(root, resolvedTarget) || withinRoot(gitMetadata, resolvedTarget)) {
        fail(`Runtime symbolic link ${b64(path)} does not resolve inside the frozen non-Git tree`);
      }
    }
    const after = lstatSync(absolute, { bigint: true });
    if (!sameIdentity(identity(before), identity(after))) {
      fail(`Tracked symbolic link ${b64(path)} changed while it was read`);
    }
    return {
      path: b64(path),
      type: "symlink",
      ...metadata(before),
      target: b64(target),
      digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
    };
  }
  fail(`Tracked entry ${b64(path)} is not a regular file or symbolic link`);
}

function parentDirectoryPaths(paths, directoryLimit) {
  const directories = new Map();
  for (const path of paths) {
    const parts = components(path);
    for (let length = 1; length < parts.length; length += 1) {
      const relative = relativePath(parts.slice(0, length));
      const key = b64(relative);
      if (!directories.has(key)) {
        if (directories.size === directoryLimit) {
          fail(`Filesystem manifest exceeds its ${directoryLimit}-directory limit`);
        }
        directories.set(key, relative);
      }
    }
  }
  return [...directories.values()].sort(Buffer.compare);
}

function inspectDirectoryPaths(root, rootInfo, paths) {
  return paths.map((path) => {
    const info = lstatSync(absolutePath(root, path), { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootInfo.dev) {
      fail(`Tracked directory ${b64(path)} is linked, special, or crosses a filesystem boundary`);
    }
    return { path: b64(path), type: "directory", mode: Number(info.mode & 0o7777n) };
  });
}

function inventoryTree(root, rootInfo, skipRootGitMetadata, entryLimit, directoryLimit, nodeLimit) {
  const leaves = [];
  const directories = [];
  const pending = [{ absolute: root, relative: Buffer.alloc(0) }];
  let observedNodes = 0;
  let observedLeaves = 0;
  let observedDirectories = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = [];
    const directory = opendirSync(current.absolute, { encoding: "buffer" });
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;
        const name = Buffer.from(entry.name);
        if (skipRootGitMetadata && current.relative.byteLength === 0 && name.equals(Buffer.from(".git"))) continue;
        observedNodes += 1;
        if (observedNodes > nodeLimit) fail(`Filesystem inventory exceeds its ${nodeLimit}-node processing limit`);
        const relative = current.relative.byteLength === 0
          ? Buffer.from(name)
          : Buffer.concat([current.relative, Buffer.from("/"), name]);
        components(relative);
        const absolute = absolutePath(root, relative);
        const info = lstatSync(absolute, { bigint: true });
        if (info.dev !== rootInfo.dev) fail(`Worktree entry ${b64(relative)} crosses a filesystem boundary`);
        let type;
        if (info.isDirectory() && !info.isSymbolicLink()) {
          observedDirectories += 1;
          if (observedDirectories > directoryLimit) {
            fail(`Filesystem manifest exceeds its ${directoryLimit}-directory limit`);
          }
          type = "directory";
        } else if (info.isFile() || info.isSymbolicLink()) {
          observedLeaves += 1;
          if (observedLeaves > entryLimit) fail(`Filesystem manifest exceeds its ${entryLimit}-entry limit`);
          type = "leaf";
        } else {
          fail(`Worktree entry ${b64(relative)} is a special filesystem object`);
        }
        entries.push({ name, absolute, relative, type });
      }
    } finally {
      directory.closeSync();
    }
    entries.sort((left, right) => Buffer.compare(left.name, right.name));
    for (const entry of entries) {
      if (entry.type === "directory") {
        directories.push(entry.relative);
        pending.push({ absolute: entry.absolute, relative: entry.relative });
      } else {
        leaves.push(entry.relative);
      }
    }
  }
  return {
    leaves: leaves.sort(Buffer.compare),
    directories: directories.sort(Buffer.compare),
  };
}

function limitsFor(closure) {
  if (closure === "complete-runtime") {
    return {
      entryLimit: RUNTIME_ENTRY_LIMIT,
      byteLimit: RUNTIME_BYTE_LIMIT,
      directoryLimit: RUNTIME_DIRECTORY_LIMIT,
      nodeLimit: RUNTIME_ENTRY_LIMIT + RUNTIME_DIRECTORY_LIMIT,
    };
  }
  return {
    entryLimit: SOURCE_ENTRY_LIMIT,
    byteLimit: SOURCE_BYTE_LIMIT,
    directoryLimit: SOURCE_DIRECTORY_LIMIT,
    nodeLimit: SOURCE_ENTRY_LIMIT + SOURCE_DIRECTORY_LIMIT,
  };
}

function stableRoot(rootInput) {
  const resolved = realpathSync.native(rootInput);
  const root = Buffer.from(resolved);
  const info = lstatSync(root, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) fail("Manifest root must be a real directory");
  return { root, info, resolved };
}

function snapshot(rootInput, paths, closure) {
  const { root, info: rootInfo, resolved } = stableRoot(rootInput);
  const { entryLimit, byteLimit, directoryLimit, nodeLimit } = limitsFor(closure);
  if (paths.length > entryLimit) fail(`Filesystem manifest exceeds its ${entryLimit}-entry limit`);
  const sorted = [...paths].sort(Buffer.compare);
  const pathKeys = sorted.map(b64);
  if (new Set(pathKeys).size !== pathKeys.length) fail("Tracked path list contains duplicates");
  for (const path of sorted) components(path);
  let directoryPaths;
  if (closure === "complete-worktree" || closure === "complete-runtime") {
    const inventory = inventoryTree(root, rootInfo, true, entryLimit, directoryLimit, nodeLimit);
    const inventoryLeaves = inventory.leaves.map(b64);
    if (JSON.stringify(inventoryLeaves) !== JSON.stringify(pathKeys)) {
      fail("Complete worktree inventory differs from its tracked path list");
    }
    if (closure === "complete-worktree") {
      directoryPaths = parentDirectoryPaths(sorted, directoryLimit);
      if (JSON.stringify(inventory.directories.map(b64)) !== JSON.stringify(directoryPaths.map(b64))) {
        fail("Complete worktree directory inventory differs from its tracked tree");
      }
    } else {
      directoryPaths = inventory.directories;
    }
  } else {
    directoryPaths = parentDirectoryPaths(sorted, directoryLimit);
  }
  const budget = { remaining: byteLimit, observed: 0n };
  const entries = sorted.map((path) => inspectEntry(root, rootInfo, path, closure, budget));
  return {
    protocol: PROTOCOL,
    root: b64(Buffer.from(resolved)),
    closure,
    rootDevice: rootInfo.dev.toString(),
    rootMode: Number(rootInfo.mode & 0o7777n),
    byteLength: budget.observed.toString(),
    directories: inspectDirectoryPaths(root, rootInfo, directoryPaths),
    entries,
  };
}

function loadManifest(path) {
  const raw = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Filesystem manifest is not JSON");
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || value.protocol !== PROTOCOL
    || !["tracked", "complete-worktree", "complete-runtime"].includes(value.closure)
    || typeof value.root !== "string"
    || !Array.isArray(value.directories)
    || !Array.isArray(value.entries)
  ) fail("Filesystem manifest has an invalid shape");
  const paths = value.entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`Filesystem manifest entry ${index} is invalid`);
    }
    return fromB64(entry.path, `Filesystem manifest entry ${index} path`);
  });
  const directories = value.directories.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.type !== "directory") {
      fail(`Filesystem manifest directory ${index} is invalid`);
    }
    return fromB64(entry.path, `Filesystem manifest directory ${index} path`);
  });
  return { value, paths, directories, raw };
}

function assertManifestRoot(rootInput, manifest) {
  const observed = stableRoot(rootInput);
  if (b64(Buffer.from(observed.resolved)) !== manifest.root) fail("Filesystem manifest root changed");
  return observed;
}

function capture(rootInput, pathsFile, manifestPath, closure) {
  if (!["tracked", "complete-worktree"].includes(closure)) fail("Unknown manifest closure mode");
  const paths = readPathList(pathsFile, SOURCE_ENTRY_LIMIT);
  const value = snapshot(rootInput, paths, closure);
  writeFileSync(manifestPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o400 });
}

function captureAll(rootInput, manifestPath) {
  const { root, info } = stableRoot(rootInput);
  const { leaves: paths } = inventoryTree(
    root,
    info,
    true,
    RUNTIME_ENTRY_LIMIT,
    RUNTIME_DIRECTORY_LIMIT,
    RUNTIME_ENTRY_LIMIT + RUNTIME_DIRECTORY_LIMIT,
  );
  const value = snapshot(rootInput, paths, "complete-runtime");
  writeFileSync(manifestPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o400 });
}

function verify(rootInput, manifestPath) {
  const manifest = loadManifest(manifestPath);
  const observed = snapshot(rootInput, manifest.paths, manifest.value.closure);
  if (`${JSON.stringify(observed)}\n` !== manifest.raw) fail("Filesystem bytes differ from the sealed pre-build manifest");
}

function verifySubtree(rootInput, manifestPath, prefixInput) {
  const manifest = loadManifest(manifestPath);
  const { root, info: rootInfo } = assertManifestRoot(rootInput, manifest.value);
  const prefix = Buffer.from(prefixInput, "utf8");
  components(prefix);
  const prefixWithSlash = Buffer.concat([prefix, Buffer.from("/")]);
  const expected = manifest.paths
    .filter((path) => path.equals(prefix) || path.subarray(0, prefixWithSlash.byteLength).equals(prefixWithSlash))
    .sort(Buffer.compare)
    .map(b64);
  const expectedDirectories = manifest.directories
    .filter((path) => path.equals(prefix) || path.subarray(0, prefixWithSlash.byteLength).equals(prefixWithSlash))
    .sort(Buffer.compare)
    .map(b64);
  const absolute = absolutePath(root, prefix);
  let observed = [];
  let observedDirectories = [];
  try {
    const info = lstatSync(absolute, { bigint: true });
    if (info.isSymbolicLink()) fail("Closed runtime subtree root must not be a symbolic link");
    if (info.isDirectory()) {
      const { entryLimit, directoryLimit, nodeLimit } = limitsFor(manifest.value.closure);
      const inventory = inventoryTree(absolute, rootInfo, false, entryLimit, directoryLimit, nodeLimit);
      observed = inventory.leaves.map((path) => b64(Buffer.concat([prefixWithSlash, path])));
      observedDirectories = [
        b64(prefix),
        ...inventory.directories.map((path) => b64(Buffer.concat([prefixWithSlash, path]))),
      ];
    } else if (info.isFile()) {
      observed = [b64(prefix)];
    } else {
      fail("Closed runtime subtree root is special");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  expected.sort();
  observed.sort();
  expectedDirectories.sort();
  observedDirectories.sort();
  if (
    JSON.stringify(observed) !== JSON.stringify(expected)
    || JSON.stringify(observedDirectories) !== JSON.stringify(expectedDirectories)
  ) {
    fail("Closed runtime subtree contains material outside its pre-build manifest");
  }
}

function containsFile(manifestPath, pathInput) {
  const manifest = loadManifest(manifestPath);
  const key = b64(Buffer.from(pathInput, "utf8"));
  const entry = manifest.value.entries.find((candidate) => candidate?.path === key);
  if (!entry || entry.type !== "file") fail("Path is not a regular file in the pre-build manifest");
}

const [command, ...args] = process.argv.slice(2);
if (command === "paths-from-tree" && args.length === 2) pathsFromGitTree(...args);
else if (command === "capture" && args.length === 4) capture(...args);
else if (command === "capture-all" && args.length === 2) captureAll(...args);
else if (command === "verify" && args.length === 2) verify(...args);
else if (command === "verify-subtree" && args.length === 3) verifySubtree(...args);
else if (command === "contains-file" && args.length === 2) containsFile(...args);
else fail("Usage: filesystem-manifest.mjs paths-from-tree TREE-INVENTORY PATHS | capture ROOT PATHS MANIFEST CLOSURE | capture-all ROOT MANIFEST | verify ROOT MANIFEST | verify-subtree ROOT MANIFEST PREFIX | contains-file MANIFEST PATH");
