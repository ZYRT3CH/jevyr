/** Maximum structural depth accepted at remote JSON trust boundaries. */
export const MAX_REMOTE_JSON_NESTING_DEPTH = 256;

/** Decode a remote JSON body with fatal UTF-8 and duplicate-key rejection. */
export function parseUnambiguousJsonBytes(bytes: Uint8Array, label = "Remote JSON"): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new SyntaxError(`${label} is not valid UTF-8`, { cause });
  }
  return parseUnambiguousJsonText(text, label);
}

/**
 * Parse remote JSON without JSON.parse's last-member-wins ambiguity.
 *
 * The preliminary structural scan rejects duplicate object member names,
 * including names which become equal after JSON escape decoding. JSON.parse is
 * still responsible for the complete JSON grammar after that scan.
 */
export function parseUnambiguousJsonText(text: string, label = "Remote JSON"): unknown {
  new JsonStructureScanner(text, label).scanDocument();
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new SyntaxError(`${label} is not valid JSON`, { cause });
  }
}

class JsonStructureScanner {
  readonly #text: string;
  readonly #label: string;
  #offset = 0;
  #depth = 0;

  constructor(text: string, label: string) {
    this.#text = text;
    this.#label = label;
  }

  scanDocument(): void {
    this.#whitespace();
    this.#value();
    this.#whitespace();
    if (this.#offset !== this.#text.length) this.#malformed();
  }

  #value(): void {
    const token = this.#text[this.#offset];
    if (token === "{") return this.#object();
    if (token === "[") return this.#array();
    if (token === "\"") {
      this.#string();
      return;
    }
    if (token === "t") return this.#literal("true");
    if (token === "f") return this.#literal("false");
    if (token === "n") return this.#literal("null");
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
      this.#number();
      return;
    }
    this.#malformed();
  }

  #object(): void {
    this.#enterContainer();
    try {
      this.#offset += 1;
      this.#whitespace();
      if (this.#take("}")) return;
      const keys = new Set<string>();
      while (true) {
        if (this.#text[this.#offset] !== "\"") this.#malformed();
        const key = this.#string();
        if (keys.has(key)) {
          throw new SyntaxError(`${this.#label} contains duplicate object key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        this.#whitespace();
        if (!this.#take(":")) this.#malformed();
        this.#whitespace();
        this.#value();
        this.#whitespace();
        if (this.#take("}")) return;
        if (!this.#take(",")) this.#malformed();
        this.#whitespace();
      }
    } finally {
      this.#depth -= 1;
    }
  }

  #array(): void {
    this.#enterContainer();
    try {
      this.#offset += 1;
      this.#whitespace();
      if (this.#take("]")) return;
      while (true) {
        this.#value();
        this.#whitespace();
        if (this.#take("]")) return;
        if (!this.#take(",")) this.#malformed();
        this.#whitespace();
      }
    } finally {
      this.#depth -= 1;
    }
  }

  #enterContainer(): void {
    this.#depth += 1;
    if (this.#depth > MAX_REMOTE_JSON_NESTING_DEPTH) {
      throw new SyntaxError(`${this.#label} exceeds maximum JSON nesting depth ${MAX_REMOTE_JSON_NESTING_DEPTH}`);
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    while (this.#offset < this.#text.length) {
      const token = this.#text[this.#offset];
      if (token === "\"") {
        this.#offset += 1;
        try {
          return JSON.parse(this.#text.slice(start, this.#offset)) as string;
        } catch {
          this.#malformed();
        }
      }
      this.#offset += token === "\\" ? 2 : 1;
    }
    this.#malformed();
  }

  #number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.#text.slice(this.#offset));
    if (!match) this.#malformed();
    this.#offset += match[0].length;
  }

  #literal(value: "true" | "false" | "null"): void {
    if (!this.#text.startsWith(value, this.#offset)) this.#malformed();
    this.#offset += value.length;
  }

  #whitespace(): void {
    while (["\t", "\n", "\r", " "].includes(this.#text[this.#offset] ?? "")) this.#offset += 1;
  }

  #take(token: string): boolean {
    if (this.#text[this.#offset] !== token) return false;
    this.#offset += 1;
    return true;
  }

  #malformed(): never {
    throw new SyntaxError(`${this.#label} is not valid JSON near character ${this.#offset}`);
  }
}
