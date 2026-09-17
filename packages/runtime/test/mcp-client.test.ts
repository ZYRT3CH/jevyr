import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  QuarantinedStdioMcpAdapter,
  type StdioMcpClientOptions,
  type ToolInvocation,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-adversary.mjs", import.meta.url));

function adapter(
  scenario: string,
  marker: string,
  overrides: Partial<StdioMcpClientOptions> = {},
): QuarantinedStdioMcpAdapter {
  return new QuarantinedStdioMcpAdapter({
    id: "fixture-mcp",
    displayName: "Fixture MCP",
    command: process.execPath,
    args: [FIXTURE, scenario, marker],
    env: {},
    allowedTools: ["echo"],
    operationTimeoutMs: 2_000,
    shutdownGraceMs: 500,
    ...overrides,
  });
}

function invocation(tool = "echo", timeoutMs = 2_000, args: Readonly<Record<string, unknown>> = {}): ToolInvocation {
  return {
    invocationId: "inv_fixture_1",
    caseId: "case_fixture_1",
    tool,
    args,
    timeoutMs,
    signal: new AbortController().signal,
  };
}

test("discovery marks every server capability quarantined and preserves the explicit allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-discovery-"));
  try {
    const client = adapter("normal", join(root, "closed"));
    const tools = await client.discoverTools();
    assert.deepEqual(
      tools.map((tool) => ({ name: tool.name, allowed: tool.allowlisted, trust: tool.trust, authority: tool.authority })),
      [
        { name: "echo", allowed: true, trust: "quarantined", authority: "observation-only" },
        { name: "forbidden", allowed: false, trust: "quarantined", authority: "observation-only" },
      ],
    );
    assert.match(tools[0]?.schemaDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(client.capability.trust, "quarantined");
    assert.equal(client.capability.network, "unrestricted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful call is only an observation and the process receives orderly EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-call-"));
  const marker = join(root, "closed");
  const previous = process.env.JEVYR_MCP_TEST_SECRET;
  process.env.JEVYR_MCP_TEST_SECRET = "must-not-cross-boundary";
  try {
    const observation = await adapter("normal", marker).execute(invocation("echo", 2_000, { value: 7 }));
    assert.equal(observation.status, "observed");
    assert.equal(observation.metadata?.trust, "quarantined");
    assert.equal(observation.metadata?.authority, "observation-only");
    assert.equal(observation.metadata?.admissibleAsProof, false);
    assert.equal(observation.metadata?.canAuthorVerdict, false);
    assert.doesNotMatch(observation.stdout ?? "", /must-not-cross-boundary/u);
    assert.equal(await readFile(marker, "utf8"), "stdin-eof");
  } finally {
    if (previous === undefined) delete process.env.JEVYR_MCP_TEST_SECRET;
    else process.env.JEVYR_MCP_TEST_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("discovered tools outside the allowlist are refused without starting a server", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-allowlist-"));
  const marker = join(root, "closed");
  try {
    const observation = await adapter("normal", marker).execute(invocation("forbidden"));
    assert.equal(observation.status, "not-executed");
    assert.equal(observation.metadata?.boundaryError, "tool-not-allowlisted");
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an allowlisted but undiscovered tool is never sent to tools/call", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-unknown-"));
  try {
    const client = adapter("normal", join(root, "closed"), { allowedTools: ["missing"] });
    const observation = await client.execute(invocation("missing"));
    assert.equal(observation.status, "not-executed");
    assert.equal(observation.metadata?.boundaryError, "tool-not-discovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mismatched JSON-RPC response ids fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-id-"));
  try {
    const observation = await adapter("mismatched-id", join(root, "closed")).execute(invocation());
    assert.equal(observation.status, "failed");
    assert.equal(observation.metadata?.boundaryError, "id-mismatch");
    assert.match(observation.stderr ?? "", /does not match pending id/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized and malformed server output fail closed", async (context) => {
  for (const [scenario, expected] of [
    ["oversized", "output-limit"],
    ["malformed", "malformed-message"],
    ["duplicate-key", "malformed-message"],
    ["invalid-utf8", "malformed-message"],
  ] as const) {
    await context.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), `jevyr-mcp-${scenario}-`));
      try {
        const client = adapter(scenario, join(root, "closed"), { maxOutputBytes: 2_048 });
        const observation = await client.execute(invocation());
        assert.equal(observation.status, "failed");
        assert.equal(observation.metadata?.boundaryError, expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a silent tool is terminated at the per-call deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-timeout-"));
  try {
    const started = performance.now();
    const observation = await adapter("timeout", join(root, "closed")).execute(invocation("echo", 150));
    assert.equal(observation.status, "failed");
    assert.equal(observation.metadata?.boundaryError, "timeout");
    assert.ok(performance.now() - started < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an external abort terminates an in-flight tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-abort-"));
  try {
    const controller = new AbortController();
    const pending = adapter("timeout", join(root, "closed")).execute({
      ...invocation("echo", 2_000),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100).unref();
    const observation = await pending;
    assert.equal(observation.status, "failed");
    assert.equal(observation.metadata?.boundaryError, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("roots, sampling, elicitation, and arbitrary server requests are rejected", async (context) => {
  for (const method of ["roots/list", "sampling/createMessage", "elicitation/create", "server/arbitrary"]) {
    await context.test(method, async () => {
      const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-request-"));
      try {
        const observation = await adapter(`server-request:${method}`, join(root, "closed")).execute(invocation());
        assert.equal(observation.status, "failed");
        assert.equal(observation.metadata?.boundaryError, "server-request");
        assert.match(observation.stderr ?? "", new RegExp(method.replace("/", "\\/"), "u"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a server request emitted after an apparently valid result still invalidates the lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-late-request-"));
  try {
    const observation = await adapter("request-after-result", join(root, "closed")).execute(invocation());
    assert.equal(observation.status, "failed");
    assert.equal(observation.metadata?.boundaryError, "server-request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized tool arguments are refused before process start", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-input-"));
  const marker = join(root, "closed");
  try {
    const client = adapter("normal", marker, { maxInputBytes: 512 });
    const observation = await client.execute(invocation("echo", 2_000, { value: "x".repeat(1_024) }));
    assert.equal(observation.status, "not-executed");
    assert.equal(observation.metadata?.boundaryError, "input-limit");
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
