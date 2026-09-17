import { createRequire } from "node:module";
import { posix } from "node:path";
import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import type { SubjectTextProjection } from "./subject-materials.js";

export interface CodeLocation {
  readonly subjectId: string;
  readonly path: string;
  readonly sourceDigest: string;
  readonly startLine: number;
  readonly endLine: number;
}
export interface CodeNode extends CodeLocation {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
}
export interface CodeDependency {
  readonly from: string;
  readonly specifier: string;
  readonly resolvedPath?: string;
  readonly relation: "syntactic-import";
}
export interface SealedCodeIndex {
  readonly protocol: "jevyr.code-index/1";
  readonly projectionDigest: string;
  readonly nodes: readonly CodeNode[];
  readonly dependencies: readonly CodeDependency[];
  readonly files: readonly { subjectId: string; path: string; sourceDigest: string; language: string; parseErrors: boolean }[];
  readonly omissions: readonly { path: string; reason: string }[];
  readonly digest: string;
}

const require = createRequire(import.meta.url);
const LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript", ".py": "python",
});
const SYMBOLS = new Set(["function_declaration", "class_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "function_definition", "class_definition", "variable_declarator"]);
let initialized: Promise<void> | undefined;
const parsers = new Map<string, Promise<Language>>();
async function language(name: string): Promise<Language> {
  await (initialized ??= Parser.init());
  let result = parsers.get(name);
  if (!result) { result = Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`)); parsers.set(name, result); }
  return result;
}

/** Parse only content-verified, bounded text from the sealed CAS, never live paths. */
export async function indexSealedCode(projection: SubjectTextProjection, maximumNodes = 4096): Promise<SealedCodeIndex> {
  const { projectionDigest, ...projectionBody } = projection;
  if (digestJson(projectionBody as unknown as JsonValue) !== projectionDigest) throw new Error("Code index refused mismatched projection digest");
  if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 16_384) throw new RangeError("Invalid code index node ceiling");
  const nodes: CodeNode[] = [];
  const dependencies: CodeDependency[] = [];
  const files: SealedCodeIndex["files"][number][] = [];
  const omissions: SealedCodeIndex["omissions"][number][] = [];
  const paths = new Set(projection.files.map(file => `${file.subjectId}:${file.path}`));
  for (const file of [...projection.files].sort((a, b) => a.subjectId.localeCompare(b.subjectId) || a.path.localeCompare(b.path))) {
    if (sha256Digest(file.text) !== file.sourceDigest || Buffer.byteLength(file.text) !== file.sourceByteLength) throw new Error("Code index refused mismatched source bytes");
    const selected = LANGUAGES[posix.extname(file.path)];
    if (!selected) { omissions.push({ path: file.path, reason: "unsupported-language" }); continue; }
    if (nodes.length >= maximumNodes) { omissions.push({ path: file.path, reason: "node-budget" }); continue; }
    const grammar = await language(selected);
    const parser = new Parser();
    let tree: ReturnType<Parser["parse"]> = null;
    try {
      parser.setLanguage(grammar);
      tree = parser.parse(file.text);
      if (!tree) throw new Error("Code index parser returned no tree");
      files.push({ subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest, language: selected, parseErrors: tree.rootNode.hasError });
      const stack: SyntaxNode[] = [tree.rootNode];
      let visited = 0;
      while (stack.length && nodes.length < maximumNodes && visited++ < 100_000) {
        const node = stack.pop()!;
        if (SYMBOLS.has(node.type)) {
          const name = node.childForFieldName("name")?.text ?? "anonymous";
          const location = { subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
          nodes.push({ ...location, kind: node.type, name: name.slice(0, 256), id: digestJson({ ...location, type: node.type, start: node.startIndex, end: node.endIndex }) });
        }
        if ((node.type === "import_statement" || node.type === "export_statement") && dependencies.length < maximumNodes) {
          const source = node.childForFieldName("source");
          if (source) {
            const specifier = source.text.replace(/^["']|["']$/gu, "");
            const base = posix.normalize(posix.join(posix.dirname(file.path), specifier));
            const attempts = [base, ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"].map(ext => base + ext), base.replace(/\.js$/u, ".ts")];
            const resolvedPath = specifier.startsWith(".") ? attempts.find(path => paths.has(`${file.subjectId}:${path}`)) : undefined;
            dependencies.push({ from: `${file.subjectId}:${file.path}`, specifier, relation: "syntactic-import", ...(resolvedPath === undefined ? {} : { resolvedPath }) });
          }
        }
        for (const child of [...node.namedChildren].reverse()) if (child) stack.push(child);
      }
      if (stack.length) omissions.push({ path: file.path, reason: "node-budget" });
    } finally { tree?.delete(); parser.delete(); }
  }
  const value = { protocol: "jevyr.code-index/1" as const, projectionDigest: projection.projectionDigest, nodes, dependencies, files, omissions };
  return Object.freeze({ ...value, digest: digestJson(value as unknown as JsonValue) });
}

/** Bounded reverse syntactic dependency closure; this is attribution, not causation. */
export function codeImpact(index: SealedCodeIndex, subjectId: string, changedPaths: readonly string[]): readonly string[] {
  const paths = new Set(changedPaths);
  for (let pass = 0; pass <= index.dependencies.length; pass++) {
    let grew = false;
    for (const edge of index.dependencies) {
      if (!edge.from.startsWith(`${subjectId}:`) || !edge.resolvedPath || !paths.has(edge.resolvedPath)) continue;
      const from = edge.from.slice(subjectId.length + 1);
      if (!paths.has(from)) { paths.add(from); grew = true; }
    }
    if (!grew) break;
  }
  return Object.freeze([...paths].sort());
}
