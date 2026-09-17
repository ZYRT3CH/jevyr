import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseJsonBytes } from '@jevyr/core';
import type { DaemonRepository } from './runtime.js';

const MAX_CACHE_BYTES = 4_000_000;
const digest = (text: string | Uint8Array) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Optional recovery of exact already-observed public MCP output. This cache is
 * outside the sealed Case. It cannot append events, change a Record, add evidence
 * authority, or return bytes not committed by that Case's sampling receipt.
 */
export async function readPublicResponse(repository: DaemonRepository, caseId: string, hexDigest: string): Promise<{ protocol: 'jevyr.public-response-cache/1'; text: string } | undefined> {
  if (!/^[a-f0-9]{64}$/.test(hexDigest)) return undefined;
  const status = await repository.status(caseId);
  if (!status) return undefined;
  const wanted = `sha256:${hexDigest}`;
  const receipts = (await repository.artifacts(caseId)).filter(meta => meta.mediaType === 'application/vnd.jevyr.mcp-sampling-receipt+json' && meta.size <= 16_384);
  if (receipts.length > 1024) throw new Error('Public response receipt lookup exceeded its bounded limit');
  let bound = false;
  for (const meta of receipts) {
    const artifact = await repository.artifact(caseId, meta.id);
    if (!artifact || digest(artifact.data) !== meta.digest) continue;
    const receipt = object(parseJsonBytes(artifact.data, 'Public sampling receipt'));
    if (receipt?.protocol === 'jevyr.mcp-sampling-receipt/1' && receipt.outputDigest === wanted && receipt.caseDigest === status.sealed.caseDigest && receipt.runDigest === status.sealed.runDigest) { bound = true; break; }
  }
  if (!bound) return undefined;
  const directory = join(repository.dataDir, 'public-response-cache');
  const path = join(directory, `${hexDigest}.json`);
  try {
    const directoryInfo = await lstat(directory);
    const info = await lstat(path);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) return undefined;
    if (resolve(await realpath(path)) !== resolve(await realpath(directory), `${hexDigest}.json`)) return undefined;
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_CACHE_BYTES || before.ino !== info.ino || before.dev !== info.dev) return undefined;
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat();
      if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
      const cached = object(parseJsonBytes(bytes.subarray(0,count), 'Recovered public response'));
      if (cached?.protocol !== 'jevyr.public-response-cache/1' || typeof cached.text !== 'string' || digest(cached.text) !== wanted) return undefined;
      return { protocol: 'jevyr.public-response-cache/1', text: cached.text };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Recovered public response could not be verified');
  }
}
