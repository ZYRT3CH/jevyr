import { describe, expect, it } from 'vitest';
import {
  artifactTitle,
  executionPreview,
  extractBlueprintFiles,
} from './artifact-preview';

describe('read-only blueprint preview', () => {
  it('decodes persisted output as inert text and rejects corrupt captures', () => {
    const stdout = '<script>not executed</script>';
    const execution = {
      command: 'node',
      args: ['jevyr.experiment.mjs'],
      exitCode: 1,
      outputTruncated: false,
      stdoutCapture: {
        schema: 'jevyr.exact-byte-capture/1',
        encoding: 'base64',
        data: btoa(stdout),
        byteLength: stdout.length,
      },
    };
    expect(executionPreview({ oracle: { execution } })?.stdout).toBe(stdout);
    expect(
      executionPreview({
        oracle: {
          execution: {
            ...execution,
            stdoutCapture: { ...execution.stdoutCapture, byteLength: 1 },
          },
        },
      })?.stdout,
    ).toBeUndefined();
    expect(
      executionPreview({ command: 'not an execution record' }),
    ).toBeUndefined();
  });
  it('uses readable artifact titles without inventing contents', () => {
    expect(artifactTitle('candidate-blueprint-sha256:abcdef123456.json')).toBe(
      'Candidate source · abcdef1234',
    );
    expect(artifactTitle('unknown.bin')).toBe('unknown.bin');
  });
  it('extracts exact source from a compiled population without interpreting it', () => {
    const content = '<script>throw new Error("never run")</script>';
    expect(
      extractBlueprintFiles({
        candidates: [
          { blueprint: { files: [{ path: 'index.html', content }] } },
          {
            blueprint: {
              files: [{ path: 'index.html', content: 'different candidate' }],
            },
          },
        ],
      }),
    ).toEqual([
      { path: '0/index.html', content },
      { path: '1/index.html', content: 'different candidate' },
    ]);
  });
  it('does not mistake digest-only artifact references for source', () => {
    expect(
      extractBlueprintFiles({
        files: [{ path: 'a.js', digest: 'sha256:abc' }, null, 'fake'],
      }),
    ).toEqual([]);
  });
  it('bounds recursion and file count', () => {
    expect(
      extractBlueprintFiles({
        files: Array.from({ length: 500 }, (_, i) => ({
          path: `file-${i}`,
          content: '',
        })),
      }),
    ).toHaveLength(256);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(extractBlueprintFiles(cyclic)).toEqual([]);
  });
  it('preserves strings as labels, including unsafe-looking paths', () => {
    expect(
      extractBlueprintFiles({
        files: [{ path: '../../not-a-write', content: 'literal text' }],
      })[0]?.path,
    ).toBe('../../not-a-write');
  });
});
