import { executionPreview } from './artifact-preview';

export type LineFrame = { t: number; left: number; right: number; gap: number };
export type LineFrames = { title: string; frames: LineFrame[] };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Recognize data, never infer a visualization from a filename or run its code. */
export function recognizeLineFrames(value: unknown): LineFrames | undefined {
  const data = record(value);
  if (!data || !Array.isArray(data.frames) || data.frames.length < 2 || data.frames.length > 2000) return;
  const frames: LineFrame[] = [];
  for (const value of data.frames) {
    const f = record(value);
    if (!f || !['t', 'left', 'right', 'gap'].every(key => typeof f[key] === 'number' && Number.isFinite(f[key]) && Math.abs(f[key] as number) <= 1e6)) return;
    const frame = f as LineFrame;
    if (frame.gap < 0 || Math.abs(Math.abs(frame.left - frame.right) - frame.gap) > 1e-8 || (frames.length && frame.t <= frames.at(-1)!.t)) return;
    frames.push({ t: frame.t, left: frame.left, right: frame.right, gap: frame.gap });
  }
  return { title: typeof data.proposal === 'string' ? data.proposal.slice(0, 200) : 'Two-line frame sequence', frames };
}

export async function sha256Text(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** An execution preview is valid only for its exact blueprint and selected entry file. */
export async function recordedLineFrames(value: unknown, source?: { blueprintDigest: string; path: string; content: string }): Promise<LineFrames | undefined> {
  const observation = record(value);
  if (observation?.protocol !== undefined && observation.protocol !== 'jevyr.tool-observation/1') return;
  const metadata = record(observation?.metadata);
  const oracle = record(observation?.oracle);
  const execution = record(oracle?.execution);
  const stdout = record(execution?.stdoutCapture);
  if (source) {
    if (metadata?.candidateBlueprintDigest !== source.blueprintDigest || !Array.isArray(execution?.args) || !execution.args.includes(source.path)) return;
    const workspace = record(oracle?.workspace);
    if (workspace?.complete !== true || !Array.isArray(workspace.entries)) return;
    const digest = await sha256Text(source.content);
    if (!workspace.entries.some(entry => { const file = record(entry); return file?.kind === 'file' && file.path === source.path && file.digest === digest; })) return;
  }
  const preview = executionPreview(value);
  if (!preview || preview.truncated || preview.stdout === undefined || stdout?.complete !== true || typeof stdout.digest !== 'string') return;
  if (await sha256Text(preview.stdout) !== stdout.digest) return;
  try { return recognizeLineFrames(JSON.parse(preview.stdout)); } catch { return; }
}

export type StaticDocument = { kind: 'html' | 'svg'; document: string };
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";

/** Conservative static-only HTML: fail closed on navigation and active containers. */
export function recognizeStaticDocument(path: string, text: string): StaticDocument | undefined {
  if (text.length > 200000) return;
  if (/\.svg$/i.test(path) && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    // SVG is rendered only as an image: no scripts or external resource loading.
    return { kind: 'svg', document: text };
  }
  if (!/\.html?$/i.test(path) || !/<(?:html|body|div|main|section|h1|p|svg)[\s>]/i.test(text)) return;
  // Attribute names are not entity-decoded by HTML parsers. These checks also
  // reject occurrences inside comments/text: a deliberate conservative limit.
  if (/http-equiv\s*=|<(?:base|iframe|frame|object|embed)\b|\b(?:href|action|formaction)\s*=/i.test(text)) return;
  return { kind: 'html', document: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html{color-scheme:light dark}body{overflow-wrap:anywhere}</style>${text}` };
}
