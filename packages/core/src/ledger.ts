import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CaseEvent, EventKind } from "@jevyr/protocol";
import { createCaseEvent, verifyEventChain, type ChainVerification, type EventDraft } from "./events.js";
import { parseJsonText } from "./json.js";

export interface AppendOnlyLedger {
  append<K extends EventKind>(draft: EventDraft<K>): Promise<CaseEvent<K>>;
  read(): Promise<readonly CaseEvent[]>;
  verify(): Promise<ChainVerification>;
}

function assertDraftIdentity(draft: EventDraft, expectedCaseDigest: string, expectedRunDigest: string): void {
  if (draft.caseDigest !== expectedCaseDigest) throw new TypeError("Cannot append an event for a different sealed case");
  if (draft.runDigest !== expectedRunDigest) throw new TypeError("Cannot append an event for a different run");
}

export class MemoryLedger implements AppendOnlyLedger {
  readonly #caseDigest: string;
  readonly #runDigest: string;
  readonly #events: CaseEvent[] = [];

  constructor(caseDigest: string, runDigest: string) {
    this.#caseDigest = caseDigest;
    this.#runDigest = runDigest;
  }

  async append<K extends EventKind>(draft: EventDraft<K>): Promise<CaseEvent<K>> {
    assertDraftIdentity(draft, this.#caseDigest, this.#runDigest);
    const prior = this.#events.at(-1)?.eventDigest ?? null;
    const event = createCaseEvent(draft, this.#events.length + 1, prior);
    this.#events.push(event as CaseEvent);
    return structuredClone(event);
  }

  async read(): Promise<readonly CaseEvent[]> {
    return structuredClone(this.#events);
  }

  async verify(): Promise<ChainVerification> {
    return verifyEventChain(this.#events);
  }
}

export class FileLedger implements AppendOnlyLedger {
  readonly #path: string;
  readonly #caseDigest: string;
  readonly #runDigest: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, caseDigest: string, runDigest: string) {
    this.#path = path;
    this.#caseDigest = caseDigest;
    this.#runDigest = runDigest;
  }

  async read(): Promise<readonly CaseEvent[]> {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(this.#path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      try {
        return parseJsonText(line, `JSONL event at line ${index + 1}`) as CaseEvent;
      } catch (error) {
        throw new SyntaxError(`Invalid JSONL event at line ${index + 1}: ${(error as Error).message}`);
      }
    });
  }

  async append<K extends EventKind>(draft: EventDraft<K>): Promise<CaseEvent<K>> {
    assertDraftIdentity(draft, this.#caseDigest, this.#runDigest);
    let resolve!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((done) => { resolve = done; });
    await predecessor;
    try {
      const events = await this.read();
      const verification = verifyEventChain(events);
      if (!verification.valid) throw new Error(`Refusing to append to a corrupt ledger: ${verification.problems.map((item) => item.code).join(", ")}`);
      if (events.some((event) => event.caseDigest !== this.#caseDigest || event.runDigest !== this.#runDigest)) {
        throw new Error("Refusing to append: ledger identity differs from the sealed run");
      }
      const event = createCaseEvent(draft, events.length + 1, verification.headDigest);
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(this.#path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    } finally {
      resolve();
    }
  }

  async verify(): Promise<ChainVerification> {
    return verifyEventChain(await this.read());
  }
}
