import { describe, it, expect } from 'vitest';
import { recognizeLineFrames, recognizeStaticDocument, recordedLineFrames, sha256Text } from './visual-artifact';

describe('visual artifact recognition', () => {
  const frames = [{ t: 0, left: 0, right: 0, gap: 0 }, { t: 1, left: 1, right: 0, gap: 1 }];
  it('requires bounded, ordered, consistent numeric frames', () => {
    expect(recognizeLineFrames({ frames })?.frames).toEqual(frames);
    for (const bad of [[...frames].reverse(), [{...frames[0], left: Infinity}, frames[1]], [{...frames[0], gap: 2}, frames[1]], Array(2001).fill(frames[0])]) expect(recognizeLineFrames({ frames: bad })).toBeUndefined();
    expect(recognizeLineFrames({ frames: [{ t: 0, html: '<script/>' }] })).toBeUndefined();
  });
  it('recognizes static documents without granting execution or navigation', () => {
    expect(recognizeStaticDocument('index.html', '<main><h1>Work</h1></main>')?.document).toContain("script-src 'none'");
    expect(recognizeStaticDocument('image.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')?.kind).toBe('svg');
    for (const text of ['<main><meta http-equiv="refresh" content="0;url=https://example.com"></main>', '<main><a href="https://example.com">link</a></main>', '<main><iframe src="https://example.com"></iframe></main>']) expect(recognizeStaticDocument('index.html', text)).toBeUndefined();
    expect(recognizeStaticDocument('source.js', '<main>Hello</main>')).toBeUndefined();
    expect(recognizeStaticDocument('index.html', '<main>'+'x'.repeat(200000))).toBeUndefined();
  });
  it('binds playback to the exact executed source, blueprint and complete captured bytes', async () => {
    const content = 'source';
    const text = JSON.stringify({ frames });
    const source = { blueprintDigest: 'sha256:blueprint', path: 'experiment.mjs', content };
    const observation = { metadata: { candidateBlueprintDigest: source.blueprintDigest }, oracle: { execution: { command: 'node', args: [source.path], outputTruncated: false, stdoutCapture: { schema: 'jevyr.exact-byte-capture/1', encoding: 'base64', complete: true, data: btoa(text), byteLength: text.length, digest: await sha256Text(text) } }, workspace: { complete: true, entries: [{ kind: 'file', path: source.path, digest: await sha256Text(content) }] } } };
    expect((await recordedLineFrames(observation, source))?.frames).toEqual(frames);
    expect(await recordedLineFrames(observation, { ...source, content: 'other' })).toBeUndefined();
    expect(await recordedLineFrames(observation, { ...source, blueprintDigest: 'other' })).toBeUndefined();
    observation.oracle.execution.stdoutCapture.complete = false;
    expect(await recordedLineFrames(observation, source)).toBeUndefined();
  });
});
