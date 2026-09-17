/** Read-only extraction. Names are labels, never filesystem paths or HTML. */
export function extractBlueprintFiles(
  value: unknown,
): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (
      !node ||
      typeof node !== 'object' ||
      depth > 8 ||
      result.length >= 256 ||
      visited++ >= 10000
    )
      return;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.files)) {
      for (const entry of object.files) {
        if (result.length >= 256) break;
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.path !== 'string' ||
          typeof entry.content !== 'string'
        )
          continue;
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (!seen.has(path)) {
          result.push({ path, content: entry.content });
          seen.add(path);
        }
      }
    }
    for (const [key, nested] of Object.entries(object)) {
      if (key !== 'files')
        walk(
          nested,
          Array.isArray(node) ? (prefix ? `${prefix}/${key}` : key) : prefix,
          depth + 1,
        );
    }
  };
  walk(value, '', 0);
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode only bounded persisted captures. Returned strings remain inert display text. */
export function executionPreview(value: unknown) {
  const observation = object(value);
  const execution = object(object(observation?.oracle)?.execution);
  if (
    !execution ||
    typeof execution.command !== 'string' ||
    !Array.isArray(execution.args)
  )
    return undefined;
  const capture = (value: unknown): string | undefined => {
    const record = object(value);
    if (
      !record ||
      record.schema !== 'jevyr.exact-byte-capture/1' ||
      record.encoding !== 'base64' ||
      typeof record.data !== 'string' ||
      record.data.length > 2_000_000
    )
      return undefined;
    try {
      const bytes = Uint8Array.from(atob(record.data), (character) =>
        character.charCodeAt(0),
      );
      if (bytes.byteLength !== record.byteLength) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  };
  return {
    command: [
      execution.command,
      ...execution.args.filter((arg): arg is string => typeof arg === 'string'),
    ].join(' '),
    exitCode:
      typeof execution.exitCode === 'number' ? execution.exitCode : null,
    stdout: capture(execution.stdoutCapture),
    stderr: capture(execution.stderrCapture),
    truncated: execution.outputTruncated !== false,
  };
}

export function artifactTitle(name: string): string {
  if (name.startsWith('candidate-blueprint-'))
    return `Candidate source · ${name.replace('candidate-blueprint-', '').replace('sha256:', '').slice(0, 10)}`;
  if (name.startsWith('candidate-population-'))
    return 'Frozen candidate population';
  if (name.startsWith('tool-observation-'))
    return `Execution report · ${name.slice('tool-observation-'.length, 'tool-observation-'.length + 10)}`;
  if (name.startsWith('memory-reconciliation-')) return 'Memory reconciliation';
  if (name.startsWith('memory-'))
    return `Quarantined memory · ${name.slice(7, 17)}`;
  return name;
}
