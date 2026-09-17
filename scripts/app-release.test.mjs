import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {verifyAppRelease} from './app-release-start.mjs';
import {publishAppCalibration,validateAppCalibration} from './app-release-calibration.mjs';
import {sourcePackage} from './app-release-build.mjs';
import {releaseZip} from './app-release-zip.mjs';
import {inflateRawSync} from 'node:zlib';

const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source=dirname(fileURLToPath(import.meta.url));
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'jevyr-app-release-test-')),release=join(directory,'release'),project=join(directory,'project');
  await mkdir(join(release,'apps/cli/dist'),{recursive:true});await mkdir(project);
  const files=new Map([
    ['start.mjs',await readFile(join(source,'app-release-start.mjs'))],
    ['package.json',Buffer.from('{"type":"module"}\n')],
    ['apps/cli/dist/main.js',Buffer.from('export async function main(args){process.stdout.write(JSON.stringify({cwd:process.cwd(),args,initCwd:process.env.INIT_CWD??null}));return 0;}\n')],
  ]);
  const manifest={protocol:'jevyr.local-application-release/1',node:'24.x',platform:process.platform,architecture:process.arch,entry:'apps/cli/dist/main.js',freezeDigest:hash('fixture-only'),packages:[],files:[...files].sort(([a],[b])=>a<b?-1:1).map(([path,bytes])=>({path,digest:hash(bytes),byteLength:bytes.length})),totalBytes:[...files.values()].reduce((n,b)=>n+b.length,0),omissions:[],calibration:null,scope:'Generated launcher fixture only; no application or empirical release authority.'};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  for(const [path,bytes]of files)await writeFile(join(release,path),bytes);
  await writeFile(join(release,'release.json'),manifestBytes);
  return {directory,release,project,manifest,digest:hash(manifestBytes)};
}
async function rewrite(f,change){change(f.manifest);const bytes=Buffer.from(JSON.stringify(f.manifest,null,2)+'\n');await writeFile(join(f.release,'release.json'),bytes);return hash(bytes);}
function run(f,args=[]){return spawnSync(process.execPath,[join(f.release,'start.mjs'),'--project',f.project,'--release-digest',f.digest,'--','doctor',...args],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',INIT_CWD:source},timeout:30000});}

test('complete bounded inventory and explicit independent project are enforced',async()=>{
  const f=await fixture();assert.equal((await verifyAppRelease(f.release,f.digest)).files.length,3);
  const result=run(f,['--json']);assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout);assert.equal(resolve(observed.cwd),resolve(f.project));assert.deepEqual(observed.args,['doctor','--json']);assert.equal(observed.initCwd,null);
});
test('missing, substituted and extra release bytes are refused before CLI invocation',async()=>{
  for(const mutation of ['missing','substituted','extra']){
    const f=await fixture();
    if(mutation==='missing')await rm(join(f.release,'apps/cli/dist/main.js'));
    if(mutation==='substituted')await writeFile(join(f.release,'apps/cli/dist/main.js'),'throw Error("must never execute");');
    if(mutation==='extra')await writeFile(join(f.release,'ambient.js'),'export default 1;');
    const result=run(f);assert.equal(result.status,1);assert.match(result.stderr,/APP_RELEASE_(?:FILE_MISSING|FILE_MISMATCH|EXTRA_FILE)/);assert.equal(result.stdout,'');
  }
});
test('external digest is required and malformed or duplicate path inventories are refused',async()=>{
  const f=await fixture();await assert.rejects(verifyAppRelease(f.release,undefined),/EXTERNAL_APP_RELEASE_DIGEST_REQUIRED/);
  await assert.rejects(verifyAppRelease(f.release,hash('foreign')),/APP_RELEASE_MANIFEST_MISMATCH/);
  for(const mutation of [m=>m.files.push({...m.files[0]}),m=>m.files[0].path='../escape',m=>m.files[0].byteLength=-1,m=>m.files[0].unknown=true]){
    const current=await fixture(),digest=await rewrite(current,mutation);await assert.rejects(verifyAppRelease(current.release,digest),/APP_RELEASE_MANIFEST_ENTRY/);
  }
});
test('separation, host platform and default loader are required',async()=>{
  const f=await fixture();
  const nested=spawnSync(process.execPath,[join(f.release,'start.mjs'),'--project',f.release,'--release-digest',f.digest,'--','doctor'],{encoding:'utf8',timeout:30000});
  assert.equal(nested.status,1);assert.match(nested.stderr,/APPLICATION_AND_PROJECT_MUST_BE_SEPARATE/);
  const changed=await rewrite(f,m=>m.platform=process.platform==='win32'?'linux':'win32');
  const wrong=run({...f,digest:changed});assert.equal(wrong.status,1);assert.match(wrong.stderr,/APP_RELEASE_PLATFORM_MISMATCH/);
  const injected=spawnSync(process.execPath,['--conditions=development',join(f.release,'start.mjs'),'--project',f.project,'--release-digest',changed,'--','doctor'],{encoding:'utf8',timeout:30000});
  assert.equal(injected.status,1);assert.match(injected.stderr,/DEFAULT_NODE_LOADER_REQUIRED/);
  const store=spawnSync(process.execPath,[join(f.release,'start.mjs'),'--project',f.project,'--release-digest',changed,'--','doctor'],{encoding:'utf8',timeout:30000,env:{...process.env,JEVYR_DATA_DIR:join(f.release,'state')}});
  assert.equal(store.status,1);assert.match(store.stderr,/APPLICATION_AND_STORE_MUST_BE_SEPARATE/);
});
test('calibration publication remains private until complete and preserves existing destinations',async()=>{
  const f=await fixture(),files=new Map([['fixture.json',Buffer.from('{"generated":true}')]]),marker={protocol:'fixture-only'};
  await assert.rejects(publishAppCalibration(files,f.project,marker,async()=>{throw Error('deliberate verification failure');}),/deliberate verification failure/);
  const names=await readdir(join(f.project,'.jevyr'));assert.equal(names.includes('metabolic-calibrations'),false);assert.equal(names.includes('.metabolic-calibration-install.lock'),false);assert.equal(names.filter(n=>n.startsWith('.metabolic-calibration-staging-')).length,1);
  const original=await readFile(join(f.release,'release.json'));
  const result=await publishAppCalibration(files,f.project,marker,async directory=>assert.equal((await readFile(join(directory,'fixture.json'))).toString(),'{"generated":true}'));
  assert.equal(result.snapshotEntries,1);assert.equal(JSON.parse(await readFile(join(result.destination,'installation.json'),'utf8')).protocol,'fixture-only');
  const installed=await readFile(join(result.destination,'installation.json'));
  await assert.rejects(publishAppCalibration(files,f.project,marker,async()=>{}),/APP_CALIBRATION_DESTINATION_EXISTS/);
  assert.deepEqual(await readFile(join(result.destination,'installation.json')),installed);assert.deepEqual(await readFile(join(f.release,'release.json')),original);
});
test('calibration destination mutation is refused before publication',async()=>{
  const f=await fixture(),files=new Map([['fixture.json',Buffer.from('{"generated":true}')]]);
  await assert.rejects(publishAppCalibration(files,f.project,{protocol:'fixture-only'},async directory=>{await writeFile(join(directory,'fixture.json'),'{"substituted":true}');}),/Destination differs from the verified calibration snapshot/);
  assert.equal((await readdir(join(f.project,'.jevyr'))).includes('metabolic-calibrations'),false);
});
test('resource method mismatch and inconsistent measured summaries cannot authorize copy',()=>{
  const method=hash('method'),files=new Map(),reports=[];
  for(const kind of ['Mass','Refraction','Polarity','Fission','Inertia']){const summary={digest:hash(kind),pairedSeeds:64};files.set(`${kind}.json`,Buffer.from(JSON.stringify({kind,implementationDigest:method,digest:summary.digest,summary})));reports.push({kind,digest:summary.digest,summary});}
  files.set('independent-verification.json',Buffer.from(JSON.stringify({protocol:'jevyr.metabolic-experiment-verification/1',valid:true,diagnostic:false,independentlyExecutedTrustedSources:320,reports})));
  const verify=r=>({summary:r.summary,maximumDose:2});assert.equal(validateAppCalibration(files,method,verify).calibrations.length,5);
  assert.throws(()=>validateAppCalibration(files,hash('other method'),verify),/APP_CALIBRATION_METHOD_MISMATCH/);
  const changed=JSON.parse(files.get('Mass.json'));changed.summary.pairedSeeds=65;files.set('Mass.json',Buffer.from(JSON.stringify(changed)));assert.throws(()=>validateAppCalibration(files,method,verify));
});
test('import-only production dependencies resolve without CommonJS export fallbacks',async()=>{
  const f=await fixture(),dependency=join(f.project,'node_modules/import-only-fixture');await mkdir(dependency,{recursive:true});
  await writeFile(join(f.project,'package.json'),'{"name":"fixture-owner","type":"module"}');
  await writeFile(join(dependency,'package.json'),'{"name":"import-only-fixture","type":"module","exports":{".":{"import":"./entry.js"}}}');
  await writeFile(join(dependency,'entry.js'),'export const fixture=true;');
  assert.equal(await sourcePackage(f.project,'import-only-fixture'),dependency);
});
test('ZIP roundtrip preserves Vite tilde names and refuses traversal',()=>{
  const name='apps/chamber/dist/server/_next/static/framework~index-abc.js',bytes=Buffer.from('export const fixture=true;'),zip=releaseZip(new Map([[name,bytes]]));
  assert.equal(zip.readUInt32LE(0),0x04034b50);const length=zip.readUInt16LE(26);assert.equal(zip.subarray(30,30+length).toString(),name);
  assert.deepEqual(inflateRawSync(zip.subarray(30+length,30+length+zip.readUInt32LE(18))),bytes);
  for(const path of ['../escape','a/../escape','/absolute','a\\escape','a//escape'])assert.throws(()=>releaseZip(new Map([[path,bytes]])),/ZIP_PATH/);
});
