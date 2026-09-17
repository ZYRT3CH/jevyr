import { describe, expect, it, vi } from "vitest";
import { JevyrClient } from "../src/client.js";
import { sha256BytesDigest } from "../src/digest.js";
import { JevyrContinuityError } from "../src/errors.js";
import type { ArtifactList, ArtifactMeta } from "../src/types.js";
import { assertArtifactList, assertArtifactMeta } from "../src/verify.js";

const CASE_ID = "case_0123456789abcdef";

async function fixture(text = "immutable evidence\n"): Promise<{ meta: ArtifactMeta; bytes: Uint8Array; list: ArtifactList }> {
  const bytes = new TextEncoder().encode(text);
  const digest = await sha256BytesDigest(bytes);
  const meta: ArtifactMeta = {
    protocol: "jevyr.artifact/1",
    id: `artifact_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
    caseId: CASE_ID,
    name: "observation.json",
    mediaType: "application/vnd.jevyr.tool-observation+json",
    size: bytes.byteLength,
    digest,
    createdAt: "2026-09-04T12:34:56.000Z",
  };
  return { meta, bytes, list: { protocol: "jevyr.artifacts/1", caseId: CASE_ID, artifacts: [meta] } };
}

function inputPath(input: string | URL | Request): string {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
}

function artifactResponse(
  meta: ArtifactMeta,
  bytes: Uint8Array,
  headers: Record<string, string | undefined> = {},
): Response {
  const defaults: Record<string, string> = {
    "content-length": String(meta.size),
    "content-type": meta.mediaType,
    "x-jevyr-digest": meta.digest,
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete defaults[key];
    else defaults[key] = value;
  }
  return new Response(bytes, { headers: defaults });
}

describe("artifact response validation", () => {
  it("accepts only a complete content-addressed metadata/index pair", async () => {
    const { meta, list } = await fixture();
    expect(assertArtifactMeta(meta, { caseId: CASE_ID, artifactId: meta.id })).toEqual(meta);
    expect(assertArtifactList(list, CASE_ID)).toEqual(list);
  });

  it("rejects missing, unknown, cross-Case, and repeated index entries", async () => {
    const { meta, list } = await fixture();
    const { createdAt: _createdAt, ...missing } = meta;
    expect(() => assertArtifactMeta(missing)).toThrow(JevyrContinuityError);
    expect(() => assertArtifactMeta({ ...meta, surprise: true })).toThrow("missing or unknown fields");
    expect(() => assertArtifactList({ ...list, caseId: "case_fedcba9876543210" }, CASE_ID)).toThrow("invalid Case index");
    expect(() => assertArtifactList({ ...list, artifacts: [{ ...meta, caseId: "case_fedcba9876543210" }] }, CASE_ID)).toThrow("Case boundary");
    expect(() => assertArtifactList({ ...list, artifacts: [meta, meta] }, CASE_ID)).toThrow("repeats");
    expect(() => assertArtifactList({ ...list, extra: null }, CASE_ID)).toThrow("missing or unknown fields");
  });

  it.each([
    ["digest", (meta: ArtifactMeta) => ({ ...meta, digest: `sha256:${"A".repeat(64)}` })],
    ["identifier", (meta: ArtifactMeta) => ({ ...meta, id: `artifact_${"f".repeat(24)}` })],
    ["name", (meta: ArtifactMeta) => ({ ...meta, name: "../observation.json" })],
    ["media type", (meta: ArtifactMeta) => ({ ...meta, mediaType: "not a media type" })],
    ["size", (meta: ArtifactMeta) => ({ ...meta, size: -1 })],
    ["timestamp", (meta: ArtifactMeta) => ({ ...meta, createdAt: "not-a-date" })],
    ["non-canonical timestamp", (meta: ArtifactMeta) => ({ ...meta, createdAt: "2026-09-04T12:34:56Z" })],
  ])("rejects invalid %s metadata", async (_label, mutate) => {
    const { meta } = await fixture();
    expect(() => assertArtifactMeta(mutate(meta))).toThrow(JevyrContinuityError);
  });

  it("client lists validated artifact metadata without leaking the raw envelope", async () => {
    const { meta, list } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(list));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(client.listArtifacts(CASE_ID)).resolves.toEqual([meta]);
    await expect(client.artifactList(CASE_ID)).resolves.toEqual(list);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("turns malformed artifact-index JSON into a continuity failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { headers: { "content-type": "application/json" } }));
    await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).listArtifacts(CASE_ID)).rejects.toBeInstanceOf(
      JevyrContinuityError,
    );
  });
});

describe("verified artifact retrieval", () => {
  it("returns bytes only after index, headers, length, media type, and SHA-256 agree", async () => {
    const { meta, bytes, list } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = inputPath(input);
      if (path.endsWith("/artifacts")) return Response.json(list);
      if (path.endsWith(`/artifacts/${meta.id}`)) return artifactResponse(meta, bytes);
      return Response.json({ error: "missing" }, { status: 404 });
    });
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const artifact = await client.fetchArtifact(CASE_ID, meta.id);
    expect(artifact.meta).toEqual(meta);
    expect(artifact.data).toEqual(bytes);
    expect(artifact.verification).toBe("sha256");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ accept: meta.mediaType }) });

    await expect(client.artifact(CASE_ID, meta.id)).resolves.toMatchObject({ meta, verification: "sha256" });
  });

  it("resolves exact artifact digests without guessing truncated identifiers", async () => {
    const { meta, bytes, list } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = inputPath(input);
      if (path.endsWith("/artifacts")) return Response.json(list);
      if (path.endsWith(`/artifacts/${meta.id}`)) return artifactResponse(meta, bytes);
      return Response.json({ error: "missing" }, { status: 404 });
    });
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(client.artifactByDigest(CASE_ID, meta.digest)).resolves.toMatchObject({
      meta,
      verification: "sha256",
    });
    await expect(client.artifactByDigest(CASE_ID, `sha256:${"f".repeat(64)}`)).resolves.toBeUndefined();
  });

  it("will not fetch an identifier absent from the validated Case index", async () => {
    const { list } = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...list, artifacts: [] }));
    await expect(
      new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, `artifact_${"f".repeat(24)}`),
    ).rejects.toThrow("does not contain");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses an artifact too large for the materializing SDK before body transport", async () => {
    const { meta, list } = await fixture();
    const oversized = { ...meta, size: 512 * 1_048_576 + 1 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      ...list,
      artifacts: [oversized],
    }));
    await expect(
      new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id),
    ).rejects.toThrow("materialization limit");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps original-subject certificates at 8 MiB before fetching by ID or digest", async () => {
    const { meta, list } = await fixture();
    const oversized = { ...meta, mediaType: "application/vnd.jevyr.original-subject-assertion-certificate+json", size: 8 * 1_048_576 + 1 };
    for (const byDigest of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...list, artifacts: [oversized] }));
      const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
      await expect(byDigest ? client.artifactByDigest(CASE_ID, meta.digest) : client.fetchArtifact(CASE_ID, meta.id)).rejects.toThrow("8388608-byte materialization limit");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rechecks certificate bounds after a previously small index changes", async () => {
    const { meta, list } = await fixture();
    const small = { ...meta, mediaType: "application/vnd.jevyr.original-subject-assertion-certificate+json" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...list, artifacts: [small] }))
      .mockResolvedValueOnce(Response.json({ ...list, artifacts: [{ ...small, size: 8 * 1_048_576 + 1 }] }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    expect((await client.listArtifacts(CASE_ID))[0]!.size).toBe(meta.size);
    await expect(client.artifactByDigest(CASE_ID, meta.digest)).rejects.toThrow("8388608-byte materialization limit");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects missing, malformed, or contradictory digest headers", async () => {
    const { meta, bytes, list } = await fixture();
    for (const digest of [undefined, "SHA256:bad", `sha256:${"f".repeat(64)}`]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(list))
        .mockResolvedValueOnce(artifactResponse(meta, bytes, { "x-jevyr-digest": digest }));
      await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id)).rejects.toBeInstanceOf(
        JevyrContinuityError,
      );
    }
  });

  it("rejects missing, non-canonical, unsafe, or metadata-conflicting lengths", async () => {
    const { meta, bytes, list } = await fixture();
    for (const length of [undefined, "01", "not-a-number", "9007199254740992", String(meta.size + 1)]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(list))
        .mockResolvedValueOnce(artifactResponse(meta, bytes, { "content-length": length }));
      await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id)).rejects.toBeInstanceOf(
        JevyrContinuityError,
      );
    }
  });

  it("rejects a missing or metadata-conflicting media type", async () => {
    const { meta, bytes, list } = await fixture();
    for (const mediaType of [undefined, "application/octet-stream"]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(list))
        .mockResolvedValueOnce(artifactResponse(meta, bytes, { "content-type": mediaType }));
      await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id)).rejects.toBeInstanceOf(
        JevyrContinuityError,
      );
    }
  });

  it("rejects truncated and same-length tampered bytes", async () => {
    const { meta, bytes, list } = await fixture();
    const truncated = bytes.slice(0, -1);
    const tampered = Uint8Array.from(bytes);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    for (const body of [truncated, tampered]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(list))
        .mockResolvedValueOnce(artifactResponse(meta, body));
      await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id)).rejects.toBeInstanceOf(
        JevyrContinuityError,
      );
    }
  });

  it("turns an unreadable response stream into a continuity failure", async () => {
    const { meta, list } = await fixture();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream severed"));
      },
    });
    const response = new Response(broken, {
      headers: {
        "content-length": String(meta.size),
        "content-type": meta.mediaType,
        "x-jevyr-digest": meta.digest,
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(response);
    await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, meta.id)).rejects.toThrow(
      "body could not be read",
    );
  });

  it("rejects non-canonical artifact identifiers before transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).fetchArtifact(CASE_ID, "../artifact")).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
