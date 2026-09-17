import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseJsonText } from "@jevyr/core";

export interface ProviderLauncher { readonly command:string; readonly args:readonly string[] }
/** Resolve known npm providers without executing a PowerShell/batch shim. */
export function providerLauncher(provider:"codex"|"claude", options:{command?:string;launcherArgs?:readonly string[]}, source:NodeJS.ProcessEnv=process.env, platform:NodeJS.Platform=process.platform):ProviderLauncher {
  if(options.command!==undefined||platform!=="win32")return{command:options.command??provider,args:options.launcherArgs??[]};
  const paths=(source.Path??source.PATH??"").split(delimiter).filter(path=>path&&isAbsolute(path));
  // Preserve CreateProcess's native .exe lookup before considering npm shims.
  for(const directory of paths){const binary=join(directory,`${provider}.exe`);if(existsSync(binary)&&statSync(binary).isFile())return{command:realpathSync(binary),args:options.launcherArgs??[]};}
  const packageName=provider==="codex"?"@openai/codex":"@anthropic-ai/claude-code";
  for(const directory of paths) {
    const manifest=join(directory,"node_modules",packageName,"package.json");if(!existsSync(manifest))continue;
    try {
      if(statSync(manifest).size>65_536)continue;
      const metadata=parseJsonText(readFileSync(manifest,"utf8"),"Provider installation manifest") as {name?:unknown;bin?:unknown};
      if(metadata.name!==packageName)continue;
      const entry=typeof metadata.bin==="string"?metadata.bin:metadata.bin&&typeof metadata.bin==="object"?(metadata.bin as Record<string,unknown>)[provider]:undefined;
      if(typeof entry!=="string"||entry.length>1024||isAbsolute(entry)||/[\r\n\0]/u.test(entry))continue;
      const root=realpathSync(join(directory,"node_modules",packageName)),binary=realpathSync(resolve(root,entry)),path=relative(root,binary);
      if(!path||path.startsWith(`..${sep}`)||path===".."||isAbsolute(path)||!statSync(binary).isFile())continue;
      if(/\.exe$/iu.test(binary))return{command:binary,args:options.launcherArgs??[]};
      if(/\.[cm]?js$/iu.test(binary))return{command:process.execPath,args:[binary,...(options.launcherArgs??[])]};
    } catch { /* A broken or substituted installation is unavailable, never shell input. */ }
  }
  return{command:provider,args:options.launcherArgs??[]};
}
