// Opt-in physical packaging test. Uses retained proofs only, never a model,
// daemon, compiler, package installation, submitted-source process or Docker.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cp,lstat,mkdir,mkdtemp,readFile,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inflateRawSync} from 'node:zlib';

const hash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const release=resolve(process.argv[2]??''),lifecycle=resolve(process.argv[3]??''),output=resolve(process.argv[4]??'');
if(process.argv.length!==5)throw Error('Usage: node scripts/replay-release-test.mjs RELEASE_DIRECTORY RETAINED_LIFECYCLE_ROOT NEW_REPORT_DIRECTORY');
await mkdir(output);
const build=JSON.parse(await readFile(`${release}.build.json`,'utf8')),declared=JSON.parse(await readFile(join(lifecycle,'report.json'),'utf8'));
const zip=await readFile(`${release}.zip`);assert.equal(hash(zip),build.zipDigest);
const isolated=await mkdtemp(join(tmpdir(),'jevyr-replay-release-'));
assert.ok(relative(root,isolated).startsWith('..')||isAbsolute(relative(root,isolated)),'test installation must be outside checkout');
const unpacked=join(isolated,'installation');await mkdir(unpacked);
// Test extraction independently reads the ZIP local headers and checks every
// extracted byte against the authenticated manifest in the actual verifier.
let offset=0,entries=0;const seen=new Set();
while(zip.readUInt32LE(offset)===0x04034b50){
  assert.equal(zip.readUInt16LE(offset+6),0x800);assert.equal(zip.readUInt16LE(offset+8),8);
  const size=zip.readUInt32LE(offset+18),uncompressed=zip.readUInt32LE(offset+22),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
  const name=zip.subarray(offset+30,offset+30+nameLength).toString('utf8');
  assert.match(name,/^[A-Za-z0-9@_./+-]+$/);assert.ok(name.split('/').every(x=>x&&x!=='.'&&x!=='..'));assert.ok(!seen.has(name));seen.add(name);
  const start=offset+30+nameLength+extra,bytes=inflateRawSync(zip.subarray(start,start+size));assert.equal(bytes.length,uncompressed);
  const target=join(unpacked,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});offset=start+size;entries++;
}
assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(entries,build.files+1);
const cases=[];let failed=0;
const timeoutMs=60_000;
async function child(label,proof,signer,{expectedValid=true,refusal,omitDigest=false}={}){
  const args=['--proof',proof,'--signer-key',signer,...(omitDigest?[]:['--release-digest',build.releaseDigest])];
  // Permission scope is only these two isolated directories. The sentinel
  // probes demonstrate denied checkout access and child/worker/write authority.
  const code=`import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(root,'package.json'))}),e=>e.code==='ERR_ACCESS_DENIED');
assert.equal(process.permission.has('child'),false);assert.equal(process.permission.has('worker'),false);assert.equal(process.permission.has('fs.write'),false);
const require=createRequire(${JSON.stringify(join(unpacked,'verify.mjs'))});
for(const name of ['tsx','esbuild','typescript','@jevyr/daemon','@jevyr/cli'])assert.throws(()=>require.resolve(name));
process.stderr.write(JSON.stringify({checkoutRead:'denied',child:'denied',worker:'denied',write:'denied',developmentPackages:'absent',cwd:process.cwd()})+'\\n');
const {main}=await import(${JSON.stringify(pathToFileURL(join(unpacked,'verify.mjs')).href)});await main(${JSON.stringify(args)});
assert.throws(()=>globalThis.fetch('http://127.0.0.1:1'),/REPLAY_RELEASE_NETWORK_DISABLED/);
const net=await import('node:net');assert.throws(()=>net.connect(1,'127.0.0.1'),/REPLAY_RELEASE_NETWORK_DISABLED/);
process.stderr.write(JSON.stringify({fetch:'denied-before-request',socket:'denied-before-connect'})+'\\n');`;
  const argv=['--permission',`--allow-fs-read=${unpacked}`,`--allow-fs-read=${proof}`,'--input-type=module','-e',code];
  const result=await new Promise((done,reject)=>{const p=spawn(process.execPath,argv,{cwd:isolated,env:{SystemRoot:process.env.SystemRoot??'',TEMP:isolated,TMP:isolated},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',size=0;const timer=setTimeout(()=>p.kill(),timeoutMs);p.stdout.on('data',b=>{size+=b.length;if(size>16_000_000)p.kill();else stdout+=b;});p.stderr.on('data',b=>{size+=b.length;if(size>16_000_000)p.kill();else stderr+=b;});p.once('error',reject);p.once('close',(code,signal)=>{clearTimeout(timer);done({exitCode:code,signal,stdout,stderr});});});
  await writeFile(join(output,`${label}.stdout.json`),result.stdout);await writeFile(join(output,`${label}.stderr.log`),result.stderr);
  let payload;try{payload=JSON.parse(result.stdout);}catch{}
  let passed=true,error;
  try{assert.match(result.stderr,/"checkoutRead":"denied"/);if(expectedValid){assert.equal(result.exitCode,0,result.stderr);assert.equal(payload.result.valid,true,JSON.stringify(payload.result.problems));assert.equal(payload.result.trustScope,'externally-pinned-key');}else{assert.notEqual(result.exitCode,0);if(refusal)assert.match(result.stderr+result.stdout,refusal);}}catch(e){passed=false;error=e.message;failed++;}
  const summary={label,passed,...(error?{error}:{}),exitCode:result.exitCode,signal:result.signal,expectedValid,resultValid:payload?.result.valid??false,judgment:payload?.result.verdict?.judgment??null,recordDigest:payload?.result.recordDigest??null,stdoutDigest:hash(result.stdout),stderrDigest:hash(result.stderr)};cases.push(summary);process.stdout.write(JSON.stringify(summary)+'\n');return passed;
}
const proofs=new Map();
for(const name of ['clean','defect','unsupported']){
  const proof=join(isolated,`proof-${name}`);await cp(join(lifecycle,name,'proof'),proof,{recursive:true,errorOnExist:true,force:false});
  const fixture=declared.attempts.find(a=>a.fixture===name);assert.match(fixture.signerKeyId,/^sha256:[a-f0-9]{64}$/);proofs.set(name,{path:proof,signer:fixture.signerKeyId});
  await child(`positive-${name}`,proof,fixture.signerKeyId);
}
const clean=proofs.get('clean');
const changed=join(unpacked,'node_modules/@jevyr/runtime/dist/original-subject-certificate.js'),original=await readFile(changed);
await writeFile(changed,Buffer.concat([original,Buffer.from('\n// changed bytes\n')]));await child('substituted-checker',clean.path,clean.signer,{expectedValid:false,refusal:/RELEASE_FILE_MISMATCH/});await writeFile(changed,original);
const missing=join(unpacked,'node_modules/@jevyr/runtime/dist/repository-pure-assets/tree-sitter.wasm'),wasm=await readFile(missing);
assert.ok(relative(isolated,missing)&&!relative(isolated,missing).startsWith('..'));await unlink(missing);await child('missing-parser',clean.path,clean.signer,{expectedValid:false,refusal:/RELEASE_FILE_MISSING/});await writeFile(missing,wasm,{flag:'wx'});
await child('wrong-proof-signer',clean.path,`sha256:${'0'.repeat(64)}`,{expectedValid:false,refusal:/independently pinned signer/});
await child('missing-external-release-digest',clean.path,clean.signer,{expectedValid:false,refusal:/Usage:/,omitDigest:true});
const manifestPath=join(unpacked,'release.json'),manifestOriginal=await readFile(manifestPath),manifest=JSON.parse(manifestOriginal);manifest.scope+=' changed';await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
await child('changed-manifest',clean.path,clean.signer,{expectedValid:false,refusal:/RELEASE_MANIFEST_DIGEST_MISMATCH/});await writeFile(manifestPath,manifestOriginal);
const report={protocol:'jevyr.replay-release-isolation-proof/1',observedAt:new Date().toISOString(),node:process.version,archive:release,isolatedDirectory:isolated,
 releaseDigest:build.releaseDigest,zipDigest:build.zipDigest,zipEntries:entries,passed:cases.filter(c=>c.passed).length,failed,skipped:0,cases,
 scope:'Fresh Node24 processes from ZIP extracted outside checkout. Node permission enforcement allows filesystem reads only from isolated installation and separately copied proof, and denies checkout read/child/worker/write. Archive entry disables networking. No compiler, daemon, model, Docker or submitted-source execution. Proof signer pins are taken from separately retained fixture lifecycle report, not proof trust.json. Release digest is caller-provided; unsigned local build evidence is not publisher authentication.',
 scripts:[fileURLToPath(import.meta.url),join(root,'scripts/replay-release-build.mjs'),join(root,'scripts/replay-release-verify.mjs')].map(p=>({path:relative(root,p).replaceAll('\\','/')}))};
for(const entry of report.scripts)entry.digest=hash(await readFile(join(root,entry.path)));
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');process.exitCode=failed?1:0;
