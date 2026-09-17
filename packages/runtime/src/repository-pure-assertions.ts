import { createRequire } from "node:module";
import { posix } from "node:path";
import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { compileIntentContract, parseJsonBytes, parseJsonText } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, validateSealedCase, type IntentContract, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { planRepositoryEvaluation, type RepositoryEvaluatorRunner } from "./repository-evaluation-plan.js";
import { deriveRepositoryEvaluationClosure, type RepositoryEvaluationClosure } from "./repository-evaluation-closure.js";
import type { SubjectContextReader } from "./subject-context.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "./subject-materials.js";

/** Preparation only. No execution, signature authentication or verdict authority.
 * The caller must authenticate a Case before using its identity as provenance. */
export const REPOSITORY_PURE_ASSERTIONS_PROTOCOL = "jevyr.repository-pure-assertions/1" as const;
export const REPOSITORY_PURE_ASSERTION_LIMITS = Object.freeze({ maxAssertions: 64, maxFunctions: 16, maxParameters: 8,
  maxDepth: 32, maxTotalBytes: 256 * 1024, maxSyntaxNodes: 50_000, maxSteps: 50_000, maxCertificateBytes: 8 * 1024 * 1024 });
export type RepositoryPureAssertionLimits = { readonly [K in keyof typeof REPOSITORY_PURE_ASSERTION_LIMITS]: number };
export interface RepositoryPureAssertionInput {
  readonly sealedCase: SealedCase;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly reader: SubjectContextReader;
  /** Existing discovery identity only; this does not appoint a pure evaluator. */
  readonly runner: RepositoryEvaluatorRunner;
  readonly limits?: Partial<RepositoryPureAssertionLimits>;
}
/** A distinct, non-authenticated prepared input, never a redacted Seal. The host
 * must derive and compare this projection from its authenticated original Case. */
export interface RepositoryPureAssertionContext {
  readonly protocol: "jevyr.repository-pure-assertion-context/1";
  readonly caseId: string; readonly caseDigest: string; readonly runDigest: string; readonly policyDigest: string;
  readonly captureDigest: string; readonly intentContract: IntentContract;
  readonly subject: Readonly<{ subjectId: string; kind: "directory"; digest: string; byteLength: number }>;
  readonly digest: string;
}
export interface RepositoryPureAssertionContextInput {
  readonly context: RepositoryPureAssertionContext;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly reader: SubjectContextReader;
  readonly runner: RepositoryEvaluatorRunner;
  readonly limits?: Partial<RepositoryPureAssertionLimits>;
}
export interface PureSourceSpan {
  readonly path: string; readonly sourceDigest: string; readonly startByte: number; readonly endByte: number;
  readonly startLine: number; readonly endLine: number; readonly textDigest: string;
}
export type PureValue = Readonly<{ kind: "integer"; value: number }> | Readonly<{ kind: "boolean"; value: boolean }>;
export interface PureEvaluationStep {
  readonly sequence: number; readonly assertionId: string; readonly operation: string; readonly source: PureSourceSpan;
  readonly inputs: readonly PureValue[]; readonly result: PureValue; readonly functionId?: string;
}
export interface PureAssertionResult {
  readonly id: string; readonly name: string; readonly source: PureSourceSpan; readonly actualSource: PureSourceSpan;
  readonly expected: Readonly<{ source: PureSourceSpan; text: string; value: PureValue }>;
  readonly actual: PureValue; readonly outcome: "equal" | "different"; readonly calledFunctions: readonly string[];
}
export interface RepositoryPureAssertionAnalysis {
  readonly protocol: typeof REPOSITORY_PURE_ASSERTIONS_PROTOCOL;
  readonly authority: "none";
  readonly scope: "exact-captured-pure-assertions";
  readonly status: "complete" | "unavailable";
  readonly outcome: "match" | "mismatch" | "unavailable";
  readonly limits: RepositoryPureAssertionLimits;
  readonly binding: Readonly<{ caseId: string; caseDigest: string; runDigest: string; policyDigest: string;
    intentContractDigest: string; obligationId: string; captureDigest: string; subjectId: string; subjectDigest: string;
    manifestDigest: string; planDigest: string; suiteDigest: string; closureDigest: string; membershipDigest: string }> | null;
  readonly files: RepositoryEvaluationClosure["files"];
  readonly functions: readonly Readonly<{ id: string; name: string; parameters: readonly string[]; source: PureSourceSpan; bodyDigest: string }>[];
  readonly assertions: readonly PureAssertionResult[];
  readonly trace: readonly PureEvaluationStep[];
  readonly coverage: Readonly<{ testFiles: number; sourceFiles: number; syntaxNodes: number; assertions: number; functions: number; evaluatedSteps: number }>;
  readonly refusals: readonly Readonly<{ code: string; source?: PureSourceSpan }>[];
  readonly digest: string;
}
type SpanExpression = { readonly source: PureSourceSpan };
type Expression = SpanExpression & (
  | { readonly kind: "literal"; readonly value: PureValue }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "negate"; readonly operand: Expression }
  | { readonly kind: "group"; readonly operand: Expression }
  | { readonly kind: "binary"; readonly operator: string; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "conditional"; readonly condition: Expression; readonly consequent: Expression; readonly alternative: Expression }
  | { readonly kind: "call"; readonly name: string; readonly arguments: readonly Expression[] });
interface PureFunction { id: string; name: string; path: string; parameters: string[]; source: PureSourceSpan; body: Expression }
interface Assertion { id: string; name: string; path: string; source: PureSourceSpan; actual: Expression; expected: PureAssertionResult["expected"] }
type ImportBinding = { kind: "test" | "assert-object" | "assert-function" } | { kind: "function"; path: string; name: string };
interface Module { path: string; text: string; digest: string; test: boolean; imports: Map<string, ImportBinding>; functions: Map<string, PureFunction>; assertions: Assertion[] }
const hash = (value: unknown) => digestJson(value as JsonValue);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
class Refusal extends Error { constructor(readonly code: string, readonly source?: PureSourceSpan) { super(code); } }
function refuse(code: string, source?: PureSourceSpan): never { throw new Refusal(code, source); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const children = (node: SyntaxNode) => node.namedChildren.filter((child): child is SyntaxNode => child !== null && child.type !== "comment");
function only(node: SyntaxNode, type: string): SyntaxNode { const list = children(node); if (list.length !== 1 || list[0]!.type !== type) refuse("UNSUPPORTED_STRUCTURE"); return list[0]!; }
function required(node: SyntaxNode, field: string): SyntaxNode { return node.childForFieldName(field) ?? refuse("MISSING_SYNTAX_FIELD"); }
function shape(node: SyntaxNode, expected: readonly SyntaxNode[]): void {
  const actual = children(node); if (actual.length !== expected.length || actual.some((child, i) => child.id !== expected[i]!.id)) refuse("UNSUPPORTED_STRUCTURE");
}
const require = createRequire(import.meta.url);
let grammar: Promise<Language> | undefined;
const language = () => grammar ??= (async () => { await Parser.init(); return Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm")); })();
// Both named productions and anonymous tokens are closed. Context checks below
// then restrict how even these permitted nodes may be composed.
const NODE_TYPES = new Set(["program", "comment", "import_statement", "import_clause", "named_imports", "import_specifier", "identifier", "undefined", "string", "string_fragment",
  "export_statement", "function_declaration", "formal_parameters", "statement_block", "return_statement", "lexical_declaration", "variable_declarator", "arrow_function",
  "expression_statement", "call_expression", "arguments", "member_expression", "property_identifier", "number", "true", "false", "binary_expression", "unary_expression", "ternary_expression", "parenthesized_expression",
  "import", "from", "as", "export", "function", "const", "return", "(", ")", "{", "}", ",", ";", ".", "=", "=>", "?", ":", "+", "-", "<", ">", "<=", ">=", "===", "!==", "\"", "'"]);
const OPERATORS = new Set(["+", "-", "<", ">", "<=", ">=", "===", "!=="]);
// Tree-sitter is a syntax tree builder, not a full ECMAScript early-error checker.
// In particular it can label reserved words as declaration identifiers.
const forbiddenBindings = new Set(["await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "eval", "arguments", "implements", "interface", "package", "private", "protected", "public", "static", "let"]);
function name(node: SyntaxNode): string {
  if (!["identifier", "undefined"].includes(node.type) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(node.text) || forbiddenBindings.has(node.text)) refuse("BINDING_SYNTAX_UNSUPPORTED");
  return node.text;
}
function span(module: Module, node: SyntaxNode): PureSourceSpan {
  if (module.text.slice(node.startIndex, node.endIndex) !== node.text) refuse("SOURCE_SPAN_MISMATCH");
  return { path: module.path, sourceDigest: module.digest, startByte: Buffer.byteLength(module.text.slice(0, node.startIndex)), endByte: Buffer.byteLength(module.text.slice(0, node.endIndex)),
    startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, textDigest: sha256Digest(node.text) };
}
function textLiteral(node: SyntaxNode): string {
  if (node.type !== "string" || !/^(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')$/u.test(node.text) || /[\u0000-\u001f\u007f]/u.test(node.text)) refuse("STRING_LITERAL_UNSUPPORTED");
  return node.text.slice(1, -1);
}
const SAFE = 9_007_199_254_740_991n;
function integer(value: bigint, source: PureSourceSpan): PureValue { if (value < -SAFE || value > SAFE) refuse("UNSAFE_INTEGER", source); return { kind: "integer", value: Number(value) }; }
function literal(module: Module, node: SyntaxNode): PureValue {
  const source = span(module, node);
  if (node.type === "true" || node.type === "false") return { kind: "boolean", value: node.type === "true" };
  if (node.type === "number" && /^(?:0|[1-9][0-9]*)$/u.test(node.text)) {
    if (node.text.length > 16) refuse("UNSAFE_INTEGER", source); return integer(BigInt(node.text), source);
  }
  if (node.type === "unary_expression" && required(node, "operator").text === "-" && required(node, "argument").type === "number") {
    const argument = required(node, "argument"); shape(node, [argument]); const value = literal(module, argument);
    if (value.kind !== "integer" || value.value === 0) refuse("NEGATIVE_ZERO", source); return integer(-BigInt(value.value), source);
  }
  return refuse("LITERAL_DOMAIN_UNSUPPORTED", source);
}
function parameters(node: SyntaxNode, limits: RepositoryPureAssertionLimits): string[] {
  if (node.type !== "formal_parameters") refuse("PARAMETER_SYNTAX_UNSUPPORTED");
  const names = children(node).map(name);
  if (names.length > limits.maxParameters) refuse("PARAMETER_LIMIT");
  if (new Set(names).size !== names.length) refuse("DUPLICATE_PARAMETER"); return names;
}
function expression(module: Module, node: SyntaxNode, params: readonly string[], limits: RepositoryPureAssertionLimits, depth = 1): Expression {
  const source = span(module, node); if (depth > limits.maxDepth) refuse("EXPRESSION_DEPTH_LIMIT", source);
  const descend = (child: SyntaxNode) => expression(module, child, params, limits, depth + 1);
  if (["number", "true", "false"].includes(node.type)) { shape(node, []); return { kind: "literal", source, value: literal(module, node) }; }
  if (node.type === "identifier" || node.type === "undefined") { const id = name(node); if (!params.includes(id)) refuse("UNBOUND_VALUE", source); return { kind: "parameter", source, name: id }; }
  if (node.type === "parenthesized_expression") { const list = children(node); if (list.length !== 1) refuse("UNSUPPORTED_STRUCTURE", source); return { kind: "group", source, operand: descend(list[0]!) }; }
  if (node.type === "unary_expression") {
    const operand = required(node, "argument"); shape(node, [operand]);
    if (required(node, "operator").text !== "-") refuse("UNSUPPORTED_OPERATOR", source);
    if (operand.type === "number") return { kind: "literal", source, value: literal(module, node) };
    return { kind: "negate", source, operand: descend(operand) };
  }
  if (node.type === "binary_expression") {
    const left = required(node, "left"), right = required(node, "right"), operator = required(node, "operator").text; shape(node, [left, right]);
    if (!OPERATORS.has(operator)) refuse("UNSUPPORTED_OPERATOR", source);
    return { kind: "binary", source, operator, left: descend(left), right: descend(right) };
  }
  if (node.type === "ternary_expression") {
    const condition = required(node, "condition"), consequent = required(node, "consequence"), alternative = required(node, "alternative"); shape(node, [condition, consequent, alternative]);
    return { kind: "conditional", source, condition: descend(condition), consequent: descend(consequent), alternative: descend(alternative) };
  }
  if (node.type === "call_expression") {
    const fn = required(node, "function"), args = required(node, "arguments"); shape(node, [fn, args]);
    if (args.type !== "arguments" || children(args).length > limits.maxParameters) refuse("CALL_ARGUMENT_LIMIT", source);
    return { kind: "call", source, name: name(fn), arguments: children(args).map(descend) };
  }
  return refuse("EXPRESSION_UNSUPPORTED", source);
}
function addBinding(module: Module, local: string, binding: ImportBinding): void {
  if (module.imports.has(local) || module.functions.has(local)) refuse("DUPLICATE_BINDING"); module.imports.set(local, binding);
}
function parseImport(module: Module, node: SyntaxNode): void {
  const source = required(node, "source"), specifier = textLiteral(source), list = children(node);
  if (list.length !== 2 || list[0]!.type !== "import_clause" || list[1]!.id !== source.id) refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
  const clause = list[0]!, imports = children(clause);
  if (imports.length !== 1) refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
  if (specifier === "node:test" || specifier === "node:assert/strict") {
    if (!module.test) refuse("APPLICATION_BUILTIN_IMPORT", span(module, node));
    if (imports[0]!.type === "identifier") { addBinding(module, name(imports[0]!), { kind: specifier === "node:test" ? "test" : "assert-object" }); return; }
    if (imports[0]!.type !== "named_imports") refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
    const entries = children(imports[0]!); if (!entries.length) refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
    for (const entry of entries) {
      if (entry.type !== "import_specifier") refuse("IMPORT_SYNTAX_UNSUPPORTED");
      const imported = required(entry, "name"), alias = entry.childForFieldName("alias"); shape(entry, alias ? [imported, alias] : [imported]);
      const symbol = name(imported), local = name(alias ?? imported);
      if (specifier === "node:test" && symbol === "test") addBinding(module, local, { kind: "test" });
      else if (specifier === "node:assert/strict" && ["equal", "strictEqual"].includes(symbol)) addBinding(module, local, { kind: "assert-function" });
      else refuse("BUILTIN_SYMBOL_UNSUPPORTED", span(module, entry));
    }
    return;
  }
  // Native ESM applies URL percent decoding. V1 does not emulate that resolver.
  if (!/^(?:\.\/|\.\.\/).+\.mjs$/u.test(specifier) || /[\\%?#:\u0000-\u001f]/u.test(specifier) || specifier.split("/").some(part => part === "")) refuse("IMPORT_SPECIFIER_UNSUPPORTED", span(module, node));
  const resolved = posix.normalize(posix.join(posix.dirname(module.path), specifier));
  if (resolved.startsWith("../") || resolved.startsWith("/") || imports[0]!.type !== "named_imports") refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
  const entries = children(imports[0]!); if (!entries.length) refuse("IMPORT_SYNTAX_UNSUPPORTED", span(module, node));
  for (const entry of entries) {
    if (entry.type !== "import_specifier") refuse("IMPORT_SYNTAX_UNSUPPORTED");
    const imported = required(entry, "name"), alias = entry.childForFieldName("alias"); shape(entry, alias ? [imported, alias] : [imported]);
    addBinding(module, name(alias ?? imported), { kind: "function", path: resolved, name: name(imported) });
  }
}
function parseFunction(module: Module, node: SyntaxNode, limits: RepositoryPureAssertionLimits): void {
  const declaration = required(node, "declaration"); shape(node, [declaration]);
  let functionNode: SyntaxNode, identifier: SyntaxNode;
  if (declaration.type === "function_declaration") { functionNode = declaration; identifier = required(declaration, "name"); }
  else if (declaration.type === "lexical_declaration") {
    if (declaration.children[0]?.type !== "const") refuse("MUTABLE_DECLARATION", span(module, declaration));
    const variable = only(declaration, "variable_declarator"); identifier = required(variable, "name"); functionNode = required(variable, "value"); shape(variable, [identifier, functionNode]);
    if (functionNode.type !== "arrow_function") refuse("FUNCTION_SYNTAX_UNSUPPORTED", span(module, variable));
  } else return refuse("EXPORT_SYNTAX_UNSUPPORTED", span(module, node));
  const id = name(identifier), parameterNode = required(functionNode, "parameters"), bodyNode = required(functionNode, "body"), params = parameters(parameterNode, limits);
  shape(functionNode, declaration.type === "function_declaration" ? [identifier, parameterNode, bodyNode] : [parameterNode, bodyNode]);
  if (module.imports.has(id) || module.functions.has(id)) refuse("DUPLICATE_BINDING", span(module, identifier));
  let body = bodyNode;
  if (bodyNode.type === "statement_block") { const returned = only(bodyNode, "return_statement"), parts = children(returned); if (parts.length !== 1) refuse("FUNCTION_BODY_UNSUPPORTED", span(module, bodyNode)); body = parts[0]!; }
  else if (functionNode.type !== "arrow_function") refuse("FUNCTION_BODY_UNSUPPORTED", span(module, bodyNode));
  module.functions.set(id, { id: `${module.path}#${id}`, path: module.path, name: id, parameters: params, source: span(module, node), body: expression(module, body, params, limits) });
}
function parseAssertion(module: Module, statement: SyntaxNode, limits: RepositoryPureAssertionLimits): void {
  const node = only(statement, "call_expression"), fn = required(node, "function"), args = required(node, "arguments"); shape(node, [fn, args]);
  if (fn.type !== "identifier" || module.imports.get(name(fn))?.kind !== "test") refuse("TEST_CALL_UNSUPPORTED", span(module, node));
  const arguments_ = children(args); if (arguments_.length !== 2 || arguments_[1]!.type !== "arrow_function") refuse("TEST_SIGNATURE_UNSUPPORTED", span(module, node));
  const title = textLiteral(arguments_[0]!); if (Buffer.byteLength(title) > 256) refuse("TEST_NAME_LIMIT", span(module, arguments_[0]!));
  const callback = arguments_[1]!, params = required(callback, "parameters"), body = required(callback, "body"); shape(callback, [params, body]);
  if (parameters(params, limits).length !== 0) refuse("TEST_PARAMETER_UNSUPPORTED", span(module, callback));
  let assertion = body;
  if (body.type === "statement_block") assertion = only(only(body, "expression_statement"), "call_expression");
  if (assertion.type !== "call_expression") refuse("ASSERTION_CALL_UNSUPPORTED", span(module, assertion));
  const assertionFn = required(assertion, "function"), assertionArgs = required(assertion, "arguments"); shape(assertion, [assertionFn, assertionArgs]);
  if (assertionFn.type === "identifier") { if (module.imports.get(name(assertionFn))?.kind !== "assert-function") refuse("ASSERTION_BINDING_UNSUPPORTED", span(module, assertionFn)); }
  else if (assertionFn.type === "member_expression") {
    const receiver = required(assertionFn, "object"), property = required(assertionFn, "property"); shape(assertionFn, [receiver, property]);
    if (receiver.type !== "identifier" || module.imports.get(name(receiver))?.kind !== "assert-object" || property.type !== "property_identifier" || !["equal", "strictEqual"].includes(property.text)) refuse("ASSERTION_BINDING_UNSUPPORTED", span(module, assertionFn));
  } else refuse("ASSERTION_BINDING_UNSUPPORTED", span(module, assertionFn));
  const pair = children(assertionArgs); if (pair.length !== 2) refuse("ASSERTION_SIGNATURE_UNSUPPORTED", span(module, assertion));
  const expected = pair[1]!, source = span(module, node);
  module.assertions.push({ id: hash({ protocol: "jevyr.pure-assertion-location/1", source }), name: title, path: module.path, source,
    actual: expression(module, pair[0]!, [], limits), expected: { source: span(module, expected), text: expected.text, value: literal(module, expected) } });
}
async function parseModule(module: Module, limits: RepositoryPureAssertionLimits, count: { nodes: number }): Promise<void> {
  const parser = new Parser(); let tree: ReturnType<Parser["parse"]> = null;
  try {
    parser.setLanguage(await language()); tree = parser.parse(module.text);
    if (!tree || tree.rootNode.hasError) refuse("SOURCE_PARSE_ERROR");
    const pending = [{ node: tree.rootNode, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count.nodes > limits.maxSyntaxNodes) refuse("SYNTAX_NODE_LIMIT");
      if (depth > limits.maxDepth) refuse("SYNTAX_DEPTH_LIMIT", span(module, node));
      if (node.isMissing || !NODE_TYPES.has(node.type)) refuse("SYNTAX_NODE_UNSUPPORTED", span(module, node));
      for (const child of node.children) if (child) pending.push({ node: child, depth: depth + 1 });
    }
    const statements = children(tree.rootNode); let nonImport = false;
    for (const statement of statements) {
      if (statement.type === "import_statement") { if (nonImport) refuse("IMPORT_ORDER_UNSUPPORTED", span(module, statement)); parseImport(module, statement); }
      else { nonImport = true; if (module.test && statement.type === "expression_statement") parseAssertion(module, statement, limits);
        else if (!module.test && statement.type === "export_statement") parseFunction(module, statement, limits);
        else refuse("MODULE_STATEMENT_UNSUPPORTED", span(module, statement)); }
    }
    if (module.test && module.assertions.length === 0) refuse("ZERO_ASSERTIONS");
    for (const fn of module.functions.values()) for (const param of fn.parameters) if (module.imports.has(param) || module.functions.has(param)) refuse("SHADOWED_MODULE_BINDING", fn.source);
  } finally { tree?.delete(); parser.delete(); }
}
function expressionChildren(expr: Expression): readonly Expression[] {
  if (expr.kind === "binary") return [expr.left, expr.right];
  if (expr.kind === "conditional") return [expr.condition, expr.consequent, expr.alternative];
  if (expr.kind === "call") return expr.arguments;
  if (expr.kind === "negate" || expr.kind === "group") return [expr.operand]; return [];
}
function target(modules: Map<string, Module>, path: string, expr: Extract<Expression, { kind: "call" }>): PureFunction {
  const module = modules.get(path)!, imported = module.imports.get(expr.name);
  const fn = imported?.kind === "function" ? modules.get(imported.path)?.functions.get(imported.name) : module.functions.get(expr.name);
  if (!fn) refuse("UNBOUND_FUNCTION", expr.source);
  if (fn.parameters.length !== expr.arguments.length) refuse("CALL_ARITY_MISMATCH", expr.source); return fn;
}
function checkGraphs(modules: Map<string, Module>, limits: RepositoryPureAssertionLimits): void {
  function acyclic(ids: readonly string[], edges: (value: string) => readonly string[]): void {
    const active = new Set<string>(), heights = new Map<string, number>();
    const visit = (id: string, depth: number): number => {
      if (depth > limits.maxDepth) refuse("DEPENDENCY_DEPTH_LIMIT"); if (active.has(id)) refuse("DEPENDENCY_CYCLE");
      const known = heights.get(id); if (known !== undefined) return known;
      active.add(id); let height = 1;
      for (const next of new Set(edges(id))) height = Math.max(height, 1 + visit(next, depth + 1));
      active.delete(id); if (height > limits.maxDepth) refuse("DEPENDENCY_DEPTH_LIMIT"); heights.set(id, height); return height;
    };
    for (const id of ids) visit(id, 1);
  }
  const functions = new Map([...modules.values()].flatMap(module => [...module.functions.values()].map(fn => [fn.id, fn] as const)));
  const functionEdges = new Map<string, string[]>();
  for (const module of modules.values()) {
    for (const imported of module.imports.values()) if (imported.kind === "function") {
      const destination = modules.get(imported.path); if (!destination || destination.test || !destination.functions.has(imported.name)) refuse("IMPORT_EXPORT_MISMATCH");
    }
    for (const [id, expr] of [...module.functions.values()].map(fn => [fn.id, fn.body] as const).concat(module.assertions.map(assertion => [assertion.id, assertion.actual] as const))) {
      const pending = [expr], edges: string[] = [];
      while (pending.length) { const item = pending.pop()!; if (item.kind === "call") edges.push(target(modules, module.path, item).id); pending.push(...expressionChildren(item)); }
      functionEdges.set(id, edges);
    }
  }
  acyclic([...modules.keys()], path => [...modules.get(path)!.imports.values()].filter((item): item is Extract<ImportBinding, { kind: "function" }> => item.kind === "function").map(item => item.path));
  acyclic([...functions.keys()], key => functionEdges.get(key) ?? []);
}
// Closed monomorphic constraints are deliberately narrower than JavaScript.
// They reject coercions/type conflicts in unused functions and untaken branches.
interface TypeCell { parent?: TypeCell; kind?: PureValue["kind"] }
function root(cell: TypeCell): TypeCell { if (cell.parent) cell.parent = root(cell.parent); return cell.parent ?? cell; }
function unify(a: TypeCell, b: TypeCell, source: PureSourceSpan): void {
  const left = root(a), right = root(b); if (left === right) return;
  if (left.kind && right.kind && left.kind !== right.kind) refuse("TYPE_DOMAIN_CONFLICT", source);
  if (!left.kind && right.kind) left.kind = right.kind; right.parent = left;
}
function checkTypes(modules: Map<string, Module>): void {
  const signatures = new Map([...modules.values()].flatMap(module => [...module.functions.values()].map(fn => [fn.id, { params: fn.parameters.map((): TypeCell => ({})), result: {} as TypeCell }] as const)));
  const check = (path: string, expr: Expression, environment: Map<string, TypeCell>): TypeCell => {
    const constrain = (value: TypeCell, kind: PureValue["kind"]) => unify(value, { kind }, expr.source);
    if (expr.kind === "literal") return { kind: expr.value.kind };
    if (expr.kind === "parameter") return environment.get(expr.name)!;
    if (expr.kind === "group") return check(path, expr.operand, environment);
    if (expr.kind === "negate") { constrain(check(path, expr.operand, environment), "integer"); return { kind: "integer" }; }
    if (expr.kind === "binary") {
      const left = check(path, expr.left, environment), right = check(path, expr.right, environment);
      if (["===", "!=="].includes(expr.operator)) unify(left, right, expr.source);
      else { constrain(left, "integer"); constrain(right, "integer"); }
      return { kind: ["+", "-"].includes(expr.operator) ? "integer" : "boolean" };
    }
    if (expr.kind === "conditional") {
      constrain(check(path, expr.condition, environment), "boolean"); const result = check(path, expr.consequent, environment);
      unify(result, check(path, expr.alternative, environment), expr.source); return result;
    }
    const fn = target(modules, path, expr), signature = signatures.get(fn.id)!;
    expr.arguments.forEach((argument, index) => unify(check(path, argument, environment), signature.params[index]!, expr.source)); return signature.result;
  };
  for (const module of modules.values()) for (const fn of module.functions.values()) {
    const signature = signatures.get(fn.id)!; unify(check(module.path, fn.body, new Map(fn.parameters.map((param, index) => [param, signature.params[index]!]))), signature.result, fn.source);
  }
  for (const module of modules.values()) for (const assertion of module.assertions) check(module.path, assertion.actual, new Map());
}
function evaluate(modules: Map<string, Module>, assertions: readonly Assertion[], limits: RepositoryPureAssertionLimits): { results: PureAssertionResult[]; trace: PureEvaluationStep[] } {
  const trace: PureEvaluationStep[] = [], results: PureAssertionResult[] = []; let steps = 0, traceBytes = 0;
  for (const assertion of assertions) {
    const called = new Set<string>();
    const compute = (path: string, expr: Expression, environment: ReadonlyMap<string, PureValue>, depth: number): PureValue => {
      if (depth > limits.maxDepth) refuse("EVALUATION_DEPTH_LIMIT", expr.source);
      if (++steps > limits.maxSteps) refuse("EVALUATION_STEP_LIMIT", expr.source);
      const child = (value: Expression) => compute(path, value, environment, depth + 1);
      let result: PureValue, inputs: PureValue[] = [], functionId: string | undefined;
      if (expr.kind === "literal") result = expr.value;
      else if (expr.kind === "parameter") result = environment.get(expr.name) ?? refuse("UNBOUND_VALUE", expr.source);
      else if (expr.kind === "group") { result = child(expr.operand); inputs = [result]; }
      else if (expr.kind === "negate") {
        const value = child(expr.operand); inputs = [value]; if (value.kind !== "integer") refuse("TYPE_DOMAIN_CONFLICT", expr.source);
        if (value.value === 0) refuse("NEGATIVE_ZERO", expr.source); result = integer(-BigInt(value.value), expr.source);
      } else if (expr.kind === "binary") {
        const a = child(expr.left), b = child(expr.right); inputs = [a, b];
        if (expr.operator === "===" || expr.operator === "!==") {
          if (a.kind !== b.kind) refuse("TYPE_DOMAIN_CONFLICT", expr.source);
          result = { kind: "boolean", value: expr.operator === "===" ? a.value === b.value : a.value !== b.value };
        } else {
          if (a.kind !== "integer" || b.kind !== "integer") refuse("TYPE_DOMAIN_CONFLICT", expr.source);
          const left = BigInt(a.value), right = BigInt(b.value);
          if (expr.operator === "+" || expr.operator === "-") result = integer(expr.operator === "+" ? left + right : left - right, expr.source);
          else result = { kind: "boolean", value: expr.operator === "<" ? left < right : expr.operator === ">" ? left > right : expr.operator === "<=" ? left <= right : left >= right };
        }
      } else if (expr.kind === "conditional") {
        const condition = child(expr.condition); if (condition.kind !== "boolean") refuse("TYPE_DOMAIN_CONFLICT", expr.source);
        result = child(condition.value ? expr.consequent : expr.alternative); inputs = [condition, result];
      } else {
        const fn = target(modules, path, expr); functionId = fn.id; called.add(fn.id); inputs = expr.arguments.map(child);
        result = compute(fn.path, fn.body, new Map(fn.parameters.map((param, index) => [param, inputs[index]!])), depth + 1);
      }
      const step: PureEvaluationStep = { sequence: trace.length + 1, assertionId: assertion.id, operation: expr.kind === "binary" ? expr.operator : expr.kind, source: expr.source, inputs, result, ...(functionId ? { functionId } : {}) };
      traceBytes += Buffer.byteLength(canonicalize(step as unknown as JsonValue)); if (traceBytes > limits.maxCertificateBytes) refuse("CERTIFICATE_BYTE_LIMIT", expr.source); trace.push(step); return result;
    };
    const actual = compute(assertion.path, assertion.actual, new Map(), 1), expected = assertion.expected.value;
    results.push({ id: assertion.id, name: assertion.name, source: assertion.source, actualSource: assertion.actual.source, expected: assertion.expected, actual,
      outcome: actual.kind === expected.kind && actual.value === expected.value ? "equal" : "different", calledFunctions: [...called].sort(compare) });
  }
  return { results, trace };
}
function limitsFor(input: Pick<RepositoryPureAssertionInput, "limits">): RepositoryPureAssertionLimits {
  if (input.limits !== undefined && (!object(input.limits) || Object.keys(input.limits).some(key => !Object.hasOwn(REPOSITORY_PURE_ASSERTION_LIMITS, key)))) refuse("LIMIT_CONFIGURATION");
  return Object.freeze(Object.fromEntries(Object.entries(REPOSITORY_PURE_ASSERTION_LIMITS).map(([key, maximum]) => {
    const value = input.limits && Object.hasOwn(input.limits, key) ? input.limits[key as keyof RepositoryPureAssertionLimits] : maximum, minimum = ["maxFunctions", "maxParameters"].includes(key) ? 0 : 1;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) refuse("LIMIT_CONFIGURATION"); return [key, value];
  }))) as RepositoryPureAssertionLimits;
}
/** Validates structural/digest consistency, not signatures. Original filesystem
 * locators never enter the resulting context or the fixed producer package. */
export function deriveRepositoryPureAssertionContext(input: SealedCase): RepositoryPureAssertionContext {
  if (!validateSealedCase(input).ok) refuse("SEALED_CASE_BINDING");
  const sealed = JSON.parse(canonicalize(input as unknown as JsonValue)) as SealedCase;
  if (sealed.intent.impulse !== "Existing tests must pass." || sealed.intentContract.originalImpulse !== "Existing tests must pass."
    || sealed.intent.subjects.length !== 1 || sealed.intent.subjects[0]!.kind !== "directory" || sealed.subjects.length !== 1
    || sealed.intent.constraints.length || sealed.intent.requestedAssays.length) refuse("INTENT_NOT_APPLICABLE");
  const subject = sealed.subjects[0]!, subjectId = sealed.intent.subjects[0]!.id;
  if (subjectId !== subject.subjectId || !/^[A-Za-z0-9._-]{1,256}$/u.test(subjectId)) refuse("CAPTURE_BINDING");
  const contract = compileIntentContract({ impulse: sealed.intent.impulse, subjectIds: [subjectId] });
  if (contract.digest !== sealed.intentContractDigest || hash(contract) !== hash(sealed.intentContract) || contract.criticalObligations.length !== 1) refuse("INTENT_CONTRACT_BINDING");
  const body = { protocol: "jevyr.repository-pure-assertion-context/1" as const, caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest,
    policyDigest: sealed.policyDigest, captureDigest: sealed.subjectMaterialCaptureDigest, intentContract: contract,
    subject: { subjectId, kind: "directory" as const, digest: subject.digest, byteLength: subject.byteLength ?? -1 } };
  return checkedContext({ ...body, digest: hash(body) });
}
function checkedContext(value: RepositoryPureAssertionContext): RepositoryPureAssertionContext {
  if (!object(value) || Object.keys(value).sort().join() !== "captureDigest,caseDigest,caseId,digest,intentContract,policyDigest,protocol,runDigest,subject"
    || value.protocol !== "jevyr.repository-pure-assertion-context/1" || !object(value.subject)
    || Object.keys(value.subject).sort().join() !== "byteLength,digest,kind,subjectId" || value.subject.kind !== "directory"
    || typeof value.subject.subjectId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/u.test(value.subject.subjectId)
    || !Number.isSafeInteger(value.subject.byteLength) || value.subject.byteLength < 0
    || [value.caseDigest, value.runDigest, value.policyDigest, value.captureDigest, value.subject.digest, value.digest].some(item => !isSha256Digest(item))
    || value.caseId !== `case_${value.runDigest.slice(7, 23)}`) refuse("PREPARED_CONTEXT_BINDING");
  const { digest, ...body } = value;
  const contract = compileIntentContract({ impulse: "Existing tests must pass.", subjectIds: [value.subject.subjectId] });
  if (hash(body) !== digest || hash(contract) !== hash(value.intentContract)) refuse("PREPARED_CONTEXT_BINDING");
  return freeze(JSON.parse(canonicalize(value as unknown as JsonValue)) as RepositoryPureAssertionContext);
}
/** Structural projection decoding only; never authenticates Case identity. */
export function decodeRepositoryPureAssertionContext(value: unknown): RepositoryPureAssertionContext { return checkedContext(value as RepositoryPureAssertionContext); }
/** Rederives discovery, membership, syntax and every assertion from original CAS
 * bytes. Subject modules are data: never imported, evaluated or executed. */
async function analyze(input: RepositoryPureAssertionInput | RepositoryPureAssertionContextInput, prepared: boolean): Promise<RepositoryPureAssertionAnalysis> {
  let limits: RepositoryPureAssertionLimits = REPOSITORY_PURE_ASSERTION_LIMITS;
  let binding: RepositoryPureAssertionAnalysis["binding"] = null, files: RepositoryEvaluationClosure["files"] = [];
  let coverage = { testFiles: 0, sourceFiles: 0, syntaxNodes: 0, assertions: 0, functions: 0, evaluatedSteps: 0 };
  const finish = (status: "complete" | "unavailable", outcome: RepositoryPureAssertionAnalysis["outcome"], functions: RepositoryPureAssertionAnalysis["functions"], assertions: readonly PureAssertionResult[], trace: readonly PureEvaluationStep[], refusals: RepositoryPureAssertionAnalysis["refusals"]): RepositoryPureAssertionAnalysis => {
    const body = { protocol: REPOSITORY_PURE_ASSERTIONS_PROTOCOL, authority: "none" as const, scope: "exact-captured-pure-assertions" as const, status, outcome, limits, binding, files, functions, assertions, trace, coverage, refusals };
    return freeze({ ...body, digest: hash(body) });
  };
  try {
    if (!object(input) || Object.keys(input).some(key => ![prepared ? "context" : "sealedCase", "bindings", "reader", "runner", "limits"].includes(key))) refuse("INPUT_SHAPE");
    limits = limitsFor(input);
    const context = prepared ? checkedContext((input as RepositoryPureAssertionContextInput).context) : deriveRepositoryPureAssertionContext((input as RepositoryPureAssertionInput).sealedCase);
    const contract = context.intentContract;
    const obligation = contract.criticalObligations[0]!;
    if (obligation.statement !== "Existing tests must pass." || obligation.origin !== "impulse" || obligation.oracle?.kind !== "sealed_test_suite") refuse("INTENT_NOT_APPLICABLE");
    if (!Array.isArray(input.bindings) || input.bindings.length !== 1) refuse("CAPTURE_BINDING");
    const bindings = JSON.parse(canonicalize(input.bindings as unknown as JsonValue)) as SubjectMaterialBinding[], selected = bindings[0]!;
    if (hash({ protocol: "jevyr.subject-material-capture/1", bindings }) !== context.captureDigest || selected.subjectId !== context.subject.subjectId
      || selected.subjectDigest !== context.subject.digest || selected.byteLength !== context.subject.byteLength || selected.subjectKind !== "directory" || selected.availability !== "MATERIALIZED") refuse("CAPTURE_BINDING");
    let manifest: SubjectMaterialManifest | undefined; const blobs = new Map<string, Buffer>(); let readBytes = 0;
    const reader: SubjectContextReader = {
      readManifest: async requested => {
        if (hash(requested) !== hash(selected)) refuse("CAPTURE_BINDING");
        if (!manifest) {
          const raw = await input.reader.readManifest(freeze({ ...selected })), encoded = canonicalize(raw as unknown as JsonValue);
          if (Buffer.byteLength(encoded) > 16 * 1024 * 1024 || sha256Digest(encoded) !== selected.manifestDigest) refuse("MANIFEST_BINDING");
          manifest = freeze(parseJsonText(encoded) as SubjectMaterialManifest);
          if (!Array.isArray(manifest.omissions) || manifest.omissions.length) refuse("CAPTURE_OMISSIONS");
        }
        return manifest;
      },
      readBlob: async (digest, expectedBytes) => {
        const cached = blobs.get(digest); if (cached) { if (cached.length !== expectedBytes) refuse("SOURCE_BINDING"); return Buffer.from(cached); }
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || readBytes + expectedBytes > limits.maxTotalBytes) refuse("CLOSURE_BYTE_LIMIT");
        const raw = await input.reader.readBlob(digest, expectedBytes);
        if (!(raw instanceof Uint8Array) || raw.byteLength !== expectedBytes || sha256Digest(raw) !== digest) refuse("SOURCE_BINDING");
        const bytes = Buffer.from(raw); blobs.set(digest, bytes); readBytes += bytes.length; return Buffer.from(bytes);
      },
    };
    const plan = await planRepositoryEvaluation({ captureDigest: context.captureDigest, bindings, reader, contract, runner: input.runner });
    if (plan.status !== "ready" || plan.subjects.length !== 1 || plan.coverage.omittedTestFiles !== 0 || plan.subjects[0]!.refusals.length
      || plan.subjects[0]!.discoveredTestFiles !== plan.subjects[0]!.testFiles.length) refuse("DISCOVERY_INCOMPLETE");
    // This stricter preparation must not inherit a diagnostic planner's narrower
    // filename heuristic. Node's default discovery also includes test.mjs and
    // *_test.mjs/*-test.mjs, including corresponding JS/TS variants. Refuse any
    // native default test absent from the explicit selected test inventory.
    const completeManifest = await reader.readManifest(selected), selectedTests = new Set(plan.subjects[0]!.testFiles.map(file => file.path));
    const nativeTests = new Set(completeManifest.entries.filter(entry => !entry.path.split("/").some(part => part === "node_modules" || part.startsWith("."))
      && (/(?:^|\/)(?:test|test-[^/]*|[^/]*[._-]test)\.(?:[cm]?js|[cm]?ts)$/u.test(entry.path)
      || /(?:^|\/)test\/.*\.(?:[cm]?js|[cm]?ts)$/u.test(entry.path))).map(entry => entry.path));
    if (nativeTests.size !== selectedTests.size || [...nativeTests].some(path => !selectedTests.has(path))) refuse("NATIVE_TEST_DISCOVERY_INCOMPLETE");
    if ([...nativeTests].some(path => path.startsWith("-"))) refuse("NATIVE_TEST_EXECUTION_UNSUPPORTED");
    const subject = plan.subjects[0]!, closure = await deriveRepositoryEvaluationClosure({ captureDigest: context.captureDigest, bindings, reader, subject });
    if (closure.byteLength > limits.maxTotalBytes) refuse("CLOSURE_BYTE_LIMIT");
    files = closure.files;
    binding = { caseId: context.caseId, caseDigest: context.caseDigest, runDigest: context.runDigest, policyDigest: context.policyDigest,
      intentContractDigest: contract.digest, obligationId: obligation.id, captureDigest: context.captureDigest, subjectId: selected.subjectId,
      subjectDigest: selected.subjectDigest, manifestDigest: selected.manifestDigest, planDigest: plan.digest, suiteDigest: subject.suiteDigest,
      closureDigest: closure.materializationDigest, membershipDigest: closure.membershipDigest };
    const modules = new Map<string, Module>(), count = { nodes: 0 };
    for (const file of closure.files) {
      const raw = await reader.readBlob(file.digest, file.bytes); let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { refuse("SOURCE_NOT_UTF8"); }
      if (file.roles.includes("config")) {
        const metadata = parseJsonText(text!); if (file.path !== "package.json" || !object(metadata) || Object.keys(metadata).some(key => !["type", "scripts"].includes(key))
          || metadata.type !== undefined && metadata.type !== "module" || metadata.scripts !== undefined && (!object(metadata.scripts) || Object.keys(metadata.scripts).some(key => key !== "test") || metadata.scripts.test !== "node --test")) refuse("CONFIGURATION_UNSUPPORTED");
        continue;
      }
      if (!file.path.endsWith(".mjs")) refuse("SOURCE_LANGUAGE_UNSUPPORTED");
      const module: Module = { path: file.path, text: text!, digest: file.digest, test: file.roles.includes("test"), imports: new Map(), functions: new Map(), assertions: [] };
      await parseModule(module, limits, count); modules.set(module.path, module);
    }
    const functions = [...modules.values()].flatMap(module => [...module.functions.values()]), assertions = [...modules.values()].flatMap(module => module.assertions);
    coverage = { testFiles: subject.testFiles.length, sourceFiles: closure.files.length, syntaxNodes: count.nodes, assertions: assertions.length, functions: functions.length, evaluatedSteps: 0 };
    if (functions.length > limits.maxFunctions) refuse("FUNCTION_LIMIT"); if (!assertions.length) refuse("ZERO_ASSERTIONS"); if (assertions.length > limits.maxAssertions) refuse("ASSERTION_LIMIT");
    checkGraphs(modules, limits); checkTypes(modules);
    const evaluated = evaluate(modules, assertions, limits); coverage = { ...coverage, evaluatedSteps: evaluated.trace.length };
    const result = finish("complete", evaluated.results.some(result => result.outcome === "different") ? "mismatch" : "match",
      functions.map(fn => ({ id: fn.id, name: fn.name, parameters: fn.parameters, source: fn.source, bodyDigest: hash(fn.body) })), evaluated.results, evaluated.trace, []);
    if (Buffer.byteLength(canonicalize(result as unknown as JsonValue)) > limits.maxCertificateBytes) refuse("CERTIFICATE_BYTE_LIMIT"); return result;
  } catch (error) {
    const failure = error instanceof Refusal ? error : new Refusal("INPUT_OR_DISCOVERY_UNAVAILABLE");
    // Never return a supported subset or partial witness after any refusal.
    return finish("unavailable", "unavailable", [], [], [], [{ code: failure.code, ...(failure.source ? { source: failure.source } : {}) }]);
  }
}
export function analyzeRepositoryPureAssertions(input: RepositoryPureAssertionInput): Promise<RepositoryPureAssertionAnalysis> { return analyze(input, false); }
/** Strict prepared-context analysis is non-authenticated. Only a host comparison
 * against deriveRepositoryPureAssertionContext(real authenticated Seal) can bind
 * this input to a particular Case; a context digest cannot authenticate itself. */
export function analyzeRepositoryPureAssertionContext(input: RepositoryPureAssertionContextInput): Promise<RepositoryPureAssertionAnalysis> { return analyze(input, true); }

/** Exact consistency comparison, never authentication. Claimed ASTs, counts and
 * hashes are ignored while fresh analysis is reconstructed from captured bytes. */
export async function compareRepositoryPureAssertionAnalysis(input: RepositoryPureAssertionInput, claimedBytes: Uint8Array): Promise<Readonly<{ authority: "none"; same: boolean; analysis: RepositoryPureAssertionAnalysis }>> {
  const analysis = await analyzeRepositoryPureAssertions(input); let same = false;
  try { if (claimedBytes instanceof Uint8Array && claimedBytes.byteLength <= analysis.limits.maxCertificateBytes) same = canonicalize(parseJsonBytes(claimedBytes) as JsonValue) === canonicalize(analysis as unknown as JsonValue); } catch { /* Malformed claims are not evidence. */ }
  return freeze({ authority: "none" as const, same, analysis });
}
