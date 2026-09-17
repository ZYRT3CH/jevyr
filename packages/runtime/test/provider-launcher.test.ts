import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,mkdir,writeFile,rm,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {providerLauncher} from "../src/adapters/provider-launcher.js";

test("Windows npm launcher resolution reads a bounded manifest and invokes native code without a shell",async()=>{
 const root=await mkdtemp(join(tmpdir(),"jevyr-provider-launcher-"));
 try{
  const packageRoot=join(root,"node_modules","@anthropic-ai","claude-code"),entry=join(packageRoot,"bin","claude.exe");await mkdir(join(packageRoot,"bin"),{recursive:true});await writeFile(entry,"synthetic binary path fixture");
  const manifest=join(packageRoot,"package.json");await writeFile(manifest,JSON.stringify({name:"@anthropic-ai/claude-code",bin:{claude:"bin/claude.exe"}}));await writeFile(join(root,"claude.cmd"),"this shim must never be parsed or executed");
  assert.deepEqual(providerLauncher("claude",{}, {PATH:root},"win32"),{command:await realpath(entry),args:[]});
  await writeFile(manifest,JSON.stringify({name:"@anthropic-ai/claude-code",bin:{claude:"../../outside.exe"}}));assert.equal(providerLauncher("claude",{},{PATH:root},"win32").command,"claude");
  await writeFile(manifest,JSON.stringify({name:"wrong-provider",bin:{claude:"bin/claude.exe"}}));assert.equal(providerLauncher("claude",{},{PATH:root},"win32").command,"claude");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("native PATH binaries and explicit configured launchers retain their exact argument boundary",async()=>{
 const root=await mkdtemp(join(tmpdir(),"jevyr-provider-native-"));
 try{const entry=join(root,"codex.exe");await writeFile(entry,"synthetic native fixture");assert.deepEqual(providerLauncher("codex",{launcherArgs:["fixed"]},{PATH:root},"win32"),{command:await realpath(entry),args:["fixed"]});
  assert.deepEqual(providerLauncher("codex",{command:process.execPath,launcherArgs:["entry.js","literal;$value"]},{PATH:root},"win32"),{command:process.execPath,args:["entry.js","literal;$value"]});
 }finally{await rm(root,{recursive:true,force:true});}
});
