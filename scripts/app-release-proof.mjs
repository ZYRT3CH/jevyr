// Opt-in application proof from an extracted release, with a new empty project.
// The tested daemon uses Rule minds and unavailable Docker; no model calls.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {inflateRawSync} from 'node:zlib';

const hash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length!==4)throw Error('Usage: node scripts/app-release-proof.mjs RELEASE_DIRECTORY NEW_REPORT_DIRECTORY');
const release=resolve(process.argv[2]),output=resolve(process.argv[3]);await mkdir(output);
const receipt=JSON.parse(await readFile(`${release}.build.json`,'utf8')),zip=await readFile(`${release}.zip`);assert.equal(hash(zip),receipt.zipDigest);
const isolated=await mkdtemp(join(tmpdir(),'jevyr-standalone-app-')),application=join(isolated,'application'),project=join(isolated,'project');
assert.ok(relative(checkout,isolated).startsWith('..')||isAbsolute(relative(checkout,isolated)));await mkdir(application);await mkdir(project);
let offset=0,entries=0;const names=new Set();
while(zip.readUInt32LE(offset)===0x04034b50){
  assert.equal(zip.readUInt16LE(offset+6),0x800);assert.equal(zip.readUInt16LE(offset+8),8);
  const size=zip.readUInt32LE(offset+18),length=zip.readUInt32LE(offset+22),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
  const name=zip.subarray(offset+30,offset+30+nameLength).toString();assert.match(name,/^[A-Za-z0-9@_./+~-]+$/);assert.ok(name.split('/').every(x=>x&&x!=='.'&&x!=='..'));assert.ok(!names.has(name));names.add(name);
  const start=offset+30+nameLength+extra,bytes=inflateRawSync(zip.subarray(start,start+size));assert.equal(bytes.length,length);
  await mkdir(dirname(join(application,name)),{recursive:true});await writeFile(join(application,name),bytes,{flag:'wx'});offset=start+size;entries++;
}
assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(entries,receipt.files+1);
const env={SystemRoot:process.env.SystemRoot??'',WINDIR:process.env.WINDIR??'',TEMP:isolated,TMP:isolated,PATH:dirname(process.execPath),NODE_ENV:'production'};
const checks=[];let child,stdout='',stderr='',caseId;
const entry=join(application,'start.mjs');
const argv=command=>[entry,'--project',project,'--release-digest',receipt.releaseDigest,'--',...command];
async function run(command){return new Promise((done,reject)=>{const p=spawn(process.execPath,argv(command),{cwd:isolated,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>p.kill(),120000);p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',(exitCode,signal)=>{clearTimeout(timer);done({exitCode,signal,stdout:out,stderr:err});});});}
async function check(name,fn){try{const detail=await fn();checks.push({name,passed:true,...(detail?{detail}:{})});}catch(e){checks.push({name,passed:false,error:e.message});throw e;}finally{await save();}}
async function save(){await writeFile(join(output,'report.json'),JSON.stringify({protocol:'jevyr.standalone-application-proof/1',node:process.version,platform:process.platform,architecture:process.arch,application,project,releaseDigest:receipt.releaseDigest,zipDigest:receipt.zipDigest,checks,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,caseId:caseId??null,scope:'Fresh project and ZIP extraction outside checkout; normal compiled CLI up and official production Chamber. No pnpm/compiler/source dependency resolution. Rule-only template lifecycle with no configured model and Docker absent from child PATH; does not measure provider quality, physical Forge execution, original-source adjudication, or separate Couch/Horizon behavior.'},null,2)+'\n');}
async function port(){return new Promise((done,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const value=s.address().port;s.close(()=>done(value));});});}
async function wait(url){const deadline=Date.now()+90000;let last;while(Date.now()<deadline){if(child.exitCode!==null)throw Error(`Application exited ${child.exitCode}: ${stderr}`);try{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.ok)return r;}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw Error(`HTTP startup timed out: ${last?.message}`);}
let error;
try{
  const {verifyAppRelease}=await import(pathToFileURL(entry).href);
  await check('complete-extracted-release-inventory',async()=>{const m=await verifyAppRelease(application,receipt.releaseDigest);return {files:m.files.length,packages:m.packages.length};});
  await check('development-and-workspace-tools-absent',async()=>{const require=createRequire(entry);for(const name of ['pnpm','tsx','esbuild','typescript','vite'])assert.throws(()=>require.resolve(name));return {packages:['pnpm','tsx','esbuild','typescript','vite'],nodePath:env.PATH};});
  await check('fresh-project-initialization',async()=>{const r=await run(['init','--json']);await writeFile(join(output,'init.json'),r.stdout);await writeFile(join(output,'init.stderr.log'),r.stderr);assert.equal(r.exitCode,0,r.stderr);const policy=JSON.parse(await readFile(join(project,'.jevyr/policy.json'),'utf8'));assert.equal(policy.policyVersion,'bone-v2');return {policyVersion:policy.policyVersion};});
  const manifest=JSON.parse(await readFile(join(application,'release.json'),'utf8'));
  if(manifest.calibration){await check('explicit-calibration-installation',async()=>{const r=await run(['install-calibration']);await writeFile(join(output,'calibration-install.json'),r.stdout);assert.equal(r.exitCode,0,r.stderr);const installed=JSON.parse(r.stdout);assert.equal(installed.implementationDigest,manifest.calibration.implementationDigest);return {implementationDigest:installed.implementationDigest,entries:installed.snapshotEntries,consumerExperiment:false};});await check('existing-calibration-refused',async()=>{const prior=await readFile(join(project,'.jevyr/metabolic-calibrations/installation.json')),r=await run(['install-calibration']);assert.equal(r.exitCode,1);assert.match(r.stderr,/APP_CALIBRATION_DESTINATION_EXISTS/);assert.deepEqual(await readFile(join(project,'.jevyr/metabolic-calibrations/installation.json')),prior);});}
  const api=`http://127.0.0.1:${await port()}`,chamber=`http://127.0.0.1:${await port()}`;
  await writeFile(join(project,'.jevyr/config.json'),JSON.stringify({daemonUrl:api,chamberUrl:chamber,privacy:'local_only',control:'sovereign'},null,2)+'\n');
  // The wrapper is test-owned; it only provides a graceful stdin stop signal.
  const code=`import {main} from ${JSON.stringify(pathToFileURL(entry).href)};process.stdin.once('data',()=>{process.emit('SIGTERM');process.stdin.destroy();});await main(${JSON.stringify(argv(['up','--no-open','--json']).slice(1))});`;
  child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:isolated,env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  await check('production-health-and-routes',async()=>{await wait(`${api}/health`);await wait(chamber);const rows=[];for(const path of ['/','/airlock','/record','/genome-lab']){const r=await fetch(chamber+path),text=await r.text();assert.equal(r.status,200,`${path}: ${text.slice(0,300)}`);assert.match(text,new RegExp(`<meta[^>]+name="jevyr-daemon-origin"[^>]+content="${api.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`));await writeFile(join(output,`route-${path==='/'?'home':path.slice(1)}.html`),text);rows.push({path,status:r.status,bytes:Buffer.byteLength(text)});}return {api,chamber,routes:rows};});
  await check('production-cli-doctor',async()=>{const r=await run(['doctor','--json']);await writeFile(join(output,'doctor.json'),r.stdout);await writeFile(join(output,'doctor.stderr.log'),r.stderr);assert.equal(r.exitCode,3,r.stderr);const payload=JSON.parse(r.stdout);assert.equal(payload.protocol,'jevyr.doctor/2');assert.equal(payload.ready,false);assert.equal(payload.daemon.readiness.models.mode,'template-only');return {exitCode:r.exitCode,report:payload};});
  await check('fresh-signed-http-record-and-offline-replay',async()=>{const {JevyrClient}=await import(pathToFileURL(join(application,'node_modules/@jevyr/sdk/dist/index.js')).href);const client=new JevyrClient({baseUrl:api});const accepted=await client.cast({case:{impulse:'Consider whether a proposed plan has enough supporting evidence.',privacy:'local_only',control:'sovereign',seed:'1'.repeat(64),subjects:[]}});caseId=accepted.caseId;await save();const result=await client.waitForAuthenticatedRecord(caseId,{preferSse:false,signal:AbortSignal.timeout(180000)});const {exportLocalProof}=await import(pathToFileURL(join(application,'apps/cli/dist/local-proof.js')).href);const proof=await exportLocalProof(client,caseId,join(output,'proof'));assert.equal(proof.valid,true,JSON.stringify(proof.problems));assert.equal(result.payload.verdict.judgment,'UNPROVEN');await writeFile(join(output,'record.json'),JSON.stringify(result.payload,null,2)+'\n');await writeFile(join(output,'offline-verification.json'),JSON.stringify(proof,null,2)+'\n');return {caseId,verdict:result.payload.verdict,keyId:result.keyId,offlineReplayValid:true,recordUrl:`${chamber}/record?case=${caseId}`};});
  await check('application-tree-unchanged-after-running-and-installing',async()=>{await verifyAppRelease(application,receipt.releaseDigest);});
  // Stop all owned processes before tampering with the extracted test copy.
  child.stdin.write('stop');await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Application did not stop cleanly')),20000);child.once('close',()=>{clearTimeout(timer);done();});});child=undefined;
  await check('missing-and-substituted-file-refusals',async()=>{for(const [path,mode]of [['apps/cli/dist/chamber-server.js','substitute'],['node_modules/@jevyr/runtime/dist/repository-pure-assets/tree-sitter.wasm','missing']]){const file=join(application,path),original=await readFile(file);if(mode==='missing')await unlink(file);else await writeFile(file,Buffer.concat([original,Buffer.from('\n// altered fixture bytes\n')]));const result=await run(['doctor','--json']);assert.equal(result.exitCode,1);assert.match(result.stderr,/APP_RELEASE_FILE_(?:MISSING|MISMATCH)/);assert.equal(result.stdout,'');await writeFile(file,original);}await verifyAppRelease(application,receipt.releaseDigest);});
}catch(e){error=e;process.stderr.write(e.stack+'\n');}
finally{if(child){child.stdin.write('stop');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null)child.kill();}await writeFile(join(output,'application.stdout.log'),stdout);await writeFile(join(output,'application.stderr.log'),stderr);await save();}
process.exitCode=error?1:0;
