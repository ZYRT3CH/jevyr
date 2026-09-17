import { spawn } from "node:child_process";
import { exactByteCapture, MAX_EXACT_BYTE_CAPTURE_BYTES } from "./evidence-artifacts.js";
import type { ExactByteCapture } from "./typed-oracles.js";

export interface BoundedProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to true for compatibility. Security boundaries should opt out. */
  readonly inheritEnv?: boolean;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Combined stdout + stderr ceiling. Bytes beyond it are never retained. */
  readonly maxOutputBytes?: number;
  /**
   * When true, crossing maxOutputBytes terminates the child. Forge enables
   * this because a truncated stream is a physical-policy violation, not just
   * a presentation concern.
   */
  readonly terminateOnOutputLimit?: boolean;
  /** Optional asynchronous physical-limit monitor (for example, disk usage). */
  readonly limitMonitor?: {
    readonly intervalMs: number;
    /** Return a stable public reason when the external limit was crossed. */
    inspect(): Promise<string | undefined>;
  };
  readonly signal?: AbortSignal;
}

export type ProcessTerminationReason =
  | "exit"
  | "timeout"
  | "aborted"
  | "output-limit"
  | "external-limit";

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Replacement-decoded diagnostic convenience; never authoritative evidence. */
  readonly stdout: string;
  /** Replacement-decoded diagnostic convenience; never authoritative evidence. */
  readonly stderr: string;
  /** Exact retained bytes plus total observed length; authoritative over replacement text. */
  readonly stdoutCapture: ExactByteCapture;
  readonly stderrCapture: ExactByteCapture;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
  /** Exact bytes observed from both pipes, including bytes not retained. */
  readonly outputBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputLimitBytes: number;
  readonly terminationReason: ProcessTerminationReason;
  readonly limitDetail?: string;
  readonly durationMs: number;
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 0
    || maxOutputBytes > MAX_EXACT_BYTE_CAPTURE_BYTES) {
    throw new TypeError(`maxOutputBytes must be a safe integer from 0 through ${MAX_EXACT_BYTE_CAPTURE_BYTES}`);
  }
  if (
    options.limitMonitor !== undefined
    && (!Number.isSafeInteger(options.limitMonitor.intervalMs) || options.limitMonitor.intervalMs < 10)
  ) {
    throw new TypeError("limitMonitor.intervalMs must be a safe integer of at least 10 milliseconds");
  }

  return await new Promise<BoundedProcessResult>((resolve, reject) => {
    const inherited = options.inheritEnv === false ? {} : process.env;
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ? { ...inherited, ...options.env } : inherited,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let retainedBytes = 0;
    let terminationReason: ProcessTerminationReason = "exit";
    let limitDetail: string | undefined;
    let monitorTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const addObserved = (current: number, added: number): number =>
      Math.min(Number.MAX_SAFE_INTEGER, current + added);

    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (escalationTimer === undefined) {
        escalationTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1_000);
        escalationTimer.unref();
      }
    };

    const requestStop = (reason: Exclude<ProcessTerminationReason, "exit">, detail?: string): void => {
      if (terminationReason === "exit") {
        terminationReason = reason;
        limitDetail = detail;
      }
      stop();
    };

    const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (retainedBytes >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - retainedBytes;
      if (chunk.length > remaining) truncated = true;
      const retained = chunk.subarray(0, remaining);
      retainedBytes += retained.byteLength;
      return Buffer.concat([current, retained]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = addObserved(stdoutBytes, chunk.byteLength);
      stdout = collect(stdout, chunk);
      if (addObserved(stdoutBytes, stderrBytes) > maxOutputBytes && options.terminateOnOutputLimit === true) {
        requestStop("output-limit", `combined process output exceeded ${maxOutputBytes} bytes`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = addObserved(stderrBytes, chunk.byteLength);
      stderr = collect(stderr, chunk);
      if (addObserved(stdoutBytes, stderrBytes) > maxOutputBytes && options.terminateOnOutputLimit === true) {
        requestStop("output-limit", `combined process output exceeded ${maxOutputBytes} bytes`);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      requestStop("timeout");
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      requestStop("aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    const scheduleMonitor = (): void => {
      if (settled || options.limitMonitor === undefined) return;
      monitorTimer = setTimeout(() => {
        void (async () => {
          let violation: string | undefined;
          try {
            violation = await options.limitMonitor?.inspect();
          } catch (error) {
            violation = `physical limit monitor failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (settled) return;
          if (violation !== undefined) requestStop("external-limit", violation);
          else scheduleMonitor();
        })();
      }, options.limitMonitor.intervalMs);
      monitorTimer.unref();
    };
    scheduleMonitor();

    const cleanup = (): void => {
      clearTimeout(timer);
      if (monitorTimer !== undefined) clearTimeout(monitorTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const outputBytes = addObserved(stdoutBytes, stderrBytes);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutCapture: exactByteCapture(stdout, stdoutBytes),
        stderrCapture: exactByteCapture(stderr, stderrBytes),
        timedOut,
        aborted,
        truncated,
        outputBytes,
        stdoutBytes,
        stderrBytes,
        outputLimitBytes: maxOutputBytes,
        terminationReason,
        ...(limitDetail === undefined ? {} : { limitDetail }),
        durationMs: Math.round(performance.now() - started),
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}
