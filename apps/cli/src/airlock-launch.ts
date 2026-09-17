import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

/** Prepare editable fields only. Opening this URL cannot save or seal a Case. */
export async function airlockLaunchUrl(base: string, path: string | undefined, chamber: string, daemon: string): Promise<string> {
  const source = resolve(base, path ?? "."), stats = await lstat(source);
  if (stats.isSymbolicLink() || !stats.isFile() && !stats.isDirectory()) throw new TypeError("Airlock source must be a plain file or directory");
  const url = new URL("airlock", chamber.endsWith("/") ? chamber : `${chamber}/`);
  const api = new URL(daemon);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !["http:", "https:"].includes(api.protocol) || api.username || api.password) throw new TypeError("Airlock addresses must be HTTP(S) URLs without embedded credentials");
  url.searchParams.set("api", api.toString());
  url.searchParams.set("subject-kind", stats.isDirectory() ? "directory" : "file");
  url.searchParams.set("subject-locator", source);
  return url.toString();
}
