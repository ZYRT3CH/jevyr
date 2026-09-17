#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createDaemonRuntime } from "./runtime.js";
import { serveMcpStdio } from "./mcp.js";
import { createJevyrHttpService } from "./server.js";
import { processDropFolder, serveJsonl } from "./transports.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "serve";
  if (command === "--help" || command === "help") {
    process.stdout.write("Usage: jevyr-daemon serve | mcp | jsonl | drop <directory> [--once]\nCast is the only semantic write. Every accepted Case seals and closes without continuation.\n");
    return;
  }
  if (command === "jsonl") {
    if (argv.length !== 1) throw new Error("Usage: jevyr-daemon jsonl");
    const runtime = createDaemonRuntime();
    try {
      await serveJsonl(runtime, { input: process.stdin, send: async (line) => await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
      }) });
    } finally { await runtime.close(); }
    return;
  }
  if (command === "drop") {
    const directory = argv[1];
    if (!directory || argv.length > 3 || (argv[2] !== undefined && argv[2] !== "--once")) throw new Error("Usage: jevyr-daemon drop <directory> [--once]");
    const runtime = createDaemonRuntime();
    const controller = new AbortController();
    const stop = (): void => { controller.abort(); runtime.orchestrator.abortAll(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      do {
        for (const result of await processDropFolder(runtime, directory, controller.signal)) process.stderr.write(`${JSON.stringify(result)}\n`);
        if (argv[2] === "--once" || controller.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 500);
          controller.signal.addEventListener("abort", done, { once: true });
        });
      } while (!controller.signal.aborted);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await runtime.close();
    }
    return;
  }
  if (command === "mcp") {
    const runtime = createDaemonRuntime();
    try {
      await serveMcpStdio(runtime);
    } finally {
      await runtime.close();
    }
    return;
  }
  if (command !== "serve") throw new Error(`Unknown daemon command: ${command}`);
  const port = Number(process.env.JEVYR_PORT ?? 4_317);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("JEVYR_PORT must be a TCP port");
  const host = process.env.JEVYR_HOST ?? "127.0.0.1";
  const service = createJevyrHttpService();
  const address = await service.listen(port, host);
  process.stderr.write(`Jevyr daemon listening at ${address.url}\n`);
  const shutdown = (): void => {
    void service.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`)) : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
