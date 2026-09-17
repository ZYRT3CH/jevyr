import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const actionDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(actionDirectory, "..", "..", "..");
const action = readFileSync(join(actionDirectory, "action.yml"), "utf8");
const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "jevyr-advisory.yml"), "utf8");

test("archive digests discard sha256sum's filename field", () => {
  assert.match(
    action,
    /JEVYR_BUNDLE_ARCHIVE_DIGEST="sha256:\$\(sha256sum < "\$JEVYR_BUNDLE_ARCHIVE" \| cut -d' ' -f1\)"/u,
  );
  assert.match(
    workflow,
    /JEVYR_OBSERVED_ARCHIVE_DIGEST="sha256:\$\(sha256sum < "\$JEVYR_DOWNLOADED_ARCHIVE" \| cut -d' ' -f1\)"/u,
  );
  assert.doesNotMatch(action, /sha256:\$\(sha256sum < "\$JEVYR_BUNDLE_ARCHIVE"\)"/u);
  assert.doesNotMatch(workflow, /sha256:\$\(sha256sum < "\$JEVYR_DOWNLOADED_ARCHIVE"\)"/u);
});

test("publication uploads and re-verifies only the normalized archive", () => {
  assert.match(workflow, /path: \$\{\{ steps\.jevyr\.outputs\.bundle-archive-path \}\}/u);
  assert.doesNotMatch(workflow, /path: \$\{\{ steps\.jevyr\.outputs\.public-directory \}\}/u);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.publication\.outputs\.artifact-id \}\}/u);
  assert.match(workflow, /merge-multiple: true/u);
  assert.match(workflow, /node "\$GITHUB_WORKSPACE\/\.jevyr-runtime\/apps\/cli\/dist\/main\.js"[\s\\]+\n\s+verify-bundle/u);
});

test("both frozen Git trees pass through the mode-aware path converter", () => {
  assert.match(action, /jevyr-runtime-tree\.entries" "\$RUNNER_TEMP\/jevyr-runtime-tracked\.paths/u);
  assert.match(action, /jevyr-subject-tree\.entries" "\$RUNNER_TEMP\/jevyr-subject-tracked\.paths/u);
});
