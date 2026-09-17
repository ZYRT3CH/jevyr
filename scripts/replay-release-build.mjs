import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,mkdir,writeFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync} from 'node:zlib';
import {verifyReleaseInventory} from './replay-release-verify.mjs';

const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const safe=value=>/^[A-Za-z0-9@_./+-]+$/.test(value)&&value.split('/').every(p=>p&&p!=='.'&&p!=='..');
const workspace={core:'packages/core',protocol:'packages/protocol',runtime:'packages/runtime',sdk:'packages/sdk',growth:'packages/growth',memory:'packages/memory'};
const fail=code=>{throw new Error(code);};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function bytes(path,max=32_000_000){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('BUILD_INPUT_REFUSED');const b=await readFile(path),a=await lstat(path);if(b.length!==s.size||a.ino!==s.ino||a.dev!==s.dev||a.size!==s.size)fail('BUILD_INPUT_CHANGED');return b;}
async function collect(directory,filter){const result=[];async function visit(rel=''){for(const n of (await readdir(join(directory,rel))).sort()){const p=rel?`${rel}/${n}`:n;if(!safe(p))fail('BUILD_PATH_REFUSED');const s=await lstat(join(directory,p));if(s.isSymbolicLink())fail('BUILD_NESTED_SYMLINK');if(s.isDirectory()){if(filter(p,true))await visit(p);}else if(s.isFile()&&filter(p,false))result.push(p);}}await visit();return result;}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
// Closed ZIP32 writer: regular UTF-8 paths only; no filesystem traversal and no
// platform-specific compression command or third-party archive dependency.
export function releaseZip(files){const out=[],central=[];let offset=0;for(const [name,raw]of [...files].sort(([a],[b])=>a<b?-1:1)){if(!safe(name))fail('ZIP_PATH');const n=Buffer.from(name),compressed=deflateRawSync(raw),crc=crc32(raw),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(n.length,26);out.push(header,n,compressed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=header.length+n.length+compressed.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...out,cd,end]);}
async function freezeCheck(freeze){for(const f of freeze.files){if(!safe(f.path)||hash(await bytes(join(root,f.path)))!==f.digest)fail(`FROZEN_INSTALLATION_CHANGED:${f.path}`);}}
async function packageRoot(owner,name){const r=createRequire(join(owner,'package.json'));try{return dirname(await realpath(r.resolve(`${name}/package.json`)));}catch{}let d=dirname(await realpath(r.resolve(name)));for(;;){try{if(JSON.parse((await bytes(join(d,'package.json'))).toString()).name===name)return d;}catch{}const p=dirname(d);if(p===d)fail(`DEPENDENCY_UNRESOLVED:${name}`);d=p;}}

export async function buildReplayRelease(destination,freezePath){
  const target=resolve(destination),freezeRaw=await bytes(resolve(freezePath)),freeze=JSON.parse(freezeRaw.toString());
  if(freeze.protocol!=='jevyr.installed-method-freeze/1'||!Array.isArray(freeze.files)||freeze.files.length>5000)fail('FREEZE_REQUIRED');
  await freezeCheck(freeze); await mkdir(target); // fresh output only; never overwrite an installation
  const files=new Map(),origins=new Map(),packages=[];let total=0;
  async function add(path,source){if(!safe(path)||files.has(path))fail('BUILD_DUPLICATE_PATH');const b=await bytes(source);total+=b.length;if(files.size>=20_000||total>256_000_000)fail('BUILD_SIZE_LIMIT');files.set(path,Buffer.from(b));origins.set(path,{source,digest:hash(b)});}
  await add('verify.mjs',join(root,'scripts/replay-release-verify.mjs'));
  for(const name of ['local-proof.js','replay.js'])await add(`cli/${name}`,join(root,'apps/cli/dist',name));
  files.set('package.json',Buffer.from('{"name":"jevyr-offline-replay-release","private":true,"type":"module","engines":{"node":"24.x"}}\n'));
  const queue=[];
  for(const [short,path]of Object.entries(workspace)){
    const from=join(root,path),name=`@jevyr/${short}`,manifest=JSON.parse((await bytes(join(from,'package.json'))).toString());
    packages.push({name,version:manifest.version,scope:'exact-workspace-compiled'});
    await add(`node_modules/${name}/package.json`,join(from,'package.json'));
    for(const p of await collect(join(from,'dist'),(p,dir)=>dir?!['src','test','tests'].includes(p.split('/')[0]):/\.(?:js|mjs|wasm|json|bin)$/.test(p)))await add(`node_modules/${name}/dist/${p}`,join(from,'dist',p));
    if(short==='core')for(const p of await collect(join(from,'policy'),(_p,dir)=>dir||/\.(?:wasm|rego|json)$/.test(_p)))await add(`node_modules/${name}/policy/${p}`,join(from,'policy',p));
    for(const dep of Object.keys(manifest.dependencies??{}))if(!dep.startsWith('@jevyr/'))queue.push({owner:from,name:dep});
  }
  const selected=new Map();
  for(let i=0;i<queue.length;i++){
    const {owner,name}=queue[i];if(!safe(name))fail('DEPENDENCY_NAME');
    const from=await packageRoot(owner,name),manifestBytes=await bytes(join(from,'package.json')),manifest=JSON.parse(manifestBytes.toString());
    if(manifest.name!==name)fail('DEPENDENCY_IDENTITY');
    if(selected.has(name)){if(selected.get(name)!==hash(manifestBytes))fail('DEPENDENCY_VERSION_CONFLICT');continue;}
    selected.set(name,hash(manifestBytes));packages.push({name,version:manifest.version,scope:'production-dependency'});
    if(selected.size>128)fail('DEPENDENCY_COUNT');
    const paths=await collect(from,(p,dir)=>{
      const parts=p.split('/');if(parts.some(x=>['node_modules','.git','test','tests','__tests__','examples','benchmark','benchmarks'].includes(x)))return false;
      if(name==='tree-sitter-wasms')return dir?p==='out':['package.json','out/tree-sitter-javascript.wasm'].includes(p);
      return dir||/\.(?:js|mjs|cjs|json|wasm)$/.test(p)||/^licen[cs]e(?:\.|$)/i.test(p);
    });
    for(const p of paths)await add(`node_modules/${name}/${p}`,join(from,p));
    for(const dep of Object.keys(manifest.dependencies??{}))queue.push({owner:from,name:dep});
  }
  // Capture first, then write only immutable captured buffers. Re-read every
  // source at the end and compare the original frozen installation again.
  const inventory=[...files].sort(([a],[b])=>a<b?-1:1).map(([path,b])=>({path,digest:hash(b),byteLength:b.length}));
  const manifest={protocol:'jevyr.replay-release/1',node:'24.x',entry:'cli/local-proof.js',freeze:hash(freezeRaw),packages:packages.sort((a,b)=>a.name<b.name?-1:1),files:inventory,totalBytes:inventory.reduce((n,f)=>n+f.byteLength,0),scope:'Matching compiled verifier archive; no source checkout, development package dependencies, daemon, models, private store, or signer secrets. Build-tool bytes inside producer provenance are retained inert evidence, never executable build dependencies.'};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),releaseDigest=hash(manifestBytes);files.set('release.json',manifestBytes);
  for(const [p,b]of files){const absolute=join(target,p);await mkdir(dirname(absolute),{recursive:true});await writeFile(absolute,b,{flag:'wx'});}
  for(const {source,digest}of origins.values())if(hash(await bytes(source))!==digest)fail('BUILD_SOURCE_RACED');
  await freezeCheck(freeze);await verifyReleaseInventory(target,releaseDigest);
  const zip=releaseZip(files);await writeFile(`${target}.zip`,zip,{flag:'wx'});
  const receipt={protocol:'jevyr.replay-release-build/1',directory:target,releaseDigest,zipDigest:hash(zip),zipBytes:zip.length,files:inventory.length,bytes:manifest.totalBytes,packages:packages.length,frozenFiles:freeze.files.length,frozenUnchanged:true,trust:'Release digest must be obtained independently; this unsigned build receipt is not a trust root.'};
  await writeFile(`${target}.build.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw Error('Usage: node scripts/replay-release-build.mjs NEW_DIRECTORY INSTALLED_FREEZE_JSON');
  buildReplayRelease(process.argv[2],process.argv[3]).then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
}
