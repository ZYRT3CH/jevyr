import { describe, expect, it } from "vitest";
import { metabolicCostText, terminalText } from "../src/tui.js";
import { METABOLIC_RESOURCE_KEYS, type MetabolicOffer } from "@jevyr/protocol";
import { assertCommandInvocation, parseArguments } from "../src/arguments.js";

describe("terminal observer boundary", () => {
  it("removes escape sequences and embedded terminal controls from untrusted summaries", () => {
    expect(terminalText("safe\x1b[31mfailure\x1b[0m\r\nnext")).toBe("safefailure  next");
    expect(terminalText("a\x1b]8;;https://example.test\x07link\x1b]8;;\x07b")).toBe("alinkb");
    expect(terminalText("safe\u202epeels\u2066value")).toBe("safe peels value");
  });
  it("displays every nonzero resource ceiling without integer rounding",()=>{
    const offer={unitCostCeiling:Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key=>[key,key==="maxInputTokens"?Number.MAX_SAFE_INTEGER:0]))} as unknown as MetabolicOffer;
    expect(metabolicCostText(offer,64)).toBe("input tokens=576460752303423424");
  });
  it("permits a watch TUI but never a semantic TUI command or ambiguous JSON output", () => {
    expect(() => assertCommandInvocation(parseArguments(["watch", "case_a", "--tui"]))).not.toThrow();
    expect(() => assertCommandInvocation(parseArguments(["watch", "case_a", "--tui", "--json"]))).toThrow("mutually exclusive");
    expect(() => assertCommandInvocation(parseArguments(["cast", "approve", "--tui"]))).toThrow("does not accept");
  });
});
