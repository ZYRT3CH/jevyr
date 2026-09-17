import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { parseJsonText } from "@jevyr/core";

interface RpcResponse {
  readonly id?: number|string;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}
export class JsonLineRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly notifications = new Set<(message: RpcResponse) => void>();
  private readonly exited: Promise<void>;
  private readonly detachAbort: () => void;
  private nextId = 1;
  private stderr = "";
  private didExit = false;
  private closePromise: Promise<void> | undefined;
  private requestHandler: ((method:string,params:Record<string,unknown>)=>Promise<unknown>) | undefined;
  private activeServerRequests=0;
  private observedBytes=0;

  constructor(
    command: string,
    launcherArgs: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    private readonly shutdownGraceMs: number,
    maxOutputBytes: number,
  ) {
    this.child = spawn(command, [...launcherArgs, "app-server", "--listen", "stdio://"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveExit!: () => void;
    this.exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_000);
      this.observedBytes+=Buffer.byteLength(chunk);
      if(this.observedBytes>maxOutputBytes){this.rejectAll(new Error("Codex combined capture bound exceeded"));if(!this.child.killed)this.child.kill("SIGTERM");}
    });
    let stdoutBytes = 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      this.observedBytes+=chunk.byteLength;
      if (this.observedBytes <= maxOutputBytes) return;
      this.rejectAll(new Error(`Codex app-server exceeded the ${maxOutputBytes}-byte output limit`));
      if (!this.child.killed) this.child.kill("SIGTERM");
    });
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity, terminal: false });
    lines.on("line", (line) => this.receive(line));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => {
      this.didExit = true;
      this.detachAbort();
      this.rejectAll(new Error(`Codex app-server closed with ${code}: ${this.stderr}`));
      resolveExit();
    });
    const onAbort = (): void => {
      void this.close().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) queueMicrotask(onAbort);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (!error) return;
          this.pending.delete(id);
          reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child.stdin.writable) throw new Error("Codex app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  onNotification(listener: (message: RpcResponse) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(handler:(method:string,params:Record<string,unknown>)=>Promise<unknown>):void {this.requestHandler=handler;}

  async close(): Promise<void> {
    this.closePromise ??= this.terminate();
    return await this.closePromise;
  }

  diagnostic(): string {
    return this.stderr;
  }
  outputBytes():number{return this.observedBytes;}

  private receive(line: string): void {
    let message: RpcResponse;
    try {
      message = parseJsonText(line, "Codex app-server response") as RpcResponse;
    } catch {
      return;
    }
    if(message.id!==undefined&&message.method) {
      if(++this.activeServerRequests>4){this.rejectAll(new Error("Codex exceeded concurrent context-call allowance"));void this.close();return;}
      const respond=(body:unknown)=>{if(this.child.stdin.writable)this.child.stdin.write(`${JSON.stringify(body)}\n`);};
      const action=this.requestHandler?this.requestHandler(message.method,message.params??{}):Promise.reject(new Error("Server request denied"));
      void action.then(result=>respond({id:message.id,result}),()=>respond({id:message.id,error:{code:-32601,message:"Only explicitly granted sealed context inspections are available"}})).finally(()=>{this.activeServerRequests--;});
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? `App-server RPC ${message.error.code ?? "error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) for (const listener of this.notifications) listener(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async terminate(): Promise<void> {
    this.detachAbort();
    if (this.didExit) return;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (await this.waitForExit(this.shutdownGraceMs)) return;
    if (!this.child.killed) this.child.kill("SIGTERM");
    if (await this.waitForExit(this.shutdownGraceMs)) return;
    this.child.kill("SIGKILL");
    if (await this.waitForExit(this.shutdownGraceMs)) return;
    throw new Error(`Codex app-server did not exit after bounded termination: ${this.stderr}`);
  }

  private async waitForExit(milliseconds: number): Promise<boolean> {
    if (this.didExit) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, milliseconds));
      timer.unref();
    });
    const exited = this.exited.then(() => true);
    const result = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
